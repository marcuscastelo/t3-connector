import { brandOf, DEFAULT_BRAND } from './brand.mjs';
import { issuerParts } from './issuer.mjs';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OAuthPasskeys } from './passkeys.mjs';
import { credentialStorage } from './credential-storage.mjs';
import { PublicEnrollment } from './public-enrollment.mjs';
import { credentialAdmin } from './credential-admin.mjs';
import { publicLogin } from './public-login.mjs';
import { consentService } from './consent.mjs';
import { boundedAudit } from './audit.mjs';
import { SessionAuthority } from './session-authority.mjs';
import { TokenStore } from './token-store.mjs';
import { ClientRegistry } from './clients.mjs';
import { LoginTransactions } from './transactions.mjs';
import { authorizationServer, SCOPES } from './authorization-server.mjs';
import { resourceServer } from './resource-server.mjs';
import { controlPlane, enrollmentTicket } from './control-plane.mjs';
import { json, wrap } from './http.mjs';
import { resourceCapture } from './resource-capture.mjs';

// `tools({ authority, issuer, stateDir, audit })` returns { sources, capabilities?, grantProvider?, close? }: the
// MCP catalogs behind the resource server and, for writes, the policy approved at sign-in.
//
// Composes the OAuth session profile: public listener (AS + MCP RS, meant to sit behind an HTTPS
// ingress) and the local control-plane (loopback only). Independent of the stdio connectors and of
// the passkey lease gate: separate state directory, separate passkeys, separate port.
//
// Persistence: passkeys (public keys), the subject id and the kill switch survive a restart.
// Sessions and tokens live in memory, so a restart ends every session (new sign-in + passkey).
export function createOAuthConnector({ config, tools, serverInfo, fetch, clock, wall, publicLimits, brand, describeAccess, log = line => process.stderr.write(line + '\n') }) {
  const B = brandOf(brand);
  const { issuer, publicPort, localPort, stateDir } = config;
  if (config.loginMode === 'public' && new URL(issuer).protocol !== 'https:') throw new Error('public_login_https_required');
  // A mounted issuer (https://host/fleet) shares its host with other connectors: WebAuthn uses the
  // bare origin, routes live under the mount, and the transaction cookie (Path=/, as __Host-
  // requires) must have a name of its own.
  const parts = issuerParts(issuer);
  if (!parts) throw new Error('issuer_invalid');
  const { origin: publicOrigin, mount } = parts;
  if (mount && B.cookie === DEFAULT_BRAND.cookie) throw new Error('mounted_issuer_requires_brand_cookie');
  // Default: the public listener serves the AS and the MCP resource at <issuer>/mcp. Tunnel mode
  // (config.resource + config.tunnelPort): the public listener serves only the AS, and the resource,
  // named by the tunnel's hosted discovery, is served at /mcp on a loopback listener for the tunnel
  // client. Tokens are bound to that exact resource either way.
  const tunnel = Boolean(config.resource && config.tunnelPort);
  const resource = tunnel ? config.resource : `${issuer}/mcp`;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const audit = boundedAudit({ stateDir, clock, wall, log: config.verbose ? log : null });

  const storage = credentialStorage(stateDir, issuer), credentials = storage.local.credentials;
  const localOrigin = `http://localhost:${localPort}`;
  const passkeys = new OAuthPasskeys({ origin: localOrigin, rpID: 'localhost', allowLocalhost: true, ...storage.local, clock, wall, rpName: `${B.name} (OAuth)`, userName: B.passkeyUser });
  const publicPasskeys = storage.public ? new OAuthPasskeys({ origin: publicOrigin, rpID: new URL(issuer).hostname, ...storage.public, clock, wall, rpName: `${B.name} (public OAuth)`, userName: B.passkeyUser }) : null;

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
  const consent = consentService({ grantProvider, capabilities: catalog.capabilities, idleSeconds: config.idleSeconds, maxAgeSeconds: config.maxAgeSeconds, ...(describeAccess ? { describeAccess } : {}) });
  const publicEnrollment = publicPasskeys ? new PublicEnrollment({ authority, origin: publicOrigin, base: issuer, rpID: publicPasskeys.rpID, subject: storage.subject, clock, wall }) : null;
  authority.onReset(() => { transactions.cancelPublic(); publicEnrollment?.invalidate(); });
  const admin = credentialAdmin({ localKeys: passkeys, publicKeys: publicPasskeys, enrollment: publicEnrollment, authority, transactions, clock, wall });
  const publicFlow = publicPasskeys ? publicLogin({ brand: B, issuer, mode: config.loginMode, passkeys: publicPasskeys, subject: storage.subject, authority, transactions, consent, enrollment: publicEnrollment, clock, wall, audit, limits: publicLimits }) : null;
  const credentialCurrent = approval => {
    const keys = approval.credentialOrigin ? (approval.credentialOrigin === localOrigin ? passkeys : approval.credentialOrigin === publicOrigin ? publicPasskeys : null) : (approval.credentialRp ?? 'localhost') === 'localhost' ? passkeys : publicPasskeys;
    return !!keys?.current(approval.credentialId, approval.credentialGeneration);
  };
  const as = authorizationServer({ brand: B, issuer, resource, localOrigin, loginMode: config.loginMode, authority, tokens, clients, transactions, publicLogin: publicFlow, credentialCurrent, captureRejectedResource: resourceCapture(config.resourceCapture ?? null), audit });
  const rs = resourceServer({ brand: B, issuer, resource, advertisedResource: tunnel ? (config.advertisedResource ?? null) : null, route: tunnel ? '/mcp' : undefined, rootAlias: tunnel || !mount, scopes: SCOPES, tokens, authority, sources, serverInfo, allowedOrigins: config.allowedOrigins, audit });
  const local = controlPlane({ brand: B, port: localPort, issuer, passkeys, subject: storage.subject, authority, tokens, transactions, killSwitch, enrollment, consent, admin, clock, wall, audit });
  const publicHost = new URL(issuer).host;

  async function publicHandler(req, res) {
    // The issuer is configuration; Host and X-Forwarded-* from the internet never define it.
    if (req.headers.host !== publicHost) { audit({ event: 'public_bad_host' }); return json(res, 421, { error: 'misdirected_request' }); }
    const url = new URL(req.url, issuer);
    if (publicFlow && await publicFlow.handle(req, res, url)) return;
    if (await as(req, res, url)) return;
    if (!tunnel && await rs(req, res, url)) return;
    return json(res, 404, { error: 'not_found' });
  }

  // Loopback listener for the tunnel client: MCP resource and its metadata only, never the AS. It
  // binds 127.0.0.1 and accepts only its own loopback Host, so the public ingress cannot reach it.
  const tunnelHosts = tunnel ? new Set([`127.0.0.1:${config.tunnelPort}`, `localhost:${config.tunnelPort}`]) : new Set();
  async function tunnelHandler(req, res) {
    if (!tunnelHosts.has(req.headers.host)) { audit({ event: 'tunnel_bad_host' }); return json(res, 421, { error: 'misdirected_request' }); }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (await rs(req, res, url)) return;
    return json(res, 404, { error: 'not_found' });
  }

  const onError = e => audit({ event: 'handler_error', error: /^[a-z_]{1,64}$/.test(e?.message ?? '') ? e.message : 'unexpected' });
  const servers = [];
  const sweeper = setInterval(() => { authority.sweep(); tokens.sweep(); transactions.sweep(); publicFlow?.sweep(); admin.sweep(); audit.sweep(); }, 60_000);
  sweeper.unref();

  return {
    authority, tokens, clients, transactions, passkeys, publicPasskeys, publicEnrollment, enrollment, killSwitch, resource, localOrigin, stateDir, subject: storage.subject,
    publicHandler: wrap(publicHandler, onError), localHandler: wrap(local, onError), tunnelHandler: tunnel ? wrap(tunnelHandler, onError) : null,
    async listen() {
      const listen = (handler, port, host) => new Promise((ok, ko) => { const s = createServer({ headersTimeout: 5000, requestTimeout: 10_000, connectionsCheckingInterval: 1000 }, handler); s.maxConnections = 64; s.maxRequestsPerSocket = 100; s.keepAliveTimeout = 5000; s.setTimeout(10_000); s.once('error', ko); s.listen(port, host, () => { servers.push(s); ok(s); }); });
      const pub = await listen(this.publicHandler, publicPort, '127.0.0.1');
      const loc = await listen(this.localHandler, localPort, '127.0.0.1');
      await listen(this.localHandler, loc.address().port, '::1').catch(() => {});
      const tun = tunnel ? await listen(this.tunnelHandler, config.tunnelPort, '127.0.0.1') : null;
      audit({ event: 'started', issuer, resource, localOrigin, tunnelPort: tun ? tun.address().port : undefined, credentials: credentials.size, killed: authority.killed });
      return { publicPort: pub.address().port, localPort: loc.address().port, tunnelPort: tun ? tun.address().port : undefined };
    },
    async close() { authority.revokeAll('connector_shutdown'); clearInterval(sweeper); audit.flush(); await Promise.all(sources.map(src => src.close?.())); catalog.close?.(); await Promise.all(servers.map(s => new Promise(r => { s.closeAllConnections?.(); s.close(() => r()); }))); },
  };
}
