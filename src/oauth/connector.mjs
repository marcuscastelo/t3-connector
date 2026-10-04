import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Passkeys } from '../escrita/webauthn.mjs';
import { SessionAuthority } from './session-authority.mjs';
import { TokenStore } from './token-store.mjs';
import { ClientRegistry } from './clients.mjs';
import { LoginTransactions } from './transactions.mjs';
import { authorizationServer, SCOPES } from './authorization-server.mjs';
import { resourceServer } from './resource-server.mjs';
import { controlPlane, enrollmentTicket } from './control-plane.mjs';
import { json, wrap, redact } from './http.mjs';

const ID_FIELDS = ['sid', 'credentialId', 'credential'];
const redactIds = e => Object.fromEntries(ID_FIELDS.filter(k => typeof e[k] === 'string' && !/^[0-9a-f]{8}$/.test(e[k])).map(k => [k, redact(e[k])]));

// `tools({ authority, issuer, stateDir, audit })` returns { sources, grantProvider?, close? }: the
// MCP catalogs behind the resource server and, for writes, the inventory frozen at sign-in.
//
// Composes the OAuth session profile: public listener (AS + MCP RS, meant to sit behind an HTTPS
// ingress) and the local control-plane (loopback only). Independent of the stdio connectors and of
// the passkey lease gate: separate state directory, separate passkeys, separate port.
//
// Persistence: passkeys (public keys), the subject id and the kill switch survive a restart.
// Sessions and tokens live in memory, so a restart ends every session (new sign-in + passkey).
export function createOAuthConnector({ config, tools, serverInfo, fetch, clock, wall, log = line => process.stderr.write(line + '\n') }) {
  const { issuer, publicPort, localPort, stateDir } = config;
  const resource = `${issuer}/mcp`;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const eventsFile = join(stateDir, 'events.jsonl');
  // Identifiers (session ids, credential ids) are written as 8-hex hash prefixes whatever module
  // emitted them; tokens, codes, cookies and handles are never passed to audit at all.
  const audit = e => { const line = JSON.stringify({ t: new Date().toISOString(), ...e, ...redactIds(e) }); try { appendFileSync(eventsFile, line + '\n', { mode: 0o600 }); } catch {} if (config.verbose) log(line); };

  // Passkeys for the RP `localhost` at the control-plane origin; kept apart from the lease gate's.
  const passkeyFile = join(stateDir, 'passkeys.json');
  const stored = existsSync(passkeyFile) ? JSON.parse(readFileSync(passkeyFile, 'utf8')) : { subject: `local:${randomBytes(12).toString('base64url')}`, credentials: [] };
  const credentials = new Map(stored.credentials.map(c => [c.id, { ...c, publicKey: new Uint8Array(Buffer.from(c.publicKey, 'base64url')) }]));
  const persist = next => {
    const tmp = `${passkeyFile}.next`;
    writeFileSync(tmp, JSON.stringify({ subject: stored.subject, credentials: [...next.values()].map(c => ({ ...c, publicKey: Buffer.from(c.publicKey).toString('base64url') })) }), { mode: 0o600 });
    renameSync(tmp, passkeyFile);
  };
  if (!existsSync(passkeyFile)) persist(credentials);
  const localOrigin = `http://localhost:${localPort}`;
  const passkeys = new Passkeys({ origin: localOrigin, rpID: 'localhost', allowLocalhost: true, credentials, rpName: 'T3 Connector (OAuth)', userName: 't3-connector-oauth', saveCredential: async c => { const next = new Map(credentials); next.set(c.id, c); persist(next); } });

  const authority = new SessionAuthority({ idleMs: config.idleSeconds * 1000, maxAgeMs: config.maxAgeSeconds * 1000, clock, wall, audit });
  const killFile = join(stateDir, 'kill-switch');
  if (existsSync(killFile)) authority.kill();
  const killSwitch = {
    on() { writeFileSync(killFile, new Date().toISOString() + '\n', { mode: 0o600 }); return authority.kill(); },
    off() { rmSync(killFile, { force: true }); authority.release(); },
  };
  const tokens = new TokenStore({ authority, atTtlMs: config.accessTokenSeconds * 1000, rtTtlMs: config.refreshTokenSeconds * 1000, clock, wall, audit });
  const clients = new ClientRegistry({ allowedClients: config.clients, fetch, clock, wall, audit });
  const transactions = new LoginTransactions({ clock, wall });
  const enrollment = enrollmentTicket({ clock, wall });

  // Tool catalogs need the authority (writes are authorized by it), so they are built here.
  const catalog = tools({ authority, issuer, stateDir, audit });
  const { sources } = catalog, grantProvider = catalog.grantProvider ?? null;
  const as = authorizationServer({ issuer, resource, localOrigin, loginMode: config.loginMode, authority, tokens, clients, transactions, audit });
  const rs = resourceServer({ issuer, resource, scopes: SCOPES, tokens, authority, sources, serverInfo, allowedOrigins: config.allowedOrigins, audit });
  const local = controlPlane({ port: localPort, issuer, passkeys, subject: stored.subject, authority, tokens, transactions, killSwitch, enrollment, grantProvider, clock, wall, audit });
  const publicHost = new URL(issuer).host;

  async function publicHandler(req, res) {
    // The issuer is configuration; Host and X-Forwarded-* from the internet never define it.
    if (req.headers.host !== publicHost) { audit({ event: 'public_bad_host' }); return json(res, 421, { error: 'misdirected_request' }); }
    const url = new URL(req.url, issuer);
    if (await as(req, res, url)) return;
    if (await rs(req, res, url)) return;
    return json(res, 404, { error: 'not_found' });
  }

  const onError = e => audit({ event: 'handler_error', error: String(e?.message ?? e).slice(0, 120) });
  const servers = [];
  const sweeper = setInterval(() => { authority.sweep(); tokens.sweep(); transactions.sweep(); }, 60_000);
  sweeper.unref();

  return {
    authority, tokens, clients, transactions, passkeys, enrollment, killSwitch, resource, localOrigin, stateDir, subject: stored.subject,
    publicHandler: wrap(publicHandler, onError), localHandler: wrap(local, onError),
    async listen() {
      const listen = (handler, port, host) => new Promise((ok, ko) => { const s = createServer(handler); s.once('error', ko); s.listen(port, host, () => { servers.push(s); ok(s); }); });
      const pub = await listen(this.publicHandler, publicPort, '127.0.0.1');
      const loc = await listen(this.localHandler, localPort, '127.0.0.1');
      await listen(this.localHandler, loc.address().port, '::1').catch(() => {});
      audit({ event: 'started', issuer, resource, localOrigin, credentials: credentials.size, killed: authority.killed });
      return { publicPort: pub.address().port, localPort: loc.address().port };
    },
    async close() { clearInterval(sweeper); await Promise.all(sources.map(src => src.close?.())); catalog.close?.(); await Promise.all(servers.map(s => new Promise(r => { s.closeAllConnections?.(); s.close(() => r()); }))); },
  };
}
