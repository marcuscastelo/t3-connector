import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { publicFixture } from './oauth-public-fixtures.mjs';
import { authenticator } from './escrita-fixtures.mjs';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

const storedPublic = f => JSON.parse(readFileSync(`${f.state}/passkeys-public.json`));
const publicRemoval = f => f.admin('remove', { rp: 'public', credentialId: f.publicAuth.credential.id });
async function blockedPublicAssertion(f) {
  const flow = await f.begin(), options = await f.post('/authorize/passkey/options', { tx: flow.tx }, flow.cookie);
  assert.equal(options.status, 200, options.text);
  const keys = f.c.publicPasskeys, entered = deferred(), hold = deferred(), verify = keys.crypto.verify.bind(keys.crypto);
  keys.crypto.verify = async p => { entered.resolve(); await hold.promise; return verify(p); };
  const pending = f.post('/authorize/passkey/verify', { tx: flow.tx, response: f.publicAssertion(options.data.challenge) }, flow.cookie);
  await entered.promise;
  return { pending, release() { keys.crypto.verify = verify; hold.resolve(); } };
}

test('public removal HTTP: queue rejection has no revocation transition; fresh local UV can retry', async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const logged = await f.signIn(), id = f.publicAuth.credential.id;
  const keys = f.c.publicPasskeys; keys.maxPending = 1;
  const blocked = await blockedPublicAssertion(f);
  const rejected = await publicRemoval(f); assert.equal(rejected.status, 429, rejected.text);
  assert.equal(rejected.data.error, 'verification_overload'); assert.equal(keys.current(id), true);
  assert.equal(keys.deletionState(id), null); assert.deepEqual(storedPublic(f).pendingDeletions, []);
  assert.equal((await f.mcp(logged.token.data.access_token, 'tools/list')).status, 200);
  blocked.release(); assert.equal((await blocked.pending).status, 200);
  assert.equal((await publicRemoval(f)).status, 200);
  assert.equal((await f.mcp(logged.token.data.access_token, 'tools/list')).status, 401);
  assert.equal(keys.credentials.has(id), false); assert.deepEqual(storedPublic(f).pendingDeletions, []);
});

for (const fault of ['timeout', 'guard']) test(`public removal HTTP: ${fault} leaves durable disabled intent and permits fresh local UV retry`, async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const logged = await f.signIn(), id = f.publicAuth.credential.id;
  const keys = f.c.publicPasskeys, blocked = await blockedPublicAssertion(f), invalidated = deferred();
  const cancel = f.c.transactions.cancelCredential.bind(f.c.transactions);
  f.c.transactions.cancelCredential = (...args) => { cancel(...args); invalidated.resolve(); };
  if (fault === 'timeout') keys.deadlineMs = 25;
  const removing = publicRemoval(f); await invalidated.promise;
  assert.equal(keys.current(id), false); assert.deepEqual(storedPublic(f).pendingDeletions, [id]);
  assert.equal((await f.mcp(logged.token.data.access_token, 'tools/list')).status, 401);
  if (fault === 'guard') { f.c.authority.revokeAll(); blocked.release(); }
  const failure = await removing;
  assert.equal(failure.status, fault === 'timeout' ? 408 : 400, failure.text);
  assert.equal(failure.data.error, fault === 'timeout' ? 'verification_timeout' : 'admin_proof_invalid');
  if (fault === 'timeout') blocked.release();
  assert.equal((await blocked.pending).status, 400);
  assert.equal(keys.deletionState(id), 'failed'); assert.equal(keys.current(id), false);
  assert.deepEqual(storedPublic(f).pendingDeletions, [id]);
  assert.equal(storedPublic(f).credentials.find(c => c.id === id).counter, 1, 'old assertion did not save a counter');
  keys.deadlineMs = 10_000;
  const list = await f.admin('list'); assert.equal(list.status, 200); assert.equal(list.data.credentials.find(c => c.credentialId === id).state, 'failed');
  assert.equal((await publicRemoval(f)).status, 200);
  assert.equal(keys.credentials.has(id), false); assert.deepEqual(storedPublic(f).pendingDeletions, []);
});

test('public removal HTTP: storage failure disables sessions/approvals, other writers preserve intent, fresh UV finishes', async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const logged = await f.signIn(), flow = await f.begin();
  assert.equal((await f.authenticate(flow)).verify.status, 200);
  const keys = f.c.publicPasskeys, id = f.publicAuth.credential.id, persist = keys.persist;
  keys.persist = (next, pending) => { if (!next.has(id)) throw new Error('disk_failure'); return persist(next, pending); };
  const failure = await publicRemoval(f); assert.equal(failure.status, 400); assert.equal(failure.data.error, 'disk_failure');
  assert.equal(keys.current(id), false); assert.equal(keys.credentials.has(id), true); assert.equal(keys.deletionState(id), 'failed');
  assert.deepEqual(storedPublic(f).pendingDeletions, [id]);
  assert.equal((await f.mcp(logged.token.data.access_token, 'tools/list')).status, 401);
  assert.equal((await f.token({ grant_type: 'refresh_token', refresh_token: logged.token.data.refresh_token, resource: f.c.resource })).status, 400);
  assert.equal((await f.post('/authorize/consent', { tx: flow.tx, accept: true }, flow.cookie)).status, 400);
  const other = authenticator({ rpID: 'issuer.example.test' }); await f.enrollPublic(other);
  const second = await f.begin(); assert.equal((await f.authenticate(second, other)).verify.status, 200);
  assert.deepEqual(storedPublic(f).pendingDeletions, [id], 'registration and another key counter preserved revocation');
  const refused = await f.authenticate(await f.begin()); assert.equal(refused.verify.status, 400);
  assert.ok(refused.options.data.allowCredentials.every(c => c.id !== id));
  keys.persist = persist;
  const list = await f.admin('list'); assert.equal(list.data.credentials.find(c => c.credentialId === id).state, 'failed');
  assert.equal((await publicRemoval(f)).status, 200); assert.equal(keys.current(other.credential.id), true);
  assert.equal(keys.credentials.has(id), false); assert.deepEqual(storedPublic(f).pendingDeletions, []);
});

test('public removal HTTP: failed intent persistence rejects admission before disabling; fresh proof retries', async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const logged = await f.signIn(), keys = f.c.publicPasskeys, id = f.publicAuth.credential.id;
  const persist = keys.persist; keys.persist = () => { throw new Error('disk_failure'); };
  const failure = await publicRemoval(f); assert.equal(failure.status, 400); assert.equal(failure.data.error, 'disk_failure');
  assert.equal(keys.current(id), true); assert.equal(keys.deletionState(id), null); assert.deepEqual(storedPublic(f).pendingDeletions, []);
  assert.equal((await f.mcp(logged.token.data.access_token, 'tools/list')).status, 200);
  keys.persist = persist; assert.equal((await publicRemoval(f)).status, 200);
  assert.equal((await f.mcp(logged.token.data.access_token, 'tools/list')).status, 401);
});

test('public removal HTTP: pending revocation survives restart, stays unusable, and local UV finishes', async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const id = f.publicAuth.credential.id, keys = f.c.publicPasskeys, persist = keys.persist;
  keys.persist = (next, pending) => { if (!next.has(id)) throw new Error('disk_failure'); return persist(next, pending); };
  assert.equal((await publicRemoval(f)).status, 400); assert.deepEqual(storedPublic(f).pendingDeletions, [id]);
  await f.reopen(); assert.equal(f.c.publicPasskeys.credentials.has(id), true); assert.equal(f.c.publicPasskeys.current(id), false);
  assert.equal(f.c.publicPasskeys.deletionState(id), 'pending');
  const flow = await f.begin(); assert.equal((await f.post('/authorize/passkey/options', { tx: flow.tx }, flow.cookie)).status, 400);
  const list = await f.admin('list'); assert.equal(list.data.credentials.find(c => c.credentialId === id).state, 'pending');
  assert.equal((await publicRemoval(f)).status, 200); assert.deepEqual(storedPublic(f).pendingDeletions, []);
  await f.reopen(); assert.equal(f.c.publicPasskeys.credentials.has(id), false); assert.equal(f.c.passkeys.current(f.localAuth.credential.id), true);
});

test('local removal HTTP: failed disabled-key deletion retries while the remaining local admin key is protected', async t => {
  const f = await publicFixture(t), other = authenticator({ rpID: 'localhost' });
  const ticket = f.c.enrollment.issue(), options = await f.localPost('/api/enroll/options', { ticket });
  assert.equal((await f.localPost('/api/enroll/verify', { ticket, response: other.registration(options.data.challenge, { origin: f.local }) })).status, 200);
  const keys = f.c.passkeys, id = other.credential.id, persist = keys.persist;
  keys.persist = (next, pending) => { if (!next.has(id)) throw new Error('disk_failure'); return persist(next, pending); };
  assert.equal((await f.admin('remove', { rp: 'local', credentialId: id })).status, 400);
  assert.equal(keys.current(id), false); assert.equal(keys.current(f.localAuth.credential.id), true);
  assert.deepEqual(JSON.parse(readFileSync(`${f.state}/passkeys.json`)).pendingDeletions, [id]);
  keys.persist = persist; assert.equal((await f.admin('remove', { rp: 'local', credentialId: id })).status, 200);
  assert.equal((await f.localPost('/api/credentials/options', { action: 'remove', rp: 'local', credentialId: f.localAuth.credential.id })).data.error, 'last_local_credential');
});

test('public storage: malformed durable revocation intent fails closed at boot', async t => {
  const f = await publicFixture(t); await f.enrollPublic(); const value = storedPublic(f);
  for (const pending of [null, 'not-an-array', ['unknown-key'], [f.publicAuth.credential.id, f.publicAuth.credential.id]]) {
    value.pendingDeletions = pending; writeFileSync(`${f.state}/passkeys-public.json`, JSON.stringify(value), { mode: 0o600 });
    await assert.rejects(f.reopen(), /credential_storage_invalid/);
  }
});

// Complete real action-bound local UV, then hold only delivery of its already verified result.
// Releasing this promise from a public save schedules removal admission before the unchanged
// crypto wrapper's `await saveCredential` continuation. No proof or verification is bypassed.
async function heldRemovalProof(f, target) {
  const local = f.c.passkeys, verify = local.verify.bind(local);
  let resolve, reject, credentialId;
  const held = new Promise((ok, ko) => { resolve = ok; reject = ko; }), entered = deferred();
  local.verify = params => {
    verify(params).then(id => { credentialId = id; entered.resolve(); }, error => { reject(error); entered.resolve(); });
    return held;
  };
  const removing = f.admin('remove', { rp: 'public', credentialId: target });
  await entered.promise;
  return { removing, release() { local.verify = verify; resolve(credentialId); } };
}

test('public removal N1 A: admission inside survivor counter save preserves disk counter and refuses reuse after restart', async t => {
  const f = await publicFixture(t); await f.enrollPublic();
  const other = authenticator({ rpID: 'issuer.example.test' }); await f.enrollPublic(other);
  const target = other.credential.id, survivor = f.publicAuth.credential.id, proof = await heldRemovalProof(f, target);
  const keys = f.c.publicPasskeys, persist = keys.persist, save = keys.crypto.saveCredential;
  let released = false, memoryAtSave, intentCounter, finalWrites = 0;
  keys.persist = (next, pending) => {
    if (!next.has(target)) { finalWrites++; throw new Error('disk_failure'); }
    if (pending.includes(target)) intentCounter = next.get(survivor).counter;
    return persist(next, pending);
  };
  keys.crypto.saveCredential = credential => {
    const result = save(credential);
    if (!released && credential.id === survivor && credential.counter === 1) {
      released = true; memoryAtSave = keys.credentials.get(survivor).counter; proof.release();
    }
    return result;
  };
  const authentication = await f.authenticate(await f.begin(), f.publicAuth, { counter: 1 }), removed = await proof.removing;
  assert.equal(released, true); assert.equal(authentication.verify.status, 200, authentication.verify.text);
  assert.equal(removed.status, 400); assert.equal(removed.data.error, 'disk_failure'); assert.equal(finalWrites, 1);
  assert.equal(keys.credentials.get(survivor).counter, 1); assert.equal(keys.current(target), false);
  const stored = storedPublic(f); assert.deepEqual(stored.pendingDeletions, [target]);
  assert.equal(stored.credentials.find(c => c.id === survivor).counter, 1, 'intent did not roll back the committed counter');
  assert.equal(memoryAtSave, 1, 'the guarded save updated memory synchronously'); assert.equal(intentCounter, 1);
  await f.reopen(); assert.equal(f.c.publicPasskeys.current(target), false); assert.equal(f.c.publicPasskeys.current(survivor), true);
  assert.equal(f.c.publicPasskeys.credentials.get(survivor).counter, 1);
  const reused = await f.authenticate(await f.begin(), f.publicAuth, { counter: 1 }); assert.equal(reused.verify.status, 400, 'same nonzero counter is rejected on a fresh challenge');
  const newer = await f.authenticate(await f.begin(), f.publicAuth, { counter: 2 }); assert.equal(newer.verify.status, 200, newer.verify.text);
  assert.equal((await f.admin('remove', { rp: 'public', credentialId: target })).status, 200, 'fresh local proof completes disabled-target deletion');
  assert.equal(f.c.publicPasskeys.current(survivor), true); assert.equal(storedPublic(f).credentials.find(c => c.id === survivor).counter, 2);
  assert.deepEqual(storedPublic(f).pendingDeletions, []);
});

test('public removal N1 B: admission during enrollment persistence retains the successful new key after failure/restart', async t => {
  const f = await publicFixture(t); await f.enrollPublic();
  const target = f.publicAuth.credential.id, enrolled = authenticator({ rpID: 'issuer.example.test' });
  const enrollment = await f.beginEnrollment(), options = await f.post('/enroll/options', { ticket: enrollment.ticket }, enrollment.cookie);
  assert.equal(options.status, 200, options.text);
  const proof = await heldRemovalProof(f, target), keys = f.c.publicPasskeys, persist = keys.persist;
  let released = false, intentHasNewKey, finalWrites = 0;
  keys.persist = (next, pending) => {
    if (!next.has(target)) { finalWrites++; throw new Error('disk_failure'); }
    const result = persist(next, pending);
    if (pending.includes(target)) intentHasNewKey = next.has(enrolled.credential.id);
    // Resolve inside the writer after the actual synchronous save, before the OAuth save
    // callback returns and before the core's awaited Map.set. This is review probe B's order.
    if (!released && next.has(enrolled.credential.id)) { released = true; proof.release(); }
    return result;
  };
  const registered = await f.post('/enroll/verify', { ticket: enrollment.ticket, response: enrolled.registration(options.data.challenge, { origin: f.issuer }) }, enrollment.cookie);
  const removed = await proof.removing;
  assert.equal(released, true); assert.equal(registered.status, 200, registered.text);
  assert.equal(removed.status, 400); assert.equal(removed.data.error, 'disk_failure'); assert.equal(finalWrites, 1);
  assert.equal(keys.current(enrolled.credential.id), true); assert.ok(keys.version(enrolled.credential.id) > 0);
  assert.equal(keys.current(target), false); assert.equal(f.c.publicEnrollment.active, false, 'successful enrollment consumed its generation');
  assert.deepEqual(storedPublic(f).pendingDeletions, [target]);
  assert.ok(storedPublic(f).credentials.some(c => c.id === enrolled.credential.id), 'intent retained the newly committed credential');
  assert.equal(intentHasNewKey, true);
  await f.reopen(); assert.equal(f.c.publicPasskeys.current(target), false); assert.equal(f.c.publicPasskeys.current(enrolled.credential.id), true);
  const login = await f.authenticate(await f.begin(), enrolled, { counter: 1 }); assert.equal(login.verify.status, 200, login.verify.text);
  assert.equal((await f.admin('remove', { rp: 'public', credentialId: target })).status, 200);
  assert.equal(f.c.publicPasskeys.current(enrolled.credential.id), true); assert.equal(f.c.passkeys.current(f.localAuth.credential.id), true);
  assert.ok(storedPublic(f).credentials.some(c => c.id === enrolled.credential.id)); assert.deepEqual(storedPublic(f).pendingDeletions, []);
});
