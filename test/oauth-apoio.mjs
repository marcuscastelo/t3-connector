import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createOAuthConnector } from '../src/oauth/connector.mjs';
import { rehearsalTools } from '../src/oauth/rehearsal-tools.mjs';
import { perRequestSource } from '../src/oauth/resource-server.mjs';
import { DEFAULTS } from '../src/oauth/config.mjs';
import { authenticator } from './escrita-fixtures.mjs';
import { clientKeys, cimdFetch, CLIENT } from './oauth-fixtures.mjs';

// Test harness for the OAuth session profile: a real connector on ephemeral ports, a fake OAuth
// client (CIMD + private_key_jwt) and a software passkey (UV) for the control-plane.
export const freePort = () => new Promise((ok, ko) => { const s = createServer(); s.once('error', ko); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

export function http(method, url, { headers = {}, body, host } = {}) {
  const u = new URL(url);
  return new Promise((ok, ko) => {
    const req = httpRequest({ host: '127.0.0.1', port: u.port, method, path: u.pathname + u.search, headers: { host: host ?? u.host, ...headers } }, res => {
      const parts = []; res.on('data', c => parts.push(c)); res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let data; try { data = JSON.parse(text); } catch { data = text; }
        ok({ status: res.statusCode, headers: res.headers, text, data });
      });
    });
    req.on('error', ko);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export async function startConnector({ config = {}, loginMode = 'button', tools = () => ({ sources: [perRequestSource(rehearsalTools())] }), enroll = true } = {}) {
  let mono = 0, wallMs = Date.now();
  const clock = () => mono, wall = () => wallMs;
  const [publicPort, localPort] = [await freePort(), await freePort()];
  const keys = clientKeys('ES256');
  const doc = { client_id: CLIENT, client_name: 'Fake client', redirect_uris: ['https://client.example/cb'], token_endpoint_auth_method: 'private_key_jwt', jwks: { keys: [keys.jwk] } };
  const cfg = { ...DEFAULTS, issuer: `http://localhost:${publicPort}`, publicPort, localPort, stateDir: mkdtempSync(join(tmpdir(), 't3c-oauth-')), clients: [CLIENT], loginMode, ...config };
  const connector = createOAuthConnector({ config: cfg, tools, fetch: cimdFetch({ [CLIENT]: doc }), clock, wall, serverInfo: { name: 't3-connector-test', version: '0.0.0' } });
  await connector.listen();
  const issuer = cfg.issuer, local = `http://localhost:${localPort}`;
  const passkey = authenticator({ rpID: 'localhost' });
  const localPost = (path, data, headers = {}) => http('POST', `${local}${path}`, { headers: { origin: local, 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });

  async function enrollPasskey() {
    const ticket = connector.enrollment.issue();
    const o = await localPost('/api/enroll/options', { ticket });
    if (o.status !== 200) throw new Error(`enroll options ${o.status} ${o.text}`);
    const v = await localPost('/api/enroll/verify', { ticket, response: passkey.registration(o.data.challenge, { origin: local }) });
    if (v.status !== 200) throw new Error(`enroll verify ${v.status} ${v.text}`);
  }
  if (enroll) await enrollPasskey();

  let counter = 1;
  const form = obj => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined)).toString();
  const fresh = (claims = {}) => { const now = Math.floor(wall() / 1000); return keys.assertion({ aud: `${issuer}/token`, iat: now, exp: now + 60, ...claims }); };
  const token = (params, { assertion = fresh() } = {}) => http('POST', `${issuer}/token`, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: CLIENT, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion, ...params }),
  });

  // Full first access: /authorize -> local passkey -> /resume -> callback -> /token.
  async function signIn({ via = loginMode === 'oob' ? 'oob' : 'handoff', uv = true } = {}) {
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(8).toString('hex');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const auth = await http('GET', `${issuer}/authorize?${form({ response_type: 'code', client_id: CLIENT, redirect_uri: 'https://client.example/cb', code_challenge: challenge, code_challenge_method: 'S256', state, resource: `${issuer}/mcp`, scope: 'connector:read connector:write' })}`);
    const cookie = auth.headers['set-cookie']?.[0]?.split(';')[0];
    let ref;
    if (via === 'oob') ref = { oob: /class="big">([A-Z0-9]+)</.exec(auth.text)[1] };
    else {
      const loc = auth.status === 302 ? auth.headers.location : /href="([^"]+#handoff=[^"]+)"/.exec(auth.text)[1].replace(/&amp;/g, '&');
      ref = { handoff: new URL(loc).hash.slice('#handoff='.length) };
    }
    const statusId = /const id="([^"]+)"/.exec(auth.text)?.[1];
    const view = await localPost('/api/login/view', ref);
    const opts = await localPost('/api/login/options', ref);
    if (opts.status !== 200) return { auth, view, opts };
    const verify = await localPost('/api/login/verify', { ...ref, response: passkey.assertion(opts.data.challenge, { origin: local, uv, counter: counter++ }) });
    if (verify.status !== 200) return { auth, view, opts, verify };
    const resumeUrl = via === 'oob' ? `${issuer}/resume?tx=${encodeURIComponent(statusId)}` : verify.data.resume;
    const resume = await http('GET', resumeUrl, { headers: cookie ? { cookie } : {} });
    const cb = resume.headers.location ? new URL(resume.headers.location) : null;
    const code = cb?.searchParams.get('code');
    const tokens = code ? await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'https://client.example/cb', resource: `${issuer}/mcp` }) : null;
    return { auth, cookie, view, verify, resume, cb, state, verifier, code, statusId, tokens: tokens?.data, tokenResponse: tokens };
  }

  let rpcId = 1;
  const mcp = (at, method, params = {}, extra = {}) => http('POST', `${issuer}/mcp`, {
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(at ? { authorization: `Bearer ${at}` } : {}), ...extra },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  const callTool = (at, name, args = {}) => mcp(at, 'tools/call', { name, arguments: args });
  const refresh = (rt, extra = {}) => token({ grant_type: 'refresh_token', refresh_token: rt, resource: `${issuer}/mcp`, ...extra });

  return { connector, issuer, local, keys, assertion: fresh, nextCounter: () => counter++, passkey, localPost, signIn, token, refresh, mcp, callTool, enrollPasskey, advance: ms => { mono += ms; wallMs += ms; }, close: () => connector.close() };
}
