// Local end-to-end proof without ChatGPT: plays the OAuth client (DCR + PKCE), the browser
// (cookie jar by hand) and a software authenticator (UV flag set) against a running harness.
// Usage: STATE_DIR=$(mktemp -d) node harness.mjs & ; node e2e-local.mjs
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { authenticator } from '../../test/escrita-fixtures.mjs';

const PUB = process.env.PUBLIC_BASE ?? 'http://localhost:7534';
const LOCAL = 'http://localhost:7533';
const CB = 'https://client.example.test/callback';
const auth = authenticator({ rpID: 'localhost' });
const step = (n, msg) => console.log(`[${n}] ${msg}`);
const j = r => r.json();
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const local = (path, body) => post(LOCAL + path, body, { Origin: LOCAL });
const admin = (path, body = {}) => post(LOCAL + path, body).then(j);
const form = (body, headers = {}) => fetch(`${PUB}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body) });
const mcp = (at, msg) => fetch(`${PUB}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', ...(at ? { Authorization: `Bearer ${at}` } : {}) }, body: JSON.stringify(msg) });
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } };
const call = (name, args = {}) => ({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } });

// 1. unauthenticated MCP -> 401 with resource_metadata
let r = await mcp(null, init);
assert.equal(r.status, 401);
const www = r.headers.get('www-authenticate');
const prmdUrl = www.match(/resource_metadata="([^"]+)"/)[1];
step(1, `401 WWW-Authenticate -> ${prmdUrl.replace(PUB, '')}`);

// 2. PRMD -> AS metadata
const prmd = await fetch(prmdUrl).then(j);
const meta = await fetch(`${prmd.authorization_servers[0]}/.well-known/oauth-authorization-server`).then(j);
assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
step(2, `PRMD resource=${prmd.resource.replace(PUB, '')} issuer ok, iss param=${meta.authorization_response_iss_parameter_supported}`);

// 3. DCR (public client)
const reg = await post(meta.registration_endpoint, { redirect_uris: [CB], token_endpoint_auth_method: 'none', client_name: 'e2e' }).then(j);
step(3, `registered ${reg.client_id}`);

// 0. enroll the software passkey (once per state dir)
const eo = await local('/api/enroll/options', {}).then(j);
r = await local('/api/enroll/verify', { response: auth.registration(eo.challenge, { origin: LOCAL }) });
step(0, `enroll ${r.status}`);

async function login(mode) {
  await admin('/admin/set', { mode });
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(8).toString('hex');
  const u = new URL(meta.authorization_endpoint);
  Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: CB, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: prmd.resource, scope: 'spike:read spike:write' }).forEach(([k, v]) => u.searchParams.set(k, v));
  r = await fetch(u, { redirect: 'manual' });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  let ref, pub;
  if (mode === '302') { assert.equal(r.status, 302); ref = { handoff: new URL(r.headers.get('location')).hash.split('=')[1] }; }
  else { const html = await r.text(); pub = JSON.parse(html.match(/const t=("[^"]+")/)[1]); ref = mode === 'oob' ? { oob: html.match(/class="big">([0-9A-F]{6})</)[1] } : { handoff: html.match(/#handoff=([\w-]+)/)[1] }; }
  step(`4.${mode}`, `/authorize -> ${r.status}, cookie set, local ref via ${Object.keys(ref)[0]}`);
  const view = await local('/api/view', ref).then(j);
  const opts = await local('/api/login/options', ref).then(j);
  assert.equal(opts.userVerification, 'required');
  const ok = await local('/api/login/verify', { ...ref, response: auth.assertion(opts.challenge, { origin: LOCAL, counter: Date.now() % 1e9 }) }).then(j);
  step(`5.${mode}`, `local UV ok for ${view.client_id}, resume handle issued`);
  let resumeUrl = ok.resume;
  if (pub) {
    // the public page polls /authorize/status bound to its cookie; without the cookie it is refused
    assert.equal((await fetch(`${PUB}/authorize/status?tx=${pub}`)).status, 403);
    const st = await fetch(`${PUB}/authorize/status?tx=${pub}`, { headers: { Cookie: cookie } }).then(j);
    assert.equal(st.resume, resumeUrl);
  }
  // cross-check: resume without the cookie must fail
  assert.equal((await fetch(resumeUrl, { redirect: 'manual' })).status, 400);
  r = await fetch(resumeUrl, { redirect: 'manual', headers: { Cookie: cookie } });
  assert.equal(r.status, 302);
  const cb = new URL(r.headers.get('location'));
  assert.equal(cb.searchParams.get('state'), state);
  assert.equal(cb.searchParams.get('iss'), meta.issuer);
  step(`6.${mode}`, `/resume -> callback with code, state ok, iss ok`);
  const tok = await form({ grant_type: 'authorization_code', code: cb.searchParams.get('code'), code_verifier: verifier, redirect_uri: CB, client_id: reg.client_id, resource: prmd.resource }).then(j);
  assert.ok(tok.access_token && tok.refresh_token);
  step(`7.${mode}`, `/token authorization_code -> AT(${tok.expires_in}s)+RT`);
  return tok;
}

let tok = await login('button');
// 8. MCP with bearer
r = await mcp(tok.access_token, init); assert.equal(r.status, 200);
r = await mcp(tok.access_token, call('spike_now')).then(j);
step(8, `MCP initialize + tools/call -> ${r.result.content[0].text.slice(0, 40)}…`);

// 9. refresh rotation, then reuse of old RT -> invalid_grant and session dead
const t2 = await form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }).then(j);
assert.ok(t2.access_token); step(9, 'refresh rotated');
r = await form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id });
assert.equal((await r.json()).error, 'invalid_grant');
r = await mcp(t2.access_token, call('spike_now'));
assert.equal(r.status, 401); assert.match(r.headers.get('www-authenticate'), /invalid_token/);
step(9, 'old RT reuse -> invalid_grant; family dead -> MCP 401 invalid_token');

// 10. forced invalid_grant on next refresh
tok = await login('302');
await admin('/admin/fail-next-refresh');
r = await form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id });
assert.equal((await r.json()).error, 'invalid_grant');
step(10, 'admin fail-next-refresh -> invalid_grant');

// 11. AT revoked while session alive: 401, then refresh works
tok = await login('oob');
await admin('/admin/revoke-ats');
r = await mcp(tok.access_token, call('spike_now')); assert.equal(r.status, 401);
const t3 = await form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }).then(j);
r = await mcp(t3.access_token, call('spike_echo', { text: 'hi' })).then(j);
step(11, `revoke-ats -> 401; refresh -> ${r.result.content[0].text}`);

console.log('ALL OK');
