// Observable public surface of a connector, normalized (ports, nonces, handles, cookies, tickets),
// for the "no mount = 0.2.0" snapshot. The snapshot in fixtures/surface-0.2.0.json was recorded
// with this file at mcp-connector-kit 0.2.0 (t3-connector 34cc095):
//   node -e "import('./test/surface.mjs').then(async m => require('node:fs').writeFileSync('test/fixtures/surface-0.2.0.json', JSON.stringify(await m.surface(), null, 1) + '\n'))"
// (run from packages/mcp-connector-kit). Never re-record it to make a test pass: a difference is a
// behavior change of the unmounted profile.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { jsonResult, strictRegistrar } from '../index.mjs';
import { createOAuthConnector, DEFAULTS, perRequestSource } from '../oauth/index.mjs';
import { authenticator, cimdFetch, clientKeys, CLIENT, freePort, http, startConnector } from '../testing/index.mjs';

export const brand = { name: 'Demo Connector', cookie: 'demo', passkeyUser: 'demo-oauth' };
export const tools = () => ({ sources: [perRequestSource((server) => {
  const register = strictRegistrar(server);
  register('demo_read', { description: 'read', annotations: { readOnlyHint: true }, shape: {} }, async () => jsonResult({ ok: true }));
  register('demo_write', { description: 'write', annotations: { readOnlyHint: false }, shape: { text: z.string() } }, async ({ text }) => jsonResult({ text }));
})] });

const HEADERS = ['content-type', 'content-security-policy', 'cache-control', 'www-authenticate', 'location', 'set-cookie', 'allow', 'retry-after', 'x-frame-options', 'referrer-policy'];
export function normalizer(ports) {
  return (text) => {
    let s = String(text);
    for (const [port, name] of ports) s = s.replaceAll(`localhost:${port}`, `localhost:${name}`).replaceAll(`localhost%3A${port}`, `localhost%3A${name}`);
    return s
      .replace(/nonce-[A-Za-z0-9+/=]+/g, 'nonce-N').replace(/nonce="[^"]+"/g, 'nonce="N"')
      .replace(/const (id|tx)="[^"]+"/g, 'const $1="ID"').replace(/#handoff=[A-Za-z0-9_-]+/g, '#handoff=H')
      .replace(/class="big">[A-Z0-9]+</g, 'class="big">OOB<').replace(/#ticket=[A-Za-z0-9_-]+/g, '#ticket=T')
      .replace(/_(tx|enroll)=[A-Za-z0-9_-]+/g, '_$1=C').replace(/([?&](?:code|state|tx|h)=)[^&"']+/g, '$1X');
  };
}
export function shape(r, norm) {
  const headers = {};
  for (const h of HEADERS) if (r.headers[h] !== undefined) headers[h] = norm(Array.isArray(r.headers[h]) ? r.headers[h].join('\n') : r.headers[h]);
  const body = /javascript/.test(r.headers['content-type'] ?? '') ? `sha256:${createHash('sha256').update(r.text).digest('hex')}` : typeof r.data === 'string' ? norm(r.data) : JSON.parse(norm(JSON.stringify(r.data)));
  return { status: r.status, headers, body };
}

export const PATHS = ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/.well-known/oauth-authorization-server/mcp',
  '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/openid-configuration/mcp', '/mcp/.well-known/openid-configuration',
  '/authorize', '/authorize/status', '/resume', '/token', '/revoke', '/mcp', '/enroll', '/authorize/vendor/swa.js', '/authorize/passkey/options', '/nope', '/'];

// Public listener of a connector with an HTTPS issuer, reached over loopback with the issuer's Host
// (the ingress transport), as the T3 Connector's own public tests do. No TLS involved.
export async function publicHarness({ issuer = 'https://issuer.example.test', loginMode = 'public', config = {}, connectorBrand = brand } = {}) {
  const [publicPort, localPort] = [await freePort(), await freePort()];
  let mono = 0, wallMs = Date.now(), publicCounter = 1, localCounter = 1;
  const clock = () => mono, wall = () => wallMs;
  const stateDir = mkdtempSync(join(tmpdir(), 'kit-public-')), keys = clientKeys();
  const cfg = { ...DEFAULTS, issuer, publicPort, localPort, stateDir, clients: [CLIENT], loginMode, ...config };
  const doc = { client_id: CLIENT, client_name: 'Fake client', redirect_uris: ['https://client.example/cb'], token_endpoint_auth_method: 'private_key_jwt', jwks: { keys: [keys.jwk] } };
  const c = createOAuthConnector({ config: cfg, tools, brand: connectorBrand, fetch: cimdFetch({ [CLIENT]: doc }), clock, wall, serverInfo: { name: 'connector-test', version: '0.0.0' } });
  await c.listen();
  const origin = new URL(issuer).origin, path = new URL(issuer).pathname.replace(/^\/$/, ''), local = `http://localhost:${localPort}`;
  const publicAuth = authenticator({ rpID: new URL(issuer).hostname, origin }), localAuth = authenticator({ rpID: 'localhost' });
  const request = (p, { method = 'GET', headers = {}, body } = {}) => http(method, `http://localhost:${publicPort}${p}`, { host: new URL(issuer).host, headers, body });
  const post = (p, data, cookie, headers = {}) => request(p, { method: 'POST', body: JSON.stringify(data), headers: { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}), ...headers } });
  const localPost = (p, data) => http('POST', `${local}${p}`, { headers: { origin: local, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const cookieOf = r => r.headers['set-cookie']?.[0]?.split(';')[0];
  const form = obj => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined)).toString();
  const token = params => { const now = Math.floor(wallMs / 1000); return request(`${path}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ client_id: CLIENT, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: keys.assertion({ aud: `${issuer}/token`, iat: now, exp: now + 60 }), ...params }) }); };
  const begin = async ({ resource = c.resource, scope = 'connector:read connector:write' } = {}) => {
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(8).toString('hex');
    const page = await request(`${path}/authorize?${form({ response_type: 'code', client_id: CLIENT, redirect_uri: doc.redirect_uris[0], code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource, scope, state })}`);
    return { page, cookie: cookieOf(page), tx: /const (?:tx|id)="([^"]+)"/.exec(page.text)?.[1], verifier, state };
  };
  const resume = async (flow, url) => {
    const u = new URL(url), r = await request(u.pathname + u.search, { headers: { cookie: flow.cookie } });
    const callback = r.headers.location && new URL(r.headers.location), code = callback?.searchParams.get('code');
    const tok = code ? await token({ grant_type: 'authorization_code', code, code_verifier: flow.verifier, redirect_uri: doc.redirect_uris[0], resource: c.resource }) : null;
    return { response: r, callback, token: tok };
  };
  return {
    c, cfg, issuer, origin, path, local, publicPort, localPort, publicAuth, localAuth, request, post, localPost, cookieOf, token, begin, resume,
    async enrollLocal() {
      const ticket = c.enrollment.issue(), o = await localPost('/api/enroll/options', { ticket });
      return localPost('/api/enroll/verify', { ticket, response: localAuth.registration(o.data.challenge, { origin: local }) });
    },
    async enrollPublic() {
      const link = c.publicEnrollment.issue(), ticket = new URL(link).hash.slice('#ticket='.length);
      const page = await request(new URL(link).pathname), cookie = cookieOf(page);
      const o = await post(`${path}/enroll/options`, { ticket }, cookie);
      const v = o.status === 200 ? await post(`${path}/enroll/verify`, { ticket, response: publicAuth.registration(o.data.challenge, { origin }) }, cookie) : null;
      return { link, page, options: o, verify: v };
    },
    async publicSignIn() {
      const flow = await begin();
      const options = await post(`${path}/authorize/passkey/options`, { tx: flow.tx }, flow.cookie);
      const verify = await post(`${path}/authorize/passkey/verify`, { tx: flow.tx, response: publicAuth.assertion(options.data.challenge, { origin, counter: publicCounter++ }) }, flow.cookie);
      const consent = await post(`${path}/authorize/consent`, { tx: flow.tx, accept: true }, flow.cookie);
      return { flow, options, verify, consent, ...(consent.status === 200 ? await resume(flow, consent.data.resume) : {}) };
    },
    async localSignIn() {
      const flow = await begin(), handoff = /#handoff=([A-Za-z0-9_-]+)/.exec(flow.page.text)[1];
      const o = await localPost('/api/login/options', { handoff });
      const v = await localPost('/api/login/verify', { handoff, response: localAuth.assertion(o.data.challenge, { origin: local, counter: localCounter++ }) });
      return { flow, verify: v, ...await resume(flow, v.data.resume) };
    },
    mcp: (at, method = 'tools/list') => request(`${path}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(at ? { authorization: `Bearer ${at}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }) }),
    async close() { await c.close(); rmSync(stateDir, { recursive: true, force: true }); },
  };
}

async function loopbackSurface(loginMode) {
  const c = await startConnector({ create: createOAuthConnector, tools, brand, loginMode });
  try {
    const norm = normalizer([[c.connector.localOrigin.split(':').pop(), 'LOCAL'], [new URL(c.issuer).port, 'PUBLIC']]);
    const out = { routes: {} };
    for (const p of PATHS) {
      out.routes[`GET ${p}`] = shape(await http('GET', `${c.issuer}${p}`), norm);
      out.routes[`POST ${p}`] = shape(await http('POST', `${c.issuer}${p}`, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' }), norm);
    }
    out.unauthorized = shape(await c.mcp(null, 'tools/list'), norm);
    out.invalidToken = shape(await c.mcp('bogus', 'tools/list'), norm);
    const s = await c.signIn();
    out.authorize = shape(s.auth, norm);
    out.resume = shape(s.resume, norm);
    out.token = { status: s.tokenResponse.status, keys: Object.keys(s.tokens).sort(), token_type: s.tokens.token_type, scope: s.tokens.scope, expires_in: s.tokens.expires_in };
    out.tools = (await c.mcp(s.tokens.access_token, 'tools/list')).data.result.tools.map(t => t.name);
    return out;
  } finally { await c.close(); }
}

async function publicSurface() {
  const h = await publicHarness();
  try {
    const norm = normalizer([[h.localPort, 'LOCAL'], [h.publicPort, 'PUBLIC']]);
    const out = { routes: {} };
    for (const p of PATHS) out.routes[`GET ${p}`] = shape(await h.request(p), norm);
    out.authorize = shape((await h.begin()).page, norm);
    await h.enrollLocal();
    const e = await h.enrollPublic();
    out.enrollmentLink = norm(e.link);
    out.enrollPage = shape(e.page, norm);
    out.enrollVerify = e.verify.status;
    const s = await h.publicSignIn();
    out.publicSignIn = { options: s.options.status, verify: s.verify.status, consent: shape(s.consent, norm), resume: shape(s.response, norm), token: s.token.status };
    out.unauthorized = shape(await h.mcp(null), norm);
    return out;
  } finally { await h.close(); }
}

export async function surface() {
  return { button: await loopbackSurface('button'), 302: await loopbackSurface('302'), oob: await loopbackSurface('oob'), public: await publicSurface() };
}
