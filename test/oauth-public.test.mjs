import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { t3Tools } from '../src/oauth/t3-tools.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { publicFixture } from './oauth-public-fixtures.mjs';
import { http } from './oauth-apoio.mjs';
import { authenticator } from './escrita-fixtures.mjs';
import { loadOAuthConfig } from '../src/oauth/config.mjs';
import { LoginTransactions } from '../src/oauth/transactions.mjs';
import { SessionAuthority } from '../src/oauth/session-authority.mjs';
import { OAuthPasskeys } from '../src/oauth/passkeys.mjs';
import { request as httpRequest } from 'node:http';
import { ClientRegistry } from '../src/oauth/clients.mjs';
import { TokenStore } from '../src/oauth/token-store.mjs';
import { boundedAudit } from '../src/oauth/audit.mjs';
import { Admission } from '../src/oauth/limits.mjs';
import { perRequestSource } from '../src/oauth/resource-server.mjs';
import { rehearsalTools } from '../src/oauth/rehearsal-tools.mjs';
import { consentAll } from '../src/oauth/project-policy.mjs';
import { config as readConfig } from './apoio.mjs';
import { conectarMcp, ambientesFalsos } from './apoio.mjs';
const data = r => JSON.parse(r.data.result.content[0].text);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function headers(r) {
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'.*object-src 'none'/);
  assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.headers['x-frame-options'], 'DENY'); assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['access-control-allow-origin'], undefined);
}

test('public: two independent RPs/storage, UV then explicit consent, exact OAuth callback and PKCE', async t => {
  const f = await publicFixture(t); const originalSubject = f.c.subject;
  assert.equal((await f.request('/enroll')).status, 404);
  const enrolled = await f.enrollPublic(); assert.equal(f.c.passkeys.credentials.size, 1); assert.equal(f.c.publicPasskeys.credentials.size, 1);
  const stored = JSON.parse(readFileSync(`${f.state}/passkeys-public.json`));
  assert.equal(stored.subject, originalSubject); assert.equal(stored.origin, f.issuer); assert.equal(stored.rpID, 'issuer.example.test'); assert.equal(stored.schemaVersion, 1);
  assert.equal(statSync(`${f.state}/passkeys-public.json`).mode & 0o777, 0o600);
  assert.ok(enrolled.issued.data.qr.cells.length); assert.equal((await f.request('/enroll')).status, 404);
  const flow = await f.begin({ headers: { 'sec-fetch-site': 'cross-site' } }); headers(flow.page);
  assert.doesNotMatch(flow.page.text, /localhost|private-project|workspaceRoot/);
  assert.match(flow.page.headers['set-cookie'][0], /^__Host-t3c_tx=.*HttpOnly; Secure; SameSite=Lax; Path=\//);
  assert.doesNotMatch(flow.page.headers['set-cookie'][0], /Domain=/);
  assert.match(flow.page.text, /&lt;img/); assert.doesNotMatch(flow.page.text, /<img src=x/);
  assert.equal((await f.post('/authorize/consent', { tx: flow.tx, accept: true }, flow.cookie)).status, 400);
  const uv = await f.authenticate(flow); assert.equal(uv.verify.status, 200, uv.verify.text); assert.equal(f.c.authority.list().length, 0);
  assert.equal(uv.verify.data.view.clientId, 'https://client.example/oauth/client.json');
  assert.match(uv.verify.data.view.writes.consent, /current and future.*included automatically.*3600 seconds/);
  const login = await f.approve(flow); assert.equal(login.token.status, 200, login.token.text);
  assert.equal(login.callback.searchParams.get('state'), flow.state); assert.equal(login.callback.searchParams.get('iss'), f.issuer);
  const sid = f.c.tokens.resolveAccess(login.token.data.access_token).sid;
  assert.equal(f.c.authority.check(sid).sub, originalSubject); assert.equal(f.c.authority.check(sid).credentialRp, 'issuer.example.test');
  assert.equal((await f.call(login.token.data.access_token, 'rehearsal_now', {})).status, 200);
  assert.equal((await f.request(new URL(login.consent.data.resume).pathname + new URL(login.consent.data.resume).search, { headers: { cookie: flow.cookie } })).status, 400);
});

for (const scope of ['connector:read', 'connector:write']) test(`public: consent for ${scope} shows only requested powers and configured lifetimes`, async t => {
  const f = await publicFixture(t, { config: { idleSeconds: 720, maxAgeSeconds: 3600 } }); await f.enrollPublic();
  const flow = await f.begin({ scope }), uv = await f.authenticate(flow); const text = uv.verify.data.view.writes.consent;
  assert.ok(uv.verify.data.view.writes.environments.every(e => e.actions === (scope === 'connector:write' ? 42 : 0)));
  assert.match(text, /720 seconds.*3600 seconds/); assert.doesNotMatch(text, scope === 'connector:read' ? /Write access/ : /Read access/);
  const s = await f.approve(flow); assert.equal(s.token.data.scope, scope);
  const forbidden = await f.call(s.token.data.access_token, scope === 'connector:read' ? 'rehearsal_note_write' : 'rehearsal_now', scope === 'connector:read' ? { text: 'x' } : {});
  assert.equal(forbidden.data.result.isError, true);
});

for (const origin of [undefined, 'null', 'https://attacker.example', 'https://sibling.example.test']) test(`public: invalid Origin ${origin} refused before work`, async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const flow = await f.begin();
  const r = await f.post('/authorize/passkey/options', { tx: flow.tx }, flow.cookie, { origin });
  assert.equal(r.status, 403); headers(r); assert.equal(f.c.publicPasskeys.pending, 0);
});
for (const site of ['cross-site', 'same-site', 'none']) test(`public: Fetch Site ${site} refused`, async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const flow = await f.begin();
  assert.equal((await f.post('/authorize/passkey/options', { tx: flow.tx }, flow.cookie, { 'sec-fetch-site': site })).status, 403);
});

test('public: mandatory cookie/handle/JSON checks, duplicate cookies and wrong mode; absent Fetch Metadata allowed', async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const a = await f.begin();
  for (const cookie of [undefined, '__Host-t3c_tx=wrong', `${a.cookie}; ${a.cookie}`]) assert.equal((await f.post('/authorize/passkey/options', { tx: a.tx }, cookie)).status, 400);
  assert.equal((await f.post('/authorize/passkey/options', { tx: 'wrong' }, a.cookie)).status, 400);
  assert.equal((await f.post('/authorize/passkey/options', { tx: a.tx }, a.cookie, { 'content-type': 'application/json-evil' })).status, 415);
  assert.equal((await f.post('/authorize/passkey/options', { tx: a.tx }, a.cookie, { 'sec-fetch-site': undefined })).status, 200);
  assert.equal((await f.request('/authorize/passkey/options')).status, 405);
  assert.equal((await f.request('/api/credentials/options')).status, 404);
  await f.reopen({ loginMode: 'button' });
  assert.equal((await f.post('/authorize/passkey/options', { tx: a.tx }, a.cookie)).status, 404);
});

test('public: challenge replacement, single use, purpose/RP/transaction binding and TTL', async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const flow = await f.begin();
  const one = await f.post('/authorize/passkey/options', { tx: flow.tx }, flow.cookie); f.advance(1000);
  const two = await f.post('/authorize/passkey/options', { tx: flow.tx }, flow.cookie);
  const wrong = await f.post('/authorize/passkey/verify', { tx: flow.tx, response: f.publicAssertion(one.data.challenge) }, flow.cookie); assert.equal(wrong.status, 400);
  assert.equal((await f.post('/authorize/passkey/verify', { tx: flow.tx, response: f.publicAssertion(two.data.challenge) }, flow.cookie)).status, 400, 'failed verification consumed the replacement challenge too');
  f.advance(1000); const three = await f.post('/authorize/passkey/options', { tx: flow.tx }, flow.cookie); f.advance(120_000);
  assert.equal((await f.post('/authorize/passkey/verify', { tx: flow.tx, response: f.publicAssertion(three.data.challenge) }, flow.cookie)).status, 400);
  f.advance(181_000); assert.equal((await f.post('/authorize/passkey/options', { tx: flow.tx }, flow.cookie)).status, 400);
});

test('public: wrong-tab cookie cannot authenticate/approve/resume; a new authorize cancels its predecessor', async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const a = await f.begin(), b = await f.begin({ headers: { cookie: a.cookie } });
  assert.equal((await f.post('/authorize/passkey/options', { tx: a.tx }, a.cookie)).status, 400);
  assert.equal((await f.post('/authorize/passkey/options', { tx: b.tx }, a.cookie)).status, 400);
  assert.equal((await f.authenticate(b)).verify.status, 200);
  assert.equal((await f.post('/authorize/consent', { tx: b.tx, accept: true }, a.cookie)).status, 400);
  const ok = await f.post('/authorize/consent', { tx: b.tx, accept: true }, b.cookie);
  assert.equal((await f.resume(a, ok.data.resume)).response.status, 400);
  assert.equal((await f.resume(b, ok.data.resume)).token.status, 200);
});

for (const end of ['kill', 'revoke', 'expiry']) test(`public: ${end} during signature verification prevents consent and sessions`, async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const flow = await f.begin(); const o = await f.post('/authorize/passkey/options', { tx: flow.tx }, flow.cookie);
  const entered = deferred(), hold = deferred(), original = f.c.publicPasskeys.crypto.verify.bind(f.c.publicPasskeys.crypto);
  f.c.publicPasskeys.crypto.verify = async p => { entered.resolve(); await hold.promise; return original(p); };
  const pending = f.post('/authorize/passkey/verify', { tx: flow.tx, response: f.publicAssertion(o.data.challenge) }, flow.cookie); await entered.promise;
  if (end === 'kill') f.c.killSwitch.on(); else if (end === 'revoke') f.c.authority.revokeAll(); else f.advance(300_000);
  hold.resolve(); assert.ok([400, 408].includes((await pending).status)); assert.equal(f.c.authority.list().length, 0);
  assert.equal((await f.post('/authorize/consent', { tx: flow.tx, accept: true }, flow.cookie)).status, 400);
});

for (const end of ['kill', 'revoke', 'expiry']) test(`public: ${end} during private inventory prevents approval and releases no view`, async t => {
  const entered = deferred(), hold = deferred(); let inventories = 0;
  const provider = Object.assign(async () => { inventories++; entered.resolve(); await hold.promise; return { grants: consentAll(readConfig().ambientes), unavailable: [] }; }, { projectPolicy: 'all' });
  const f = await publicFixture(t, { tools: () => ({ sources: [perRequestSource(rehearsalTools())], grantProvider: provider }) }); await f.enrollPublic();
  const flow = await f.begin(); assert.equal(inventories, 0);
  const o = await f.post('/authorize/passkey/options', { tx: flow.tx }, flow.cookie); assert.equal(inventories, 0);
  const pending = f.post('/authorize/passkey/verify', { tx: flow.tx, response: f.publicAssertion(o.data.challenge) }, flow.cookie); await entered.promise;
  if (end === 'kill') f.c.killSwitch.on(); else if (end === 'revoke') f.c.authority.revokeAll(); else f.advance(300_000);
  hold.resolve(); const r = await pending; assert.equal(r.status, 400); assert.equal(r.data.view, undefined); assert.equal(f.c.authority.list().length, 0);
});

test('public: concurrent verification and consent permit exactly one approval/session/code; canceled references fail', async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const flow = await f.begin(), o = await f.post('/authorize/passkey/options', { tx: flow.tx }, flow.cookie);
  const response = f.publicAssertion(o.data.challenge);
  const verifies = await Promise.all([1, 2].map(() => f.post('/authorize/passkey/verify', { tx: flow.tx, response }, flow.cookie)));
  assert.equal(verifies.filter(r => r.status === 200).length, 1);
  const approvals = await Promise.all([1, 2].map(() => f.post('/authorize/consent', { tx: flow.tx, accept: true }, flow.cookie)));
  assert.equal(approvals.filter(r => r.status === 200).length, 1);
  const url = approvals.find(r => r.status === 200).data.resume;
  const resumes = await Promise.all([1, 2].map(() => f.resume(flow, url)));
  assert.equal(resumes.filter(r => r.token?.status === 200).length, 1); assert.equal(f.c.authority.list().length, 1);
  const txs = new LoginTransactions(), { tx } = txs.create({}); txs.cancel(tx); assert.throws(() => txs.approve(tx, {}), /transaction_not_found/);
});

for (const stage of ['authenticated', 'approved']) test(`public: kill then release invalidates ${stage} transaction`, async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const flow = await f.begin(); await f.authenticate(flow);
  let approved; if (stage === 'approved') approved = await f.post('/authorize/consent', { tx: flow.tx, accept: true }, flow.cookie);
  f.c.killSwitch.on(); f.c.killSwitch.off();
  const r = stage === 'approved' ? (await f.resume(flow, approved.data.resume)).response : await f.post('/authorize/consent', { tx: flow.tx, accept: true }, flow.cookie);
  assert.equal(r.status, 400); assert.equal(f.c.authority.list().length, 0);
});

test('public: authenticated consent freshness expires at 120 seconds without silently approving', async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const flow = await f.begin(); await f.authenticate(flow); f.advance(120_000);
  assert.equal((await f.post('/authorize/consent/view', { tx: flow.tx }, flow.cookie)).status, 400);
  assert.equal((await f.post('/authorize/consent', { tx: flow.tx, accept: true }, flow.cookie)).status, 400);
  assert.equal((await f.authenticate(flow)).verify.status, 200); assert.equal((await f.approve(flow)).token.status, 200);
});

test('public: snapshot shown after UV is exactly the approved policy and cannot widen through mutation/refresh', async t => {
  let calls = 0; const offered = { grants: consentAll(readConfig().ambientes), unavailable: [] };
  const provider = Object.assign(async () => { calls++; return offered; }, { projectPolicy: 'all' });
  const f = await publicFixture(t, { tools: () => ({ sources: [perRequestSource(rehearsalTools())], grantProvider: provider }) }); await f.enrollPublic();
  const flow = await f.begin(); assert.equal(calls, 0); const uv = await f.authenticate(flow); assert.equal(calls, 1);
  offered.grants.environments.push({ alias: 'unconsented', environmentId: 'x', destination: 't3://x', actions: [] });
  const s = await f.approve(flow), sid = f.c.tokens.resolveAccess(s.token.data.access_token).sid;
  assert.equal(f.c.authority.check(sid).grants.environments.length, uv.verify.data.view.writes.environments.length);
  const rt = await f.token({ grant_type: 'refresh_token', refresh_token: s.token.data.refresh_token, resource: f.c.resource }); assert.equal(rt.status, 200); assert.equal(calls, 1);
  assert.equal(f.c.authority.check(sid).grants.environments.length, 2);
});

for (const kind of ['foreign-origin', 'bad-signature', 'wrong-challenge', 'wrong-type', 'UV', 'UP', 'crossOrigin', 'topOrigin']) test(`public crypto: ${kind} is rejected`, async () => {
  const auth = authenticator({ rpID: 'issuer.example.test' }), origin = 'https://issuer.example.test', challenge = 'A'.repeat(43);
  const keys = new OAuthPasskeys({ origin, rpID: 'issuer.example.test', credentials: new Map([[auth.credential.id, auth.credential]]), persist() {} });
  const opts = { origin, ...(kind === 'foreign-origin' ? { origin: 'https://foreign.example.test' } : {}), ...(kind === 'bad-signature' ? { badSignature: true } : {}), ...(kind === 'UV' ? { uv: false } : {}), ...(kind === 'UP' ? { up: false } : {}), ...(kind === 'crossOrigin' ? { context: { crossOrigin: true } } : {}), ...(kind === 'topOrigin' ? { context: { topOrigin: origin } } : {}), ...(kind === 'wrong-type' ? { context: { type: 'webauthn.create' } } : {}) };
  await assert.rejects(async () => keys.verify({ response: auth.assertion(kind === 'wrong-challenge' ? 'B'.repeat(43) : challenge, opts), challenge, origin }));
  assert.equal(keys.credentials.get(auth.credential.id).counter, 0);
});
for (const context of [{ crossOrigin: true }, { crossOrigin: 'false' }, { topOrigin: 'https://foreign.example.test' }]) test(`public registration rejects cross-origin context ${JSON.stringify(context)}`, async () => {
  const auth = authenticator({ rpID: 'issuer.example.test' }), keys = new OAuthPasskeys({ origin: 'https://issuer.example.test', rpID: 'issuer.example.test', persist() {} }), challenge = 'A'.repeat(43);
  await assert.rejects(async () => keys.register(auth.registration(challenge, { origin: keys.origin, context }), challenge), /cross_origin_ceremony/); assert.equal(keys.credentials.size, 0);
});

test('public crypto: valid signatures across RPs never substitute; counters serialize and synced zero counters remain valid', async () => {
  const auth = authenticator({ rpID: 'localhost' }), challenge = 'A'.repeat(43);
  const local = new OAuthPasskeys({ origin: 'http://localhost:9999', rpID: 'localhost', allowLocalhost: true, credentials: new Map([[auth.credential.id, auth.credential]]), persist() {} });
  const pub = new OAuthPasskeys({ origin: 'https://issuer.example.test', rpID: 'issuer.example.test', credentials: new Map([[auth.credential.id, auth.credential]]), persist() {} });
  await assert.rejects(pub.verify({ response: auth.assertion(challenge, { origin: local.origin }), challenge, origin: pub.origin }));
  await assert.rejects(pub.verify({ response: auth.assertion(challenge, { origin: pub.origin }), challenge, origin: pub.origin }));
  const pAuth = authenticator({ rpID: 'issuer.example.test' }); local.credentials.set(pAuth.credential.id, pAuth.credential);
  await assert.rejects(local.verify({ response: pAuth.assertion(challenge, { origin: local.origin }), challenge, origin: local.origin }));
  await local.verify({ response: auth.assertion(challenge, { origin: local.origin, counter: 0 }), challenge, origin: local.origin });
  await local.verify({ response: auth.assertion('B'.repeat(43), { origin: local.origin, counter: 0 }), challenge: 'B'.repeat(43), origin: local.origin });
  await local.verify({ response: auth.assertion(challenge, { origin: local.origin, counter: 2 }), challenge, origin: local.origin });
  await assert.rejects(local.verify({ response: auth.assertion(challenge, { origin: local.origin, counter: 2 }), challenge, origin: local.origin }));
});

test('public enrollment: requires action-bound local UV; release/public proof and proof replay cannot issue capability', async t => {
  const f = await publicFixture(t);
  assert.equal((await f.localPost('/api/credentials/verify', { handle: 'unknown', response: {} })).status, 400);
  const o = await f.localPost('/api/credentials/options', { action: 'enroll-public' });
  const wrong = await f.localPost('/api/credentials/verify', { handle: o.data.handle, response: f.publicAuth.assertion(o.data.options.challenge, { origin: f.issuer }) }); assert.equal(wrong.status, 400);
  assert.equal(f.c.publicEnrollment.active, false);
  assert.equal((await f.localPost('/api/credentials/verify', { handle: o.data.handle, response: f.localAssertion(o.data.options.challenge) })).status, 400);
  const release = await f.localPost('/api/release/options');
  const proof = await f.localPost('/api/credentials/options', { action: 'enroll-public' });
  assert.equal((await f.localPost('/api/credentials/verify', { handle: proof.data.handle, response: f.localAssertion(release.data.challenge) })).status, 400);
  const uv = await f.localPost('/api/credentials/options', { action: 'enroll-public' });
  assert.equal((await f.localPost('/api/credentials/verify', { handle: uv.data.handle, response: f.localAuth.assertion(uv.data.options.challenge, { origin: f.local, uv: false }) })).status, 400);
  assert.equal(f.c.publicEnrollment.active, false);
});

test('public enrollment: all routes 404 while disabled, GET does not enroll and public cannot reach local handlers', async t => {
  const f = await publicFixture(t);
  for (const path of ['/enroll', '/enroll/options', '/enroll/verify']) {
    assert.equal((await f.request(path)).status, 404);
    assert.equal((await f.post(path, {}, undefined, { origin: 'null', 'content-type': 'text/plain' })).status, 404);
  }
  const e = await f.beginEnrollment(); assert.equal(e.page.status, 200); assert.equal(f.c.publicPasskeys.credentials.size, 0);
  assert.equal((await f.request(`/enroll?ticket=${e.ticket}`)).status, 404);
  for (const p of ['/api/enroll/options', '/api/enroll/verify', '/api/credentials/options', '/api/kill']) assert.equal((await f.post(p, {}, e.cookie)).status, 404);
  assert.equal((await f.request('/authorize/vendor/swa.js')).status, 200); assert.doesNotMatch(e.page.text, /localhost/); headers(e.page);
});

test('public enrollment: ticket has 128 bits and single-browser atomic claim; invalid guesses do not consume it', async t => {
  const f = await publicFixture(t); const e = await f.beginEnrollment(); assert.equal(Buffer.from(e.ticket, 'base64url').length, 16);
  assert.equal((await f.post('/enroll/options', { ticket: 'A'.repeat(22) }, e.cookie)).status, 400); assert.equal(f.c.publicEnrollment.active, true);
  const other = await f.request('/enroll'), cookie2 = f.cookieOf(other);
  const attempts = await Promise.all([e.cookie, cookie2].map(cookie => f.post('/enroll/options', { ticket: e.ticket }, cookie)));
  assert.equal(attempts.filter(x => x.status === 200).length, 1); const winner = attempts[0].status === 200 ? e.cookie : cookie2, loser = winner === e.cookie ? cookie2 : e.cookie, o = attempts.find(x => x.status === 200);
  const response = f.publicAuth.registration(o.data.challenge, { origin: f.issuer });
  assert.equal((await f.post('/enroll/verify', { ticket: e.ticket, response }, loser)).status, 400);
  assert.equal((await f.post('/enroll/verify', { ticket: e.ticket, response }, winner)).status, 200);
  assert.equal((await f.post('/enroll/verify', { ticket: e.ticket, response }, winner)).status, 404); assert.equal(f.c.publicPasskeys.credentials.size, 1);
});

for (const end of ['replacement', 'kill', 'revoke', 'expiry', 'restart']) test(`public enrollment: ${end} invalidates capability and routes`, async t => {
  const f = await publicFixture(t); const e = await f.beginEnrollment(); let newer;
  if (end === 'replacement') newer = await f.beginEnrollment();
  if (end === 'kill') f.c.killSwitch.on();
  if (end === 'revoke') f.c.authority.revokeAll();
  if (end === 'expiry') f.advance(900_000);
  if (end === 'restart') await f.reopen();
  const r = await f.post('/enroll/options', { ticket: e.ticket }, e.cookie);
  assert.equal(r.status, end === 'replacement' ? 400 : 404);
  if (newer) assert.equal((await f.post('/enroll/options', { ticket: newer.ticket }, newer.cookie)).status, 200);
});

for (const end of ['replacement', 'kill', 'revoke', 'expiry']) test(`public enrollment: ${end} during crypto cannot commit or consume a replacement`, async t => {
  const f = await publicFixture(t); const e = await f.beginEnrollment(), o = await f.post('/enroll/options', { ticket: e.ticket }, e.cookie);
  const entered = deferred(), hold = deferred(), register = f.c.publicPasskeys.crypto.register.bind(f.c.publicPasskeys.crypto);
  f.c.publicPasskeys.crypto.register = async (...args) => { entered.resolve(); await hold.promise; return register(...args); };
  const pending = f.post('/enroll/verify', { ticket: e.ticket, response: f.publicAuth.registration(o.data.challenge, { origin: f.issuer }) }, e.cookie); await entered.promise;
  let newer; if (end === 'replacement') newer = await f.beginEnrollment(); if (end === 'kill') f.c.killSwitch.on(); if (end === 'revoke') f.c.authority.revokeAll(); if (end === 'expiry') f.advance(900_000);
  hold.resolve(); assert.ok([400, 408].includes((await pending).status));
  assert.equal(f.c.publicPasskeys.credentials.size, 0); assert.equal(JSON.parse(readFileSync(`${f.state}/passkeys-public.json`)).credentials.length, 0);
  if (newer) assert.equal((await f.post('/enroll/options', { ticket: newer.ticket }, newer.cookie)).status, 200);
});

test('public enrollment: simultaneous verifies commit one key; challenge expires at 120 seconds', async t => {
  const f = await publicFixture(t); const e = await f.beginEnrollment(), o = await f.post('/enroll/options', { ticket: e.ticket }, e.cookie), response = f.publicAuth.registration(o.data.challenge, { origin: f.issuer });
  const results = await Promise.all([1, 2].map(() => f.post('/enroll/verify', { ticket: e.ticket, response }, e.cookie)));
  assert.equal(results.filter(r => r.status === 200).length, 1); assert.equal(f.c.publicPasskeys.credentials.size, 1);
  const n = await f.beginEnrollment(), no = await f.post('/enroll/options', { ticket: n.ticket }, n.cookie); f.advance(120_000);
  assert.equal((await f.post('/enroll/verify', { ticket: n.ticket, response: authenticator({ rpID: 'issuer.example.test' }).registration(no.data.challenge, { origin: f.issuer }) }, n.cookie)).status, 400);
});

for (const stage of ['authenticated', 'approved']) test(`public removal: ends selected-key sessions and ${stage} pending approval, preserving local key`, async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const logged = await f.signIn(); const pending = await f.begin(); await f.authenticate(pending);
  let approved; if (stage === 'approved') approved = await f.post('/authorize/consent', { tx: pending.tx, accept: true }, pending.cookie);
  const removed = await f.admin('remove', { rp: 'public', credentialId: f.publicAuth.credential.id }); assert.equal(removed.status, 200, removed.text);
  assert.equal(f.c.publicPasskeys.credentials.size, 0); assert.equal(f.c.passkeys.credentials.size, 1); assert.ok(f.c.passkeys.credentials.has(f.localAuth.credential.id));
  assert.equal((await f.mcp(logged.token.data.access_token, 'tools/list')).status, 401);
  assert.equal((await f.token({ grant_type: 'refresh_token', refresh_token: logged.token.data.refresh_token, resource: f.c.resource })).status, 400);
  const r = stage === 'approved' ? (await f.resume(pending, approved.data.resume)).response : await f.post('/authorize/consent', { tx: pending.tx, accept: true }, pending.cookie);
  assert.equal(r.status, 400);
  assert.equal((await f.localPost('/api/credentials/options', { action: 'remove', rp: 'local', credentialId: f.localAuth.credential.id })).status, 400, 'last local admin key is preserved');
});

test('public removal: in-flight counter persistence cannot recreate the key', async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const flow = await f.begin(), o = await f.post('/authorize/passkey/options', { tx: flow.tx }, flow.cookie);
  const entered = deferred(), hold = deferred(), verify = f.c.publicPasskeys.crypto.verify.bind(f.c.publicPasskeys.crypto);
  f.c.publicPasskeys.crypto.verify = async p => { entered.resolve(); await hold.promise; return verify(p); };
  const pending = f.post('/authorize/passkey/verify', { tx: flow.tx, response: f.publicAssertion(o.data.challenge) }, flow.cookie); await entered.promise;
  const removing = f.admin('remove', { rp: 'public', credentialId: f.publicAuth.credential.id });
  // Wait on the actual invalidation event rather than timing the HTTP requests.
  const cancelled = deferred(), cancel = f.c.transactions.cancelCredential.bind(f.c.transactions);
  f.c.transactions.cancelCredential = (...args) => { cancel(...args); cancelled.resolve(); };
  await cancelled.promise; hold.resolve(); assert.equal((await pending).status, 400); assert.equal((await removing).status, 200);
  assert.equal(f.c.publicPasskeys.credentials.size, 0); assert.equal(JSON.parse(readFileSync(`${f.state}/passkeys-public.json`)).credentials.length, 0);
});

test('public removal: action-bound local proof only; selected key removal leaves other RP/key sessions alive', async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const first = await f.signIn();
  const secondKey = authenticator({ rpID: 'issuer.example.test' }); await f.enrollPublic(secondKey);
  const flow = await f.begin(); const o = await f.post('/authorize/passkey/options', { tx: flow.tx }, flow.cookie);
  assert.equal((await f.post('/authorize/passkey/verify', { tx: flow.tx, response: secondKey.assertion(o.data.challenge, { origin: f.issuer }) }, flow.cookie)).status, 200); const second = await f.approve(flow);
  const proof = await f.localPost('/api/credentials/options', { action: 'list' });
  assert.equal((await f.localPost('/api/credentials/verify', { handle: proof.data.handle, action: 'remove', rp: 'public', credentialId: secondKey.credential.id, response: f.localAssertion(proof.data.options.challenge) })).status, 400);
  assert.equal((await f.admin('remove', { rp: 'public', credentialId: f.publicAuth.credential.id })).status, 200);
  assert.equal((await f.mcp(first.token.data.access_token, 'tools/list')).status, 401); assert.equal((await f.mcp(second.token.data.access_token, 'tools/list')).status, 200);
});

test('public: restart preserves two credential sets/canonical subject, ends sessions and tickets, and additional enrollment retains keys', async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const s = await f.signIn(), subject = f.c.subject;
  const key = authenticator({ rpID: 'issuer.example.test' }); await f.enrollPublic(key); const ticket = await f.beginEnrollment();
  await f.reopen(); assert.equal(f.c.subject, subject); assert.equal(f.c.publicPasskeys.credentials.size, 2); assert.equal(f.c.passkeys.credentials.size, 1);
  assert.equal((await f.mcp(s.token.data.access_token, 'tools/list')).status, 401); assert.equal((await f.post('/enroll/options', { ticket: ticket.ticket }, ticket.cookie)).status, 404);
  assert.equal((await f.signIn()).token.status, 200);
});
for (const damage of ['origin', 'rpID', 'subject', 'JSON', 'publicKey', 'transports']) test(`public storage: corrupt ${damage} fails closed without replacing local keys`, async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const file = `${f.state}/passkeys-public.json`, before = readFileSync(`${f.state}/passkeys.json`, 'utf8'), stored = JSON.parse(readFileSync(file));
  if (damage === 'JSON') writeFileSync(file, '{'); else { if (damage === 'publicKey') stored.credentials[0].publicKey = 'AAAA'; else if (damage === 'transports') stored.credentials[0].transports = ['foreign']; else stored[damage] = 'wrong'; writeFileSync(file, JSON.stringify(stored)); }
  await assert.rejects(f.reopen(), /storage/); assert.equal(readFileSync(`${f.state}/passkeys.json`, 'utf8'), before);
});

test('public all: one session reads/writes new projects on both hosts and preserves non-OAuth ACLs', async t => {
  const f = await publicFixture(t, { backend: true }); await f.enrollPublic(); const s = await f.signIn(), at = s.token.data.access_token;
  for (const c of f.connections) {
    const env = c.registro.alias, id = f.addProject(env);
    assert.ok(data(await f.call(at, 't3_projetos', { environment: env })).projects.some(p => p.projectId === id));
    assert.equal(data(await f.call(at, 't3_mensagens', { environment: env, threadId: `t-${id}` })).messages[0].text, `message-${id}`);
    const input = { threadId: `t-${id}`, text: 'hi', clientRequestId: `late-${env}`, delivery: 'start_immediately' };
    assert.equal(data(await f.call(at, 't3_escrever_thread_send', { environment: env, operationId: `late-${env}`, input })).state, 'completed'); assert.equal(c.calls.length, 1);
    const reads = (await import('./apoio.mjs')).ambientesFalsos(f.data), legacy = await conectarMcp(reads);
    assert.equal((await legacy.callTool({ name: 't3_thread', arguments: { environment: env, threadId: `t-${id}` } })).isError, true); await legacy.close();
  }
  assert.equal((await f.call(at, 't3_projetos', { environment: 'unconfigured' })).data.result.isError, true);
});

test('public/local logins share canonical subject, operation dedupe and reconciliation across RP/mode restart', async t => {
  const f = await publicFixture(t, { backend: true, config: { loginMode: 'button' } }); await f.enrollPublic();
  const local = await f.localSignIn(), id = f.addProject('local'), args = { environment: 'local', operationId: 'shared-op', input: { threadId: `t-${id}`, text: 'hi', clientRequestId: 'shared-op', delivery: 'start_immediately' } };
  const sid = f.c.tokens.resolveAccess(local.token.data.access_token).sid, subject = f.c.authority.check(sid).sub;
  assert.equal(data(await f.call(local.token.data.access_token, 't3_escrever_thread_send', args)).state, 'completed');
  await f.reopen({ loginMode: 'public' }); const pub = await f.signIn(), pubSid = f.c.tokens.resolveAccess(pub.token.data.access_token).sid;
  assert.equal(f.c.authority.check(pubSid).sub, subject); assert.equal(data(await f.call(pub.token.data.access_token, 't3_escrever_thread_send', args)).state, 'completed');
  assert.equal(f.connections[0].calls.length, 1);
  assert.equal(data(await f.call(pub.token.data.access_token, 't3_reconciliar_escrita', { environment: 'local', operationId: 'shared-op' })).state, 'completed');
});

test('public restricted: no private inventory before UV; failed inventory grants no write environment', async t => {
  let calls = 0; const provider = async () => { calls++; throw new Error('offline'); };
  const f = await publicFixture(t, { tools: () => ({ sources: [perRequestSource(rehearsalTools())], grantProvider: provider }) }); await f.enrollPublic();
  const flow = await f.begin(); assert.equal(calls, 0); const uv = await f.authenticate(flow); assert.equal(calls, 1); assert.deepEqual(uv.verify.data.view.writes.environments, []); assert.deepEqual(uv.verify.data.view.writes.unavailable, [{ reason: 'inventory_failed' }]);
  const s = await f.approve(flow), sid = f.c.tokens.resolveAccess(s.token.data.access_token).sid; assert.equal(f.c.authority.check(sid).grants, null);
});

test('public: five failed submitted assertions end the tx; replacement cannot reset failures/options budget', async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const flow = await f.begin();
  for (let i = 0; i < 5; i++) {
    if (i) f.advance(1000);
    const o = await f.post('/authorize/passkey/options', { tx: flow.tx }, flow.cookie); assert.equal(o.status, 200);
    assert.equal((await f.post('/authorize/passkey/verify', { tx: flow.tx, response: f.publicAssertion(o.data.challenge, { badSignature: true }) }, flow.cookie)).status, 400);
  }
  assert.equal(f.c.transactions.size, 0);
  const fresh = await f.begin(); assert.equal((await f.authenticate(fresh)).verify.status, 200);
});

test('public: options issuance and rate budgets are bounded, expire, and do not permanently lock the subject', async t => {
  const f = await publicFixture(t, { limits: { authorize: { burst: 2, perMinute: 2 } } }); await f.enrollPublic();
  const a = await f.begin(); const fast = await f.post('/authorize/passkey/options', { tx: a.tx }, a.cookie); assert.equal(fast.status, 200);
  assert.equal((await f.post('/authorize/passkey/options', { tx: a.tx }, a.cookie)).status, 429);
  for (let i = 0; i < 4; i++) { f.advance(1000); assert.equal((await f.post('/authorize/passkey/options', { tx: a.tx }, a.cookie)).status, 200); }
  f.advance(1000); assert.equal((await f.post('/authorize/passkey/options', { tx: a.tx }, a.cookie)).status, 429); assert.equal(f.c.transactions.size, 0);
  assert.equal((await f.begin()).page.status, 200); const rejected = (await f.begin()).page; assert.equal(rejected.status, 429); assert.equal(rejected.headers['retry-after'], '1'); headers(rejected);
  f.advance(60_000); assert.equal((await f.begin()).page.status, 200);
});

test('public: transaction capacity and source-budget maps are bounded without evicting approved work', () => {
  const txs = new LoginTransactions({ maxSize: 2 }), a = txs.create({}).tx; txs.approve(a, {}); txs.create({}); assert.throws(() => txs.create({}), /transaction_capacity/); assert.equal(txs.size, 2);
  const admission = new Admission({ maxEntries: 2, burst: 1 }); admission.take('a'); admission.take('b'); assert.throws(() => admission.take('c'), /rate_capacity/); assert.equal(admission.size, 2);
});

test('public: serialized verification queue has a fixed bound, times out and recovers without late writes', async () => {
  const auth = authenticator({ rpID: 'issuer.example.test' }), origin = 'https://issuer.example.test', hold = deferred(), entered = deferred(); let saves = 0;
  const keys = new OAuthPasskeys({ origin, rpID: 'issuer.example.test', credentials: new Map([[auth.credential.id, auth.credential]]), persist() { saves++; }, deadlineMs: 20, maxPending: 2 });
  const finished = deferred();
  const verify = keys.crypto.verify.bind(keys.crypto); keys.crypto.verify = async p => { entered.resolve(); await hold.promise; try { return await verify(p); } finally { finished.resolve(); } };
  const a = keys.verify({ response: auth.assertion('A'.repeat(43), { origin }), challenge: 'A'.repeat(43), origin }); a.catch(() => {}); await entered.promise;
  const b = keys.verify({ response: auth.assertion('B'.repeat(43), { origin, counter: 2 }), challenge: 'B'.repeat(43), origin }); b.catch(() => {});
  await assert.rejects(keys.verify({ response: auth.assertion('C'.repeat(43), { origin, counter: 3 }), challenge: 'C'.repeat(43), origin }), /verification_overload/);
  await assert.rejects(a, /verification_timeout/); await assert.rejects(b, /verification_timeout/); hold.resolve(); await finished.promise; await new Promise(setImmediate);
  assert.equal(saves, 0); assert.equal(keys.pending, 0);
  keys.crypto.verify = verify; keys.deadlineMs = 1000;
  assert.equal(await keys.verify({ response: auth.assertion('D'.repeat(43), { origin, counter: 1 }), challenge: 'D'.repeat(43), origin }), auth.credential.id); assert.equal(saves, 1);
});

test('public: oversized/malformed/deep requests and foreign CORS preflight cause no verification work', async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const flow = await f.begin();
  assert.equal((await f.request('/authorize/passkey/options', { method: 'OPTIONS', headers: { origin: 'https://attacker.test' } })).status, 405);
  for (const body of ['{', 'null', '[1]', JSON.stringify({ tx: flow.tx, extra: {} })]) assert.equal((await f.request('/authorize/passkey/options', { method: 'POST', headers: { origin: f.issuer, 'content-type': 'application/json', cookie: flow.cookie }, body })).status, 400);
  const deep = { tx: flow.tx, response: { a: { b: { c: { d: { e: { f: {} } } } } } } };
  assert.equal((await f.post('/authorize/passkey/verify', deep, flow.cookie)).status, 400);
  const oversized = await f.request('/authorize/passkey/options', { method: 'POST', headers: { origin: f.issuer, 'content-type': 'application/json', cookie: flow.cookie }, body: ' '.repeat(65 * 1024) }); assert.equal(oversized.status, 413); headers(oversized); assert.equal(f.c.publicPasskeys.pending, 0);
});

test('public: app admission rejects verification concurrency before body parsing and recovers', async t => {
  const f = await publicFixture(t, { limits: { worker: { concurrency: 1 } } }); await f.enrollPublic(); const flow = await f.begin(), o = await f.post('/authorize/passkey/options', { tx: flow.tx }, flow.cookie);
  const hold = deferred(), entered = deferred(), verify = f.c.publicPasskeys.crypto.verify.bind(f.c.publicPasskeys.crypto);
  f.c.publicPasskeys.crypto.verify = async p => { entered.resolve(); await hold.promise; return verify(p); };
  const pending = f.post('/authorize/passkey/verify', { tx: flow.tx, response: f.publicAssertion(o.data.challenge) }, flow.cookie); await entered.promise;
  const rejected = await f.request('/authorize/passkey/options', { method: 'POST', headers: { origin: f.issuer, 'content-type': 'application/json', cookie: flow.cookie }, body: '{' }); assert.equal(rejected.status, 429);
  hold.resolve(); assert.equal((await pending).status, 200); assert.equal((await f.approve(flow)).token.status, 200);
});

test('public: no tickets/assertions/cookies/handles/codes/tokens appear in bounded application audit', async t => {
  const f = await publicFixture(t); const enrolled = await f.enrollPublic(), s = await f.signIn();
  const audit = readFileSync(`${f.state}/events.jsonl`, 'utf8');
  for (const secret of [enrolled.ticket, enrolled.cookie.split('=')[1], s.flow.cookie.split('=')[1], s.flow.tx, s.flow.verifier, s.token.data.access_token, s.token.data.refresh_token, s.callback.searchParams.get('code'), new URL(s.consent.data.resume).searchParams.get('h')]) assert.ok(!audit.includes(secret));
  assert.doesNotMatch(audit, /clientDataJSON|attestationObject|authenticatorData|signature/);
  writeFileSync(`${f.state}/events.jsonl`, 'x'.repeat(1024 * 1024)); await f.request('/.well-known/oauth-authorization-server');
  assert.ok(statSync(`${f.state}/events.jsonl.1`).size <= 1024 * 1024 + 2048); assert.ok(statSync(`${f.state}/events.jsonl`).size < 2048);
});

test('public config: explicit HTTPS only, existing login modes remain available', () => {
  assert.equal(loadOAuthConfig({ T3_CONNECTOR_OAUTH_ISSUER: 'https://issuer.example.test' }).loginMode, 'public');
  assert.equal(loadOAuthConfig({ T3_CONNECTOR_OAUTH_ISSUER: 'http://localhost:10000' }).loginMode, 'button');
  assert.equal(loadOAuthConfig({ T3_CONNECTOR_OAUTH_ISSUER: 'https://issuer.example.test', T3_CONNECTOR_OAUTH_LOGIN_MODE: 'public' }).loginMode, 'public');
  assert.throws(() => loadOAuthConfig({ T3_CONNECTOR_OAUTH_ISSUER: 'http://localhost:10000', T3_CONNECTOR_OAUTH_LOGIN_MODE: 'public' }), /https issuer/);
  for (const mode of ['button', '302', 'oob']) assert.equal(loadOAuthConfig({ T3_CONNECTOR_OAUTH_ISSUER: 'http://localhost:10000', T3_CONNECTOR_OAUTH_LOGIN_MODE: mode }).loginMode, mode);
});

test('public: slow request body hits the finite deadline and the next operator request works', async t => {
  const f = await publicFixture(t); await f.enrollPublic();
  const r = await new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: f.cfg.publicPort, path: '/authorize/passkey/options', method: 'POST', headers: { host: new URL(f.issuer).host, origin: f.issuer, 'content-type': 'application/json', 'content-length': '100' } }, res => {
      let text = ''; res.on('data', c => { text += c; }); res.on('end', () => { resolve({ status: res.statusCode, text }); req.destroy(); });
    }); req.on('error', reject); req.write('{');
  });
  assert.equal(r.status, 408); assert.equal(JSON.parse(r.text).error, 'request_timeout');
  assert.equal((await f.signIn()).token.status, 200);
});

test('public: failed CIMD loads coalesce, have bounded concurrency and recover without caching failure', async () => {
  const keys = (await import('./oauth-fixtures.mjs')).clientKeys();
  const ids = Array.from({ length: 5 }, (_, i) => `https://client${i}.example.test/metadata.json`), pending = new Map(); let calls = 0;
  let healthy = false;
  const registry = new ClientRegistry({ allowedClients: ids, fetch: async url => {
    calls++;
    if (!healthy) { const gate = deferred(); pending.set(url, gate); await gate.promise; throw new Error('secret untrusted error'); }
    return Response.json({ client_id: url, redirect_uris: ['https://client.example/cb'], token_endpoint_auth_method: 'private_key_jwt', jwks: { keys: [keys.jwk] } });
  } });
  const loads = [...ids.slice(0, 4), ids[0]].map(id => registry.resolve(id)); loads.forEach(p => p.catch(() => {}));
  assert.equal(calls, 4);
  await assert.rejects(registry.resolve(ids[4]), e => e.status === 429);
  for (const p of pending.values()) p.resolve();
  assert.ok((await Promise.allSettled(loads)).every(r => r.status === 'rejected' && r.reason.message === 'cimd_fetch_failed'));
  healthy = true; assert.equal((await registry.resolve(ids[0])).clientId, ids[0]); assert.equal(calls, 5);
});

for (const change of ['kill', 'revoke', 'expiry']) test(`public admin: ${change} during local UV cannot issue a capability`, async t => {
  const f = await publicFixture(t), o = await f.localPost('/api/credentials/options', { action: 'enroll-public' });
  const entered = deferred(), hold = deferred(), verify = f.c.passkeys.crypto.verify.bind(f.c.passkeys.crypto);
  f.c.passkeys.crypto.verify = async p => { entered.resolve(); await hold.promise; return verify(p); };
  const pending = f.localPost('/api/credentials/verify', { handle: o.data.handle, response: f.localAssertion(o.data.options.challenge) }); await entered.promise;
  if (change === 'kill') { f.c.authority.kill(); f.c.authority.release(); }
  else if (change === 'revoke') f.c.authority.revokeAll(); else f.advance(120_000);
  hold.resolve(); assert.equal((await pending).status, change === 'expiry' ? 408 : 400); assert.equal(f.c.publicEnrollment.active, false); assert.equal((await f.request('/enroll')).status, 404);
});

test('public enrollment: legitimate failures and options are finite; a new locally authorized generation recovers', async t => {
  const f = await publicFixture(t), e = await f.beginEnrollment();
  for (let i = 0; i < 5; i++) {
    if (i) f.advance(1000);
    const o = await f.post('/enroll/options', { ticket: e.ticket }, e.cookie); assert.equal(o.status, 200);
    const response = f.publicAuth.registration(o.data.challenge, { origin: f.issuer, context: { crossOrigin: true } });
    assert.equal((await f.post('/enroll/verify', { ticket: e.ticket, response }, e.cookie)).status, 400);
  }
  assert.equal((await f.request('/enroll')).status, 404); assert.equal(f.c.publicPasskeys.credentials.size, 0);
  await f.enrollPublic(); assert.equal((await f.signIn()).token.status, 200);
});

test('public all: unavailable host shown after UV recovers in the same policy; mismatched identity and old policy versions fail', async t => {
  const f = await publicFixture(t, { backend: true }); await f.enrollPublic();
  const descriptor = f.data.remoto.descritor; f.data.remoto.descritor = { ...descriptor, environmentId: 'foreign-host' };
  const s = await f.signIn(), at = s.token.data.access_token;
  assert.deepEqual(s.uv.verify.data.view.writes.unavailable.map(e => [e.alias, e.reason]), [['remoto', 'environment_unavailable']]);
  assert.equal((await f.call(at, 't3_projetos', { environment: 'remoto' })).data.result.isError, true); assert.equal(f.connections[1].calls.length, 0);
  f.data.remoto.descritor = descriptor; const id = f.addProject('remoto');
  assert.ok(data(await f.call(at, 't3_projetos', { environment: 'remoto' })).projects.some(p => p.projectId === id));
  assert.equal(data(await f.call(at, 't3_escrever_thread_send', { environment: 'remoto', operationId: 'recovered', input: { threadId: `t-${id}`, text: 'hi', clientRequestId: 'recovered', delivery: 'start_immediately' } })).state, 'completed');
  const principal = f.c.tokens.resolveAccess(at), old = { ...principal.grants, scopeVersion: 2 };
  const sid = f.c.authority.create({ ...principal, grants: old });
  const code = f.c.tokens.issueCode({ sid, clientId: principal.clientId, redirectUri: 'https://client.example/cb', codeChallenge: 'unused', resource: f.c.resource, scope: principal.scope });
  const token = f.c.tokens.consumeCode(code, { clientId: principal.clientId, verifyPkce: () => true });
  assert.equal((await f.call(token.access_token, 't3_projetos', { environment: 'local' })).data.result.isError, true);
  assert.equal((await f.call(token.access_token, 't3_escrever_thread_send', { environment: 'remoto', operationId: 'old-policy', input: { threadId: `t-${id}`, text: 'hi', clientRequestId: 'old-policy', delivery: 'start_immediately' } })).data.result.isError, true);
  assert.equal(f.connections[1].calls.length, 1);
});

test('public: origin/RP namespaces prevent colliding credential IDs from revoking the local key', () => {
  const authority = new SessionAuthority(), txs = new LoginTransactions(), base = { sub: 'canonical', clientId: 'client', credentialId: 'same-id', credentialRp: 'localhost', scope: 'connector:read', resource: 'https://localhost/mcp' };
  const local = authority.create({ ...base, credentialOrigin: 'http://localhost:1234' }), pub = authority.create({ ...base, credentialOrigin: 'https://localhost' });
  const tx = txs.create({ mode: 'public', epoch: authority.epoch }).tx; tx.authenticated = { ...base, credentialOrigin: 'https://localhost' };
  const other = txs.create({ mode: 'button' }).tx; txs.approve(other, { ...base, credentialOrigin: 'http://localhost:1234' });
  assert.equal(authority.revokeCredential('localhost', 'same-id', 'https://localhost'), 1); txs.cancelCredential('localhost', 'same-id', 'https://localhost');
  assert.equal(authority.check(local).credentialId, 'same-id'); assert.throws(() => authority.check(pub), /credential_removed/); assert.equal(txs.size, 1); assert.throws(() => txs.approve(tx, base), /transaction_not_found/);
});

test('public: session and token capacity never evicts a live family or drops reuse tombstones', () => {
  const authority = new SessionAuthority({ maxSessions: 1 }), base = { sub: 's', clientId: 'c', credentialId: 'key', scope: 'connector:read', resource: 'https://issuer/mcp' };
  const sid = authority.create(base); assert.throws(() => authority.create(base), /session_capacity/); assert.equal(authority.check(sid).sub, 's');
  const tokens = new TokenStore({ authority, maxFamilyRecords: 6 }), c = tokens.issueCode({ sid, ...base, redirectUri: 'https://client/cb', codeChallenge: 'c' });
  const first = tokens.consumeCode(c, { clientId: 'c', verifyPkce: () => true }), next = tokens.refresh(first.refresh_token, { clientId: 'c' });
  assert.throws(() => tokens.refresh(next.refresh_token, { clientId: 'c' }), /token_capacity/); assert.throws(() => tokens.resolveAccess(next.access_token), /token_unknown/);
  assert.deepEqual(tokens.counts(), { codes: 0, access: 0, refresh: 0 }); assert.ok(authority.create(base));
});

test('public: repeated rejection audit aggregates within a bounded time window', async t => {
  const f = await publicFixture(t); let now = 0; const logged = [];
  const audit = boundedAudit({ stateDir: f.state, clock: () => now, wall: () => now, log: line => logged.push(JSON.parse(line)) });
  for (let i = 0; i < 50; i++) audit({ event: 'public_ceremony_rejected', reason: 'bad_json' });
  assert.equal(logged.length, 1); now = 60_000; audit.sweep();
  assert.equal(logged.length, 2); assert.equal(logged[1].repeated, 49);
  audit({ event: 'public_ceremony_rejected', reason: 'bad_json' }); assert.equal(logged.length, 3); audit.flush();
});

test('public: registration, counters and deletion serialize without losing keys; credential cap is finite', async () => {
  const origin = 'https://issuer.example.test', rpID = 'issuer.example.test', original = authenticator({ rpID }), a = authenticator({ rpID }), b = authenticator({ rpID });
  let stored = new Map([[original.credential.id, original.credential]]);
  const keys = new OAuthPasskeys({ origin, rpID, credentials: new Map(stored), persist(next) { stored = new Map(next); } });
  await Promise.all([
    keys.register(a.registration('A'.repeat(43), { origin }), 'A'.repeat(43)),
    keys.verify({ response: original.assertion('B'.repeat(43), { origin, counter: 1 }), challenge: 'B'.repeat(43), origin }),
    keys.register(b.registration('C'.repeat(43), { origin }), 'C'.repeat(43)),
  ]);
  assert.equal(stored.size, 3); assert.equal(stored.get(original.credential.id).counter, 1);
  await keys.remove(a.credential.id); assert.equal(stored.size, 2); assert.ok(stored.has(b.credential.id)); assert.ok(stored.has(original.credential.id));
  const full = new Map(Array.from({ length: 31 }, (_, i) => { const key = authenticator({ rpID }).credential; return [key.id, key]; }));
  const capacity = new OAuthPasskeys({ origin, rpID, credentials: full, persist() {} });
  await capacity.register(a.registration('D'.repeat(43), { origin }), 'D'.repeat(43)); assert.equal(full.size, 32);
  assert.throws(() => capacity.registrationOptions('E'.repeat(43), new Uint8Array([1])), /credential_capacity/);
  await assert.rejects(capacity.register(b.registration('E'.repeat(43), { origin }), 'E'.repeat(43)), /credential_capacity/); assert.equal(full.size, 32);
});

test('public enrollment: graceful shutdown/restart during crypto cannot persist an old generation', async t => {
  const f = await publicFixture(t), e = await f.beginEnrollment(), o = await f.post('/enroll/options', { ticket: e.ticket }, e.cookie);
  const old = f.c, entered = deferred(), hold = deferred(), settled = deferred(), register = old.publicPasskeys.crypto.register.bind(old.publicPasskeys.crypto);
  old.publicPasskeys.crypto.register = async (...args) => { entered.resolve(); await hold.promise; try { return await register(...args); } finally { settled.resolve(); } };
  const pending = f.post('/enroll/verify', { ticket: e.ticket, response: f.publicAuth.registration(o.data.challenge, { origin: f.issuer }) }, e.cookie).catch(() => ({ status: 0 })); await entered.promise;
  await f.reopen(); const newer = await f.beginEnrollment();
  hold.resolve(); await settled.promise; assert.notEqual((await pending).status, 200);
  assert.equal(old.publicPasskeys.credentials.size, 0); assert.equal(JSON.parse(readFileSync(`${f.state}/passkeys-public.json`)).credentials.length, 0);
  assert.equal((await f.post('/enroll/options', { ticket: newer.ticket }, newer.cookie)).status, 200);
});

// Execute only the delivered page's inline script against a small DOM and the real HTTP
// ceremony endpoints/software authenticator. This checks displayed rows, without a browser.
async function renderPublicConsent(f, flow) {
  const elements = new Map(), element = () => ({ textContent: '', children: [], hidden: false, disabled: false, append(...items) { this.children.push(...items); } });
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element };
  const scripts = [...flow.page.text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(Boolean);
  for (const script of scripts) runInNewContext(script, { document, location: { replace() {} }, SimpleWebAuthnBrowser: { startAuthentication: async ({ optionsJSON }) => f.publicAssertion(optionsJSON.challenge) }, fetch: async (path, options) => {
    const response = await f.request(path, { method: options.method, headers: { ...options.headers, origin: f.issuer, cookie: flow.cookie }, body: options.body });
    return { ok: response.status === 200, status: response.status, json: async () => response.data };
  } });
  await elements.get('authenticate').onclick();
  assert.match(elements.get('status').textContent, /Review the access above/);
  return elements.get('consent').children.map(e => e.textContent).join('\n');
}

for (const choice of [
  { scope: 'connector:read', writes: true },
  { scope: 'connector:write', writes: true },
  { scope: 'connector:read connector:write', writes: false },
  { scope: 'connector:write', writes: false },
]) test(`public rendered consent: ${choice.scope}, write catalog ${choice.writes}`, async t => {
  const tools = choice.writes ? undefined : t3Tools({ ambientes: ambientesFalsos(), projectPolicy: 'all' });
  const f = await publicFixture(t, { backend: true, tools, config: { idleSeconds: 60, maxAgeSeconds: 300 } });
  for (const connection of f.connections) connection.registro.acoes = ['thread.send'];
  await f.enrollPublic(); const flow = await f.begin({ scope: choice.scope });
  assert.equal(f.c.authority.list().length, 0); const text = await renderPublicConsent(f, flow);
  assert.match(text, /60 seconds without.*300 seconds/s); assert.doesNotMatch(text, /one hour|42 actions/);
  if (choice.scope.includes('connector:read')) assert.match(text, /Read access/); else assert.doesNotMatch(text, /Read access/);
  if (choice.writes && choice.scope.includes('connector:write')) { assert.match(text, /Write access/); assert.match(text, /1 actions, full-access/); }
  else { assert.doesNotMatch(text, /Write access|actions, full-access/); if (!choice.writes) assert.match(text, /offers no write tools/); }
  assert.equal(f.c.authority.list().length, 0); // Display still does not approve.
  const login = await f.approve(flow); assert.equal(login.token.status, 200); assert.equal(login.token.data.scope, choice.scope);
});

for (const choice of [
  { scope: 'connector:read', writes: true },
  { scope: 'connector:write', writes: true },
  { scope: 'connector:read connector:write', writes: false },
  { scope: 'connector:write', writes: false },
]) test(`desktop rendered consent: ${choice.scope}, write catalog ${choice.writes}`, async t => {
  const tools = choice.writes ? undefined : t3Tools({ ambientes: ambientesFalsos(), projectPolicy: 'all' });
  const f = await publicFixture(t, { backend: true, tools, config: { loginMode: 'button', idleSeconds: 60, maxAgeSeconds: 300 } });
  for (const connection of f.connections) connection.registro.acoes = ['thread.send'];
  const flow = await f.begin({ scope: choice.scope }), handoff = /#handoff=([A-Za-z0-9_-]+)/.exec(flow.page.text)?.[1]; assert.ok(handoff);
  const page = await http('GET', `${f.local}/login`); assert.equal(page.status, 200);
  const elements = new Map(), element = () => ({ textContent: '', children: [], hidden: false, append(...items) { this.children.push(...items); } });
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element };
  const script = [...page.text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(Boolean).join('\n');
  await runInNewContext(`${script}\nshow(${JSON.stringify({ handoff })})`, { document, URLSearchParams, location: { hash: '', pathname: '/login' }, history: { replaceState() {} }, window: { isSecureContext: true, PublicKeyCredential: {} }, fetch: async (path, options) => {
    const response = await f.localPost(path, JSON.parse(options.body));
    return { ok: response.status === 200, status: response.status, json: async () => response.data };
  } });
  const text = elements.get('view').children.map(e => e.textContent).join('\n');
  assert.match(text, /60 seconds without.*300 seconds/s); assert.doesNotMatch(text, /one hour|42 actions/);
  if (choice.scope.includes('connector:read')) assert.match(text, /Read access/); else assert.doesNotMatch(text, /Read access/);
  if (choice.writes && choice.scope.includes('connector:write')) { assert.match(text, /Write access/); assert.match(text, /1 actions, full-access/); }
  else { assert.doesNotMatch(text, /Write access|actions, full-access/); if (!choice.writes) assert.match(text, /offers no write tools/); }
  assert.equal(f.c.authority.list().length, 0); assert.equal(elements.get('approve').hidden, false);
});
