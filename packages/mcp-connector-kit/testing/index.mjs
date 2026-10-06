// Test support for connectors built on mcp-connector-kit: a fake OAuth client (CIMD document served
// through an injected fetch, private_key_jwt assertions), a software WebAuthn authenticator, and
// startConnector(), which runs the OAuth session profile on loopback ports and drives the full
// first access (/authorize -> local passkey -> /resume -> /token) and MCP calls over HTTP.
// For tests only: it generates keys and never talks to a real client or authenticator.

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, constants } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOAuthConnector } from '../oauth/connector.mjs';
import { DEFAULTS } from '../oauth/config.mjs';

export const b64 = v => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
export const CLIENT = 'https://client.example/oauth/client.json';

export function clientKeys(kind = 'ES256', kid = 'k1') {
  const pair = kind === 'ES256' ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: kind };
  const assertion = (claims = {}, header = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const h = { alg: kind, kid, typ: 'JWT', ...header };
    const c = { iss: CLIENT, sub: CLIENT, aud: 'https://as.example/token', iat: now, exp: now + 60, jti: randomUUID(), ...claims };
    const input = `${b64(h)}.${b64(c)}`;
    const opts = kind === 'ES256' ? { key: pair.privateKey, dsaEncoding: 'ieee-p1363' } : kind === 'PS256' ? { key: pair.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : pair.privateKey;
    return `${input}.${sign('sha256', Buffer.from(input), opts).toString('base64url')}`;
  };
  return { jwk, assertion };
}

export function cimdFetch(docs) {
  const calls = [];
  const f = async (url, init) => {
    calls.push(url);
    assert.equal(init.redirect, 'error');
    const body = typeof docs === 'function' ? docs(url) : docs[url];
    if (!body) return new Response('no', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  f.calls = calls;
  return f;
}

const raw64 = bytes => Buffer.from(bytes).toString('base64url');

// Minimal CBOR encoder for what an authenticator emits here: maps, text, byte strings and integers.
function cbor(value) {
  const head = (major, n) => n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n])
    : n < 65536 ? Buffer.from([(major << 5) | 25, n >> 8, n & 255]) : Buffer.concat([Buffer.from([(major << 5) | 26]), Buffer.from(new Uint32Array([n]).buffer).reverse()]);
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') { const b = Buffer.from(value); return Buffer.concat([head(3, b.length), b]); }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new Error(`cbor: unsupported ${typeof value}`);
}

/** Software authenticator (ES256, user verification) for `rpID`; `origin` is the default client origin. */
export function authenticator({ rpID, origin: defaultOrigin = `https://${rpID}` } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = publicKey.export({ format: 'jwk' }), credentialId = randomBytes(32);
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))]]);
  const credential = { id: raw64(credentialId), publicKey: new Uint8Array(cbor(cose)), counter: 0, transports: ['internal'] };
  const data = (flags, counter) => { const bytes = Buffer.alloc(37); createHash('sha256').update(rpID).digest().copy(bytes); bytes[32] = flags; bytes.writeUInt32BE(counter, 33); return bytes; };
  const client = (challenge, origin, type, context = {}) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...context }));
  return {
    credential,
    assertion(challenge, { origin = defaultOrigin, uv = true, counter = 1, badSignature = false, up = true, context = {} } = {}) {
      const c = client(challenge, origin, 'webauthn.get', context), auth = data((uv ? 4 : 0) + (up ? 1 : 0), counter), sig = sign('sha256', Buffer.concat([auth, createHash('sha256').update(c).digest()]), privateKey);
      if (badSignature) sig[10] ^= 1;
      return { id: credential.id, rawId: credential.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: raw64(c), authenticatorData: raw64(auth), signature: raw64(sig) } };
    },
    registration(challenge, { origin = defaultOrigin, uv = true, up = true, context = {} } = {}) {
      const length = Buffer.alloc(2); length.writeUInt16BE(credentialId.length);
      const auth = Buffer.concat([data(64 + (uv ? 4 : 0) + (up ? 1 : 0), 0), Buffer.alloc(16), length, credentialId, Buffer.from(credential.publicKey)]);
      return { id: credential.id, rawId: credential.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: raw64(client(challenge, origin, 'webauthn.create', context)), attestationObject: raw64(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(auth)]]))), transports: ['internal'] } };
    },
  };
}

export const freePort = () => new Promise((ok, ko) => { const s = createServer(); s.once('error', ko); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

// Optional wall-clock deadline for every helper call (the composition harness sets it): on expiry
// the request is destroyed and the promise rejects with a `timeout:` error, however much data is
// still trickling in. 0 (default) means no deadline.
let defaultTimeoutMs = 0;
export const setHttpTimeout = ms => { defaultTimeoutMs = ms; };

export function http(method, url, { headers = {}, body, host, timeoutMs = defaultTimeoutMs } = {}) {
  const u = new URL(url);
  let timer;
  return new Promise((ok, ko) => {
    const req = httpRequest({ host: '127.0.0.1', port: u.port, method, path: u.pathname + u.search, headers: { host: host ?? u.host, ...headers } }, res => {
      const parts = []; res.on('data', c => parts.push(c));
      res.on('aborted', () => ko(new Error('response aborted')));
      res.on('error', ko);
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let data; try { data = JSON.parse(text); } catch { data = text; }
        ok({ status: res.statusCode, headers: res.headers, text, data });
      });
    });
    if (timeoutMs) timer = setTimeout(() => req.destroy(new Error(`timeout: ${method} ${u.pathname}`)), timeoutMs);
    req.on('error', ko);
    if (body !== undefined) req.write(body);
    req.end();
  }).finally(() => clearTimeout(timer));
}

/**
 * Runs createOAuthConnector (or `create`, a connector's branded wrapper) on loopback with a fake
 * client and an enrolled software passkey. Returns helpers for sign-in, token, refresh and MCP.
 * `mount` ('/fleet') serves it under a path of the issuer: http://localhost:<port>/fleet. `keys`
 * (from clientKeys()) gives several connectors the same fake client key.
 */
export async function startConnector({ create = createOAuthConnector, tools, config = {}, loginMode = 'button', enroll = true, mount = '', keys: clientKey, serverInfo = { name: 'connector-test', version: '0.0.0' }, ...options } = {}) {
  let mono = 0, wallMs = Date.now();
  const clock = () => mono, wall = () => wallMs;
  const keys = clientKey ?? clientKeys('ES256');
  const doc = { client_id: CLIENT, client_name: 'Fake client', redirect_uris: ['https://client.example/cb'], token_endpoint_auth_method: 'private_key_jwt', jwks: { keys: [keys.jwk] } };
  // freePort() releases the port before the connector binds it, so a parallel test file can take it
  // first. A partial listen leaves bound servers that keep the process alive: close and retry.
  let cfg, connector;
  for (let attempt = 1; ; attempt++) {
    const [publicPort, localPort] = [await freePort(), await freePort()];
    cfg = { ...DEFAULTS, issuer: `http://localhost:${publicPort}${mount}`, publicPort, localPort, stateDir: mkdtempSync(join(tmpdir(), 'connector-oauth-')), clients: [CLIENT], loginMode, ...config };
    connector = create({ config: cfg, tools, fetch: cimdFetch({ [CLIENT]: doc }), clock, wall, serverInfo, ...options });
    try { await connector.listen(); break; } catch (e) {
      await connector.close();
      if (e.code !== 'EADDRINUSE' || attempt === 5) throw e;
    }
  }
  const issuer = cfg.issuer, local = `http://localhost:${cfg.localPort}`;
  // Tunnel mode: tokens are bound to cfg.resource and MCP is served on the loopback tunnel listener.
  const resource = cfg.resource ?? `${issuer}/mcp`;
  const mcpUrl = cfg.tunnelPort ? `http://127.0.0.1:${cfg.tunnelPort}/mcp` : `${issuer}/mcp`;
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
  // tokenResource: resource named at the code exchange (default: the configured one; null omits it).
  async function signIn({ via = loginMode === 'oob' ? 'oob' : 'handoff', uv = true, tokenResource = resource, scope = 'connector:read connector:write' } = {}) {
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(8).toString('hex');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const auth = await http('GET', `${issuer}/authorize?${form({ response_type: 'code', client_id: CLIENT, redirect_uri: 'https://client.example/cb', code_challenge: challenge, code_challenge_method: 'S256', state, resource, scope })}`);
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
    const tokens = code ? await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'https://client.example/cb', resource: tokenResource ?? undefined }) : null;
    return { auth, cookie, view, verify, resume, cb, state, verifier, code, statusId, tokens: tokens?.data, tokenResponse: tokens };
  }

  let rpcId = 1;
  const mcp = (at, method, params = {}, extra = {}) => http('POST', mcpUrl, {
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(at ? { authorization: `Bearer ${at}` } : {}), ...extra },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  const callTool = (at, name, args = {}) => mcp(at, 'tools/call', { name, arguments: args });
  const refresh = (rt, extra = {}) => token({ grant_type: 'refresh_token', refresh_token: rt, resource, ...extra });

  return { connector, issuer, local, resource, mcpUrl, keys, assertion: fresh, nextCounter: () => counter++, passkey, localPost, signIn, token, refresh, mcp, callTool, enrollPasskey, advance: ms => { mono += ms; wallMs += ms; }, close: () => connector.close() };
}
