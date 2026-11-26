import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { ClientRegistry, ASSERTION_TYPE } from '../oauth/clients.mjs';
import { loadOAuthConfig } from '../oauth/index.mjs';
import { CLIENT, cimdFetch, clientKeys, http, startConnector } from '../testing/index.mjs';
import { tools } from './surface.mjs';

// Public CIMD clients (token_endpoint_auth_method "none", PKCE only), accepted only for client ids
// listed in publicClients. Everything else of the profile stays as with private_key_jwt.
const TOKEN = 'https://as.example/token';
const OTHER = 'https://jwt-client.example/oauth/client.json';
const publicDoc = (extra = {}) => ({ client_id: CLIENT, client_name: 'Public client', redirect_uris: ['https://client.example/cb'], token_endpoint_auth_method: 'none', ...extra });
const jwtDoc = (id, keys) => ({ client_id: id, client_name: 'JWT client', redirect_uris: ['https://jwt-client.example/cb'], token_endpoint_auth_method: 'private_key_jwt', jwks: { keys } });
const invalidClient = re => e => e.error === 'invalid_client' && e.status === 401 && re.test(e.message);
const form = obj => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined)).toString();

test('registry: a listed public client with a "none" document authenticates with client_id alone', async () => {
  const audit = [], reg = new ClientRegistry({ allowedClients: [CLIENT], publicClients: [CLIENT], fetch: cimdFetch({ [CLIENT]: publicDoc() }), audit: e => audit.push(e) });
  const c = await reg.authenticate({ client_id: CLIENT }, { audiences: [TOKEN] });
  assert.deepEqual([c.clientId, c.authMethod, c.redirectUris, c.keys], [CLIENT, 'none', ['https://client.example/cb'], []]);
  assert.deepEqual(audit.map(e => [e.event, e.authMethod ?? e.method]), [['client_loaded', 'none'], ['client_authenticated', 'none']]);
});

test('registry: "none" is refused for a client that is not listed as public', async () => {
  const f = cimdFetch({ [CLIENT]: publicDoc() }), reg = new ClientRegistry({ allowedClients: [CLIENT], fetch: f });
  await assert.rejects(reg.resolve(CLIENT), invalidClient(/^cimd_auth_method_unsupported$/));
  // Without an assertion the client is refused before any fetch.
  const g = cimdFetch({ [CLIENT]: publicDoc() }), cold = new ClientRegistry({ allowedClients: [CLIENT], fetch: g });
  await assert.rejects(cold.authenticate({ client_id: CLIENT }, { audiences: [TOKEN] }), invalidClient(/^private_key_jwt_required$/));
  assert.deepEqual(g.calls, []);
});

test('registry: public clients must be allowlisted; unknown methods stay unsupported', async () => {
  assert.throws(() => new ClientRegistry({ allowedClients: [OTHER], publicClients: [CLIENT] }), /public_client_not_allowed/);
  for (const method of ['client_secret_basic', 'client_secret_post', undefined]) {
    const reg = new ClientRegistry({ allowedClients: [CLIENT], publicClients: [CLIENT], fetch: cimdFetch({ [CLIENT]: publicDoc({ token_endpoint_auth_method: method }) }) });
    await assert.rejects(reg.resolve(CLIENT), invalidClient(/^cimd_auth_method_unsupported$/), String(method));
  }
  const reg = new ClientRegistry({ allowedClients: [CLIENT], publicClients: [CLIENT], fetch: cimdFetch({ [CLIENT]: publicDoc({ redirect_uris: ['http://insecure/cb'] }) }) });
  await assert.rejects(reg.resolve(CLIENT), invalidClient(/redirect_uris_missing/));
});

test('registry: no downgrade when the document declares private_key_jwt, even for a listed public client', async () => {
  const k = clientKeys(), reg = new ClientRegistry({ allowedClients: [CLIENT], publicClients: [CLIENT], fetch: cimdFetch({ [CLIENT]: { ...jwtDoc(CLIENT, [k.jwk]), redirect_uris: ['https://client.example/cb'] } }) });
  await assert.rejects(reg.authenticate({ client_id: CLIENT }, { audiences: [TOKEN] }), invalidClient(/^private_key_jwt_required$/));
  const c = await reg.authenticate({ client_id: CLIENT, client_assertion_type: ASSERTION_TYPE, client_assertion: k.assertion() }, { audiences: [TOKEN] });
  assert.equal(c.authMethod, 'private_key_jwt');
});

test('registry: a private_key_jwt client (ChatGPT-like) beside a public one still needs its assertion', async () => {
  const k = jwtKeys(), f = cimdFetch({ [CLIENT]: publicDoc(), [OTHER]: jwtDoc(OTHER, [k.jwk]) });
  const reg = new ClientRegistry({ allowedClients: [CLIENT, OTHER], publicClients: [CLIENT], fetch: f });
  for (const bad of [{ client_id: OTHER }, { client_id: OTHER, client_secret: 'x' }])
    await assert.rejects(reg.authenticate(bad, { audiences: [TOKEN] }), invalidClient(/^private_key_jwt_required$/));
  assert.deepEqual(f.calls, []);
  const c = await reg.authenticate({ client_id: OTHER, client_assertion_type: ASSERTION_TYPE, client_assertion: k.assertion() }, { audiences: [TOKEN] });
  assert.equal(c.clientId, OTHER);
});

test('registry: a public client presenting a secret or an assertion is refused', async () => {
  const k = clientKeys(), reg = new ClientRegistry({ allowedClients: [CLIENT], publicClients: [CLIENT], fetch: cimdFetch({ [CLIENT]: publicDoc({ jwks: { keys: [k.jwk] } }) }) });
  await assert.rejects(reg.authenticate({ client_id: CLIENT, client_secret: 'x' }, { audiences: [TOKEN] }), invalidClient(/^private_key_jwt_required$/));
  // The document's keys are ignored for a public client: an assertion has nothing to verify against.
  await assert.rejects(reg.authenticate({ client_id: CLIENT, client_assertion_type: ASSERTION_TYPE, client_assertion: k.assertion() }, { audiences: [TOKEN] }), invalidClient(/^assertion_not_registered$/));
  await assert.rejects(reg.authenticate({ client_id: 'https://attacker.example/c.json' }, { audiences: [TOKEN] }), invalidClient(/^private_key_jwt_required$/));
});

test('loadOAuthConfig: <prefix>_PUBLIC_CLIENTS must be a subset of <prefix>_CLIENTS', () => {
  const base = { X_ISSUER: 'https://host.example' };
  assert.deepEqual(loadOAuthConfig(base, { prefix: 'X' }).publicClients, []);
  const cfg = loadOAuthConfig({ ...base, X_CLIENTS: `${OTHER},${CLIENT}`, X_PUBLIC_CLIENTS: CLIENT }, { prefix: 'X' });
  assert.deepEqual([cfg.clients, cfg.publicClients], [[OTHER, CLIENT], [CLIENT]]);
  assert.throws(() => loadOAuthConfig({ ...base, X_PUBLIC_CLIENTS: CLIENT }, { prefix: 'X' }), /X_PUBLIC_CLIENTS must be listed in X_CLIENTS too/);
});

test('connector: discovery advertises "none" only when a public client is configured', async (t) => {
  const pub = await startConnector({ tools, authMethod: 'none' }), jwt = await startConnector({ tools });
  t.after(() => Promise.all([pub.close(), jwt.close()]));
  for (const [c, methods] of [[pub, ['private_key_jwt', 'none']], [jwt, ['private_key_jwt']]]) {
    const md = (await http('GET', `${c.issuer}/.well-known/oauth-authorization-server`)).data;
    assert.deepEqual([md.token_endpoint_auth_methods_supported, md.revocation_endpoint_auth_methods_supported, md.code_challenge_methods_supported], [methods, methods, ['S256']]);
  }
});

test('connector: public client signs in with passkey + PKCE, calls tools, refreshes with rotation and revokes', async (t) => {
  const c = await startConnector({ tools, authMethod: 'none' });
  t.after(() => c.close());
  const s = await c.signIn();
  assert.equal(s.tokenResponse.status, 200, s.tokenResponse.text);
  assert.equal(s.cb.searchParams.get('state'), s.state);
  assert.equal(s.cb.searchParams.get('iss'), c.issuer);
  const at = s.tokens.access_token;
  assert.equal((await c.mcp(at, 'tools/list')).status, 200);

  const r1 = await c.refresh(s.tokens.refresh_token);
  assert.equal(r1.status, 200, r1.text);
  // Reusing a consumed refresh token ends the session (and every token of it).
  const reuse = await c.refresh(s.tokens.refresh_token);
  assert.deepEqual([reuse.status, reuse.data.error_description], [400, 'refresh_token_reused']);
  assert.equal((await c.refresh(r1.data.refresh_token)).status, 400);
  assert.equal((await c.mcp(r1.data.access_token, 'tools/list')).status, 401);

  const s2 = await c.signIn();
  const rev = await http('POST', `${c.issuer}/revoke`, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ client_id: CLIENT, token: s2.tokens.refresh_token }) });
  assert.equal(rev.status, 200);
  assert.equal((await c.mcp(s2.tokens.access_token, 'tools/list')).status, 401);
});

test('connector: public client still needs a user-verified passkey', async (t) => {
  const c = await startConnector({ tools, authMethod: 'none' });
  t.after(() => c.close());
  const s = await c.signIn({ uv: false });
  assert.notEqual(s.verify.status, 200);
  assert.equal(s.code, undefined);
});

test('connector: public client code exchange refuses a wrong or missing PKCE verifier and a missing or wrong redirect_uri', async (t) => {
  const c = await startConnector({ tools, authMethod: 'none' });
  t.after(() => c.close());
  const exchange = async params => (await c.token({ grant_type: 'authorization_code', resource: c.resource, ...params })).data;
  const cases = [
    [s => ({ code: s.code, code_verifier: randomBytes(32).toString('base64url'), redirect_uri: 'https://client.example/cb' }), 'invalid_grant', 'pkce_failed'],
    [s => ({ code: s.code, redirect_uri: 'https://client.example/cb' }), 'invalid_grant', 'pkce_failed'],
    [s => ({ code: s.code, code_verifier: s.verifier }), 'invalid_request', 'redirect_uri_required'],
    [s => ({ code: s.code, code_verifier: s.verifier, redirect_uri: 'https://client.example/cb/' }), 'invalid_grant', 'redirect_uri_mismatch'],
  ];
  for (const [params, error, description] of cases) {
    const s = await c.signIn({ exchange: false });
    assert.ok(s.code);
    assert.deepEqual(await exchange(params(s)), { error, error_description: description });
  }
  // A code is single use: after a failed PKCE attempt the right verifier no longer works.
  const s = await c.signIn({ exchange: false });
  await exchange({ code: s.code, code_verifier: randomBytes(32).toString('base64url'), redirect_uri: 'https://client.example/cb' });
  assert.equal((await exchange({ code: s.code, code_verifier: s.verifier, redirect_uri: 'https://client.example/cb' })).error, 'invalid_grant');
});

test('connector: public client /authorize requires S256 PKCE and an exactly registered redirect URI; a resume link works once', async (t) => {
  const c = await startConnector({ tools, authMethod: 'none' });
  t.after(() => c.close());
  const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
  const authorize = extra => http('GET', `${c.issuer}/authorize?${form({ response_type: 'code', client_id: CLIENT, redirect_uri: 'https://client.example/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1', resource: c.resource, ...extra })}`);
  for (const extra of [{ code_challenge: undefined }, { code_challenge_method: 'plain' }, { code_challenge_method: undefined }, { code_challenge: 'short' }]) {
    const r = await authorize(extra);
    assert.equal(r.status, 302, JSON.stringify(extra));
    const cb = new URL(r.headers.location);
    assert.deepEqual([cb.origin + cb.pathname, cb.searchParams.get('error'), cb.searchParams.get('error_description'), cb.searchParams.get('state')], ['https://client.example/cb', 'invalid_request', 'pkce_s256_required', 'st-1']);
  }
  for (const redirect_uri of ['https://client.example/cb/', 'https://client.example/cb?x=1', 'https://attacker.example/cb', undefined]) {
    const r = await authorize({ redirect_uri });
    assert.equal(r.status, 400, String(redirect_uri));
    assert.equal(r.headers.location, undefined);
  }
  // The resume link of an approved sign-in issues one code; opening it again gets none.
  const s = await c.signIn({ exchange: false });
  assert.ok(s.code);
  const replay = await http('GET', s.verify.data.resume, { headers: { cookie: s.cookie } });
  assert.deepEqual([replay.status, replay.headers.location], [400, undefined]);
});

test('connector: a public client that is not explicitly listed is refused at /authorize and /token', async (t) => {
  const c = await startConnector({ tools, authMethod: 'none', config: { publicClients: [] } });
  t.after(() => c.close());
  const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
  const auth = await http('GET', `${c.issuer}/authorize?${form({ response_type: 'code', client_id: CLIENT, redirect_uri: 'https://client.example/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: c.resource })}`);
  assert.deepEqual([auth.status, auth.headers.location], [400, undefined]);
  assert.match(auth.text, /Unknown or invalid client/);
  const tok = await c.token({ grant_type: 'refresh_token', refresh_token: 'x' });
  assert.deepEqual([tok.status, tok.data.error, tok.data.error_description], [401, 'invalid_client', 'private_key_jwt_required']);
});

test('connector: a private_key_jwt client cannot drop its assertion, even when listed as public', async (t) => {
  for (const config of [{}, { publicClients: [CLIENT] }]) {
    const c = await startConnector({ tools, config });
    t.after(() => c.close());
    const s = await c.signIn();
    assert.equal(s.tokenResponse.status, 200, s.tokenResponse.text);
    const noAssertion = await c.token({ grant_type: 'refresh_token', refresh_token: s.tokens.refresh_token, resource: c.resource }, { assertion: null });
    assert.deepEqual([noAssertion.status, noAssertion.data.error_description], [401, 'private_key_jwt_required'], JSON.stringify(config));
    const s2 = await c.signIn({ exchange: false });
    const code = await c.token({ grant_type: 'authorization_code', code: s2.code, code_verifier: s2.verifier, redirect_uri: 'https://client.example/cb', resource: c.resource }, { assertion: null });
    assert.deepEqual([code.status, code.data.error_description], [401, 'private_key_jwt_required']);
    // The refresh token is untouched by the refused attempt.
    assert.equal((await c.refresh(s.tokens.refresh_token)).status, 200);
  }
});

function jwtKeys() {
  // clientKeys() signs as CLIENT; this client needs assertions issued by OTHER.
  const k = clientKeys();
  return { jwk: k.jwk, assertion: (claims = {}) => k.assertion({ iss: OTHER, sub: OTHER, ...claims }) };
}
