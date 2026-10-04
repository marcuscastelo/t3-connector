import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionAuthority } from '../src/oauth/session-authority.mjs';
import { TokenStore } from '../src/oauth/token-store.mjs';

const IDLE = 3600_000;
function setup({ idleMs = IDLE, maxAgeMs = 0, atTtlMs = 60_000 } = {}) {
  let mono = 0, wall = 1_000_000;
  const clock = () => mono, wallClock = () => wall, audit = [];
  const authority = new SessionAuthority({ idleMs, maxAgeMs, clock, wall: wallClock, audit: e => audit.push(e) });
  const tokens = new TokenStore({ authority, atTtlMs, clock, wall: wallClock });
  const session = () => authority.create({ sub: 'owner', clientId: 'https://client.example/c.json', credentialId: 'cred', scope: 'connector:read connector:write', resource: 'https://rs.example/mcp' });
  const login = () => {
    const sid = session();
    const code = tokens.issueCode({ sid, clientId: 'https://client.example/c.json', redirectUri: 'https://client.example/cb', codeChallenge: 'C', resource: 'https://rs.example/mcp', scope: 'connector:read connector:write' });
    return { sid, ...tokens.consumeCode(code, { clientId: 'https://client.example/c.json', redirectUri: 'https://client.example/cb', verifyPkce: c => c === 'C', resource: 'https://rs.example/mcp' }) };
  };
  const refresh = rt => tokens.refresh(rt, { clientId: 'https://client.example/c.json', resource: 'https://rs.example/mcp' });
  return { authority, tokens, audit, session, login, refresh, advance: ms => { mono += ms; wall += ms; }, moveWall: ms => { wall += ms; }, moveMono: ms => { mono += ms; } };
}

test('idle window ends the session exactly at the boundary', () => {
  const s = setup(), sid = s.session();
  s.advance(IDLE - 1); s.authority.check(sid);
  s.advance(1); assert.throws(() => s.authority.check(sid), /session_idle_expired/);
});

test('only admit() restarts the idle window; check() does not', () => {
  const s = setup(), sid = s.session();
  s.advance(IDLE / 2); s.authority.check(sid); s.authority.check(sid);
  s.advance(IDLE / 2); assert.throws(() => s.authority.admit(sid), /idle_expired/);
  const s2 = setup(), sid2 = s2.session();
  s2.advance(IDLE - 10); s2.authority.admit(sid2);
  s2.advance(IDLE - 10); s2.authority.check(sid2);
  s2.advance(10); assert.throws(() => s2.authority.check(sid2), /idle_expired/);
});

test('terminal session never revives, even after admit attempts or wall rollback', () => {
  const s = setup(), sid = s.session();
  s.advance(IDLE); assert.throws(() => s.authority.check(sid));
  s.moveWall(-2 * IDLE); assert.throws(() => s.authority.admit(sid), /idle_expired/);
});

test('suspended monotonic clock does not rejuvenate (wall elapsed counts)', () => {
  const s = setup(), sid = s.session();
  s.moveWall(IDLE); assert.throws(() => s.authority.check(sid), /idle_expired/);
});

test('wall clock moved back does not extend (monotonic elapsed counts)', () => {
  const s = setup(), sid = s.session();
  s.moveWall(-IDLE); s.moveMono(IDLE); assert.throws(() => s.authority.check(sid), /idle_expired/);
});

test('optional max age ends the session despite continuous activity', () => {
  const s = setup({ maxAgeMs: 2 * IDLE }), sid = s.session();
  for (let i = 0; i < 3; i++) { s.advance(IDLE - 1); if (i < 2) s.authority.admit(sid); }
  assert.throws(() => s.authority.check(sid), /session_max_age/);
});

test('revoke and kill switch are immediate; kill refuses new sessions until released', () => {
  const s = setup(), a = s.session(), b = s.session();
  assert.equal(s.authority.revoke(a), true);
  assert.throws(() => s.authority.check(a), /session_revoked/);
  s.authority.check(b);
  assert.equal(s.authority.kill(), 1);
  assert.throws(() => s.authority.check(b), /session_kill_switch/);
  assert.throws(() => s.session(), /kill_switch/);
  s.authority.release();
  assert.throws(() => s.authority.check(b), /kill_switch/);
  s.authority.check(s.session());
});

test('code exchange issues opaque AT + RT bound to the session', () => {
  const s = setup(), t = s.login();
  assert.equal(t.token_type, 'Bearer'); assert.equal(t.expires_in, 60);
  assert.equal(s.tokens.resolveAccess(t.access_token).sid, t.sid);
});

test('code is single use; reuse ends the session it created', () => {
  const s = setup(), sid = s.session();
  const code = s.tokens.issueCode({ sid, clientId: 'c', redirectUri: 'r', codeChallenge: 'C', resource: 'x', scope: 'a' });
  const opts = { clientId: 'c', redirectUri: 'r', verifyPkce: () => true, resource: 'x' };
  const t = s.tokens.consumeCode(code, opts);
  assert.throws(() => s.tokens.consumeCode(code, opts), /code_reused/);
  assert.throws(() => s.tokens.resolveAccess(t.access_token), /token_unknown|session_code_reuse/);
});

test('code checks: expiry, client, redirect, PKCE, resource', () => {
  for (const [delta, re] of [[{ clientId: 'other' }, /client_mismatch/], [{ redirectUri: 'other' }, /redirect_uri_mismatch/], [{ verifyPkce: () => false }, /pkce_failed/], [{ resource: 'other' }, /resource_mismatch/]]) {
    const s = setup(), sid = s.session();
    const code = s.tokens.issueCode({ sid, clientId: 'c', redirectUri: 'r', codeChallenge: 'C', resource: 'x', scope: 'a' });
    assert.throws(() => s.tokens.consumeCode(code, { clientId: 'c', redirectUri: 'r', verifyPkce: () => true, resource: 'x', ...delta }), re);
  }
  const s = setup(), sid = s.session();
  const code = s.tokens.issueCode({ sid, clientId: 'c', redirectUri: 'r', codeChallenge: 'C', resource: 'x', scope: 'a' });
  s.advance(60_000);
  assert.throws(() => s.tokens.consumeCode(code, { clientId: 'c', redirectUri: 'r', verifyPkce: () => true }), /code_expired/);
});

test('refresh rotates without touching idle; a refresh-only client still hits idle', () => {
  const s = setup();
  let t = s.login();
  for (let i = 0; i < 61; i++) { s.advance(59_000); t = s.refresh(t.refresh_token); }
  s.advance(999); // 1 ms before 1 h since login
  t = s.refresh(t.refresh_token);
  assert.ok(t.expires_in <= 1, 'AT is truncated to the idle deadline');
  s.advance(1);
  assert.throws(() => s.refresh(t.refresh_token), e => e.error === 'invalid_grant');
  assert.throws(() => s.tokens.resolveAccess(t.access_token), /token_unknown|token_expired|idle/);
});

test('activity keeps the family alive past the idle window', () => {
  const s = setup();
  let t = s.login();
  for (let i = 0; i < 120; i++) { s.advance(59_000); t = s.refresh(t.refresh_token); s.authority.admit(s.tokens.resolveAccess(t.access_token).sid); }
  s.tokens.resolveAccess(t.access_token);
});

test('refresh token reuse ends the whole session, including the successor tokens', () => {
  const s = setup(), t1 = s.login(), t2 = s.refresh(t1.refresh_token);
  assert.throws(() => s.refresh(t1.refresh_token), /refresh_token_reused/);
  assert.throws(() => s.tokens.resolveAccess(t2.access_token), /token_unknown|refresh_reuse/);
  assert.throws(() => s.refresh(t2.refresh_token), e => e.error === 'invalid_grant');
  assert.throws(() => s.authority.check(t1.sid), /session_refresh_reuse/);
});

test('refresh checks client, resource and scope widening', () => {
  const s = setup(), t = s.login();
  assert.throws(() => s.tokens.refresh(t.refresh_token, { clientId: 'other' }), /client_mismatch/);
  assert.throws(() => s.tokens.refresh(t.refresh_token, { clientId: 'https://client.example/c.json', resource: 'https://evil/mcp' }), /resource_mismatch/);
  assert.throws(() => s.tokens.refresh(t.refresh_token, { clientId: 'https://client.example/c.json', scope: 'connector:admin' }), /scope_not_granted/);
  s.tokens.refresh(t.refresh_token, { clientId: 'https://client.example/c.json', scope: 'connector:read' });
});

test('AT expiry is enforced independently of the session', () => {
  const s = setup(), t = s.login();
  s.advance(59_999); s.tokens.resolveAccess(t.access_token);
  s.advance(1); assert.throws(() => s.tokens.resolveAccess(t.access_token), /token_expired/);
});

test('revocation invalidates live AT and RT immediately', () => {
  const s = setup(), t = s.login();
  s.authority.revoke(t.sid);
  assert.throws(() => s.tokens.resolveAccess(t.access_token), /invalid_token|token_unknown/);
  assert.throws(() => s.refresh(t.refresh_token), e => e.error === 'invalid_grant');
});

test('revoking only access tokens keeps refresh working (the RS would answer 401)', () => {
  const s = setup(), t = s.login();
  s.tokens.revokeAccessTokens();
  assert.throws(() => s.tokens.resolveAccess(t.access_token), /token_unknown/);
  const t2 = s.refresh(t.refresh_token);
  s.tokens.resolveAccess(t2.access_token);
});

test('RFC 7009 revoke by the owning client ends the session; other clients cannot', () => {
  const s = setup(), t = s.login();
  s.tokens.revokeToken(t.refresh_token, { clientId: 'someone-else' });
  s.tokens.resolveAccess(t.access_token);
  s.tokens.revokeToken(t.refresh_token, { clientId: 'https://client.example/c.json' });
  assert.throws(() => s.tokens.resolveAccess(t.access_token));
});

test('kill switch makes refresh fail with invalid_grant', () => {
  const s = setup(), t = s.login();
  s.authority.kill();
  assert.throws(() => s.refresh(t.refresh_token), e => e.error === 'invalid_grant');
});

test('no token value is stored or audited in clear', () => {
  const s = setup(), t = s.login();
  const dump = JSON.stringify(s.audit) + JSON.stringify(s.tokens.counts());
  for (const v of [t.access_token, t.refresh_token]) assert.ok(!dump.includes(v));
});

// Regressions from the independent review (REVISAO-CODEX.md F2, F3).
test('suspend then wall rollback never gives back observed idle time', () => {
  const s = setup(), sid = s.session();
  s.moveWall(IDLE - 100_000);
  assert.equal(s.authority.remainingMs(sid), 100_000);
  s.moveWall(-(IDLE - 100_000));
  assert.ok(s.authority.remainingMs(sid) <= 100_000, 'remaining idle must not grow without activity');
  s.moveMono(100_000);
  assert.throws(() => s.authority.check(sid), /idle_expired/);
});

test('max age cannot be extended by suspend + rollback either', () => {
  const s = setup({ maxAgeMs: 2 * IDLE }), sid = s.session();
  s.moveWall(IDLE - 10); s.authority.admit(sid);
  s.moveWall(IDLE - 10); s.authority.admit(sid);
  s.moveWall(-(2 * IDLE - 20));
  s.moveMono(20);
  assert.throws(() => s.authority.check(sid), /session_max_age/);
});

test('a used code stays a tombstone after sweep: replay still ends the session', () => {
  const s = setup(), sid = s.session();
  const code = s.tokens.issueCode({ sid, clientId: 'c', redirectUri: 'r', codeChallenge: 'C', resource: 'x', scope: 'a' });
  const opts = { clientId: 'c', redirectUri: 'r', verifyPkce: () => true, resource: 'x' };
  const t = s.tokens.consumeCode(code, opts);
  s.advance(10 * 60_000); s.tokens.sweep();
  assert.throws(() => s.tokens.consumeCode(code, opts), /code_reused/);
  assert.throws(() => s.authority.check(sid), /session_code_reuse/);
  assert.throws(() => s.tokens.resolveAccess(t.access_token));
});

test('sweep ends sessions whose code was never exchanged', () => {
  const s = setup(), sid = s.session();
  s.tokens.issueCode({ sid, clientId: 'c', redirectUri: 'r', codeChallenge: 'C', resource: 'x', scope: 'a' });
  s.advance(60_000); s.tokens.sweep();
  assert.throws(() => s.authority.check(sid), /code_expired_unused/);
});

test('revoke-all and kill increment the authority epoch', () => {
  const s = setup(), e0 = s.authority.epoch;
  s.authority.revokeAll(); assert.equal(s.authority.epoch, e0 + 1);
  s.authority.kill(); assert.equal(s.authority.epoch, e0 + 2);
  s.authority.release(); assert.equal(s.authority.epoch, e0 + 2);
});
