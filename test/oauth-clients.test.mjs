import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientRegistry, ASSERTION_TYPE } from '../src/oauth/clients.mjs';
import { CLIENT, clientKeys, cimdFetch, b64 } from './oauth-fixtures.mjs';

const TOKEN = 'https://as.example/token';

const doc = (keys, extra = {}) => ({ client_id: CLIENT, client_name: 'Test client', redirect_uris: ['https://client.example/cb'], token_endpoint_auth_method: 'private_key_jwt', jwks: { keys }, ...extra });
const form = assertion => ({ client_assertion_type: ASSERTION_TYPE, client_assertion: assertion, client_id: CLIENT });

for (const kind of ['ES256', 'RS256', 'PS256']) {
  test(`private_key_jwt ${kind} verifies against the CIMD JWKS`, async () => {
    const k = clientKeys(kind), reg = new ClientRegistry({ allowedClients: [CLIENT], fetch: cimdFetch({ [CLIENT]: doc([k.jwk]) }) });
    const c = await reg.authenticate(form(k.assertion()), { audiences: [TOKEN] });
    assert.equal(c.clientId, CLIENT);
    assert.deepEqual(c.redirectUris, ['https://client.example/cb']);
  });
}

test('signature from another key, tampered payload or alg mismatch is refused', async () => {
  const good = clientKeys(), evil = clientKeys(), reg = new ClientRegistry({ allowedClients: [CLIENT], fetch: cimdFetch({ [CLIENT]: doc([good.jwk]) }) });
  await assert.rejects(reg.authenticate(form(evil.assertion()), { audiences: [TOKEN] }), /assertion_signature_invalid/);
  const [h, , s] = good.assertion().split('.');
  const forged = `${h}.${b64({ iss: CLIENT, sub: CLIENT, aud: TOKEN, exp: Math.floor(Date.now() / 1000) + 60, jti: 'x' })}.${s}`;
  await assert.rejects(reg.authenticate(form(forged), { audiences: [TOKEN] }), /assertion_signature_invalid/);
  await assert.rejects(reg.authenticate(form(good.assertion({}, { alg: 'none' })), { audiences: [TOKEN] }), /alg_unsupported/);
  await assert.rejects(reg.authenticate(form(good.assertion({}, { alg: 'HS256' })), { audiences: [TOKEN] }), /alg_unsupported/);
});

test('claims: aud, exp, lifetime, iat, sub, jti and replay', async () => {
  const k = clientKeys(), reg = new ClientRegistry({ allowedClients: [CLIENT], fetch: cimdFetch({ [CLIENT]: doc([k.jwk]) }) });
  const now = Math.floor(Date.now() / 1000);
  for (const [claims, re] of [
    [{ aud: 'https://other/token' }, /audience_invalid/],
    [{ exp: now - 120 }, /assertion_expired/],
    [{ exp: now + 3600 }, /lifetime_too_long/],
    [{ iat: now + 120, exp: now + 180 }, /issued_in_future/],
    [{ sub: 'https://other' }, /sub_mismatch/],
    [{ jti: undefined }, /jti_missing/],
  ]) await assert.rejects(reg.authenticate(form(k.assertion(claims)), { audiences: [TOKEN] }), re);
  const a = k.assertion();
  await reg.authenticate(form(a), { audiences: [TOKEN] });
  await assert.rejects(reg.authenticate(form(a), { audiences: [TOKEN] }), /assertion_replayed/);
  await reg.authenticate(form(k.assertion({ aud: ['https://as.example', TOKEN] })), { audiences: [TOKEN] });
});

test('no private_key_jwt means invalid_client (no downgrade to none or secrets)', async () => {
  const reg = new ClientRegistry({ allowedClients: [CLIENT], fetch: cimdFetch({}) });
  for (const f of [{ client_id: CLIENT }, { client_id: CLIENT, client_secret: 'x' }, { client_assertion_type: 'other', client_assertion: 'a.b.c' }])
    await assert.rejects(reg.authenticate(f, { audiences: [TOKEN] }), e => e.error === 'invalid_client' && /private_key_jwt_required/.test(e.message));
});

test('only allowlisted client ids are fetched', async () => {
  const f = cimdFetch({}), reg = new ClientRegistry({ allowedClients: [CLIENT], fetch: f });
  await assert.rejects(reg.resolve('https://attacker.example/client.json'), /client_not_allowed/);
  await assert.rejects(reg.resolve('http://169.254.169.254/'), /client_not_allowed/);
  assert.deepEqual(f.calls, []);
  assert.throws(() => new ClientRegistry({ allowedClients: ['http://client.example/c.json'] }), /invalid_client_id/);
});

test('CIMD document must match client_id, declare private_key_jwt and carry keys', async () => {
  const k = clientKeys();
  for (const [d, re] of [[doc([k.jwk], { client_id: 'https://other' }), /client_id_mismatch/], [doc([k.jwk], { token_endpoint_auth_method: 'none' }), /auth_method_unsupported/], [doc([]), /jwks_missing/], [doc([k.jwk], { redirect_uris: ['http://insecure/cb'] }), /redirect_uris_missing/]]) {
    const reg = new ClientRegistry({ allowedClients: [CLIENT], fetch: cimdFetch({ [CLIENT]: d }) });
    await assert.rejects(reg.resolve(CLIENT), re);
  }
});

test('jwks_uri is supported and an unknown kid triggers one refetch (key rotation)', async () => {
  const old = clientKeys('ES256', 'old'), rotated = clientKeys('ES256', 'new');
  let keys = [old.jwk];
  const f = cimdFetch(url => url === CLIENT ? doc(undefined, { jwks: undefined, jwks_uri: 'https://client.example/jwks' }) : { keys });
  const reg = new ClientRegistry({ allowedClients: [CLIENT], fetch: f });
  await reg.authenticate(form(old.assertion()), { audiences: [TOKEN] });
  keys = [rotated.jwk];
  await reg.authenticate(form(rotated.assertion()), { audiences: [TOKEN] });
  assert.equal(f.calls.filter(u => u === 'https://client.example/jwks').length, 2);
});

// Regressions from the independent review (REVISAO-CODEX.md F5, P1).
test('assertion lifetime is bounded from iat; malformed time claims are refused', async () => {
  const k = clientKeys(), reg = new ClientRegistry({ allowedClients: [CLIENT], fetch: cimdFetch({ [CLIENT]: doc([k.jwk]) }) });
  const now = Math.floor(Date.now() / 1000);
  for (const [claims, re] of [
    [{ iat: now - 86400, exp: now + 60 }, /lifetime_too_long/],
    [{ iat: now + 30, exp: now + 20 }, /lifetime_too_long/],
    [{ iat: 'yesterday' }, /time_claims_invalid/],
    [{ nbf: 'soon' }, /time_claims_invalid/],
    [{ exp: String(now + 60) }, /time_claims_invalid/],
  ]) await assert.rejects(reg.authenticate(form(k.assertion(claims)), { audiences: [TOKEN] }), re);
  await reg.authenticate(form(k.assertion({ iat: undefined })), { audiences: [TOKEN] });
});

test('client metadata larger than 64 KiB is refused while streaming, and by Content-Length', async () => {
  const big = { client_id: CLIENT, pad: 'x'.repeat(70 * 1024) };
  let pulled = 0;
  const streaming = async () => new Response(new ReadableStream({ pull(c) { pulled++; if (pulled > 100) return c.close(); c.enqueue(new TextEncoder().encode(JSON.stringify(big).slice(0, 8192))); } }));
  await assert.rejects(new ClientRegistry({ allowedClients: [CLIENT], fetch: streaming }).resolve(CLIENT), /document_too_large/);
  assert.ok(pulled < 20, 'stopped reading at the limit');
  const declared = async () => new Response('{}', { headers: { 'content-length': String(1024 * 1024) } });
  await assert.rejects(new ClientRegistry({ allowedClients: [CLIENT], fetch: declared }).resolve(CLIENT), /document_too_large/);
});

test('a rejected response body is cancelled (oversized Content-Length, error status)', async () => {
  for (const init of [{ headers: { 'content-length': String(1024 * 1024) } }, { status: 500 }]) {
    let cancelled = false;
    const body = new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } });
    await assert.rejects(new ClientRegistry({ allowedClients: [CLIENT], fetch: async () => new Response(body, init) }).resolve(CLIENT), /document_too_large|fetch_status_500/);
    assert.equal(cancelled, true);
  }
  const k = clientKeys(), small = doc([k.jwk], { client_name: 'Ünïcode ✓' });
  const c = await new ClientRegistry({ allowedClients: [CLIENT], fetch: cimdFetch({ [CLIENT]: small }) }).resolve(CLIENT);
  assert.equal(c.name, 'Ünïcode ✓');
});
