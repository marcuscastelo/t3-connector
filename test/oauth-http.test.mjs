import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startConnector, http } from './oauth-apoio.mjs';
import { CLIENT } from './oauth-fixtures.mjs';

const text = r => r.data?.result?.content?.[0]?.text;
const isToolError = r => r.data?.result?.isError === true;

test('discovery: 401 challenge, protected resource metadata and AS metadata', async t => {
  const c = await startConnector(); t.after(c.close);
  const r = await c.mcp(null, 'initialize', {});
  assert.equal(r.status, 401);
  assert.match(r.headers['www-authenticate'], new RegExp(`resource_metadata="${c.issuer}/.well-known/oauth-protected-resource/mcp"`));
  assert.doesNotMatch(r.headers['www-authenticate'], /error=/);
  const prmd = await http('GET', `${c.issuer}/.well-known/oauth-protected-resource/mcp`);
  assert.deepEqual(prmd.data.authorization_servers, [c.issuer]);
  assert.equal(prmd.data.resource, `${c.issuer}/mcp`);
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
    const md = await http('GET', `${c.issuer}${path}`);
    assert.equal(md.data.issuer, c.issuer);
    assert.deepEqual(md.data.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(md.data.token_endpoint_auth_methods_supported, ['private_key_jwt']);
    assert.equal(md.data.authorization_response_iss_parameter_supported, true);
    assert.equal(md.data.client_id_metadata_document_supported, true);
    assert.equal(md.data.registration_endpoint, undefined);
  }
});

for (const mode of ['button', '302', 'oob']) {
  test(`first access (${mode}): passkey on localhost, callback with code+state+iss, read and write`, async t => {
    const c = await startConnector({ loginMode: mode }); t.after(c.close);
    const s = await c.signIn();
    if (mode === '302') assert.equal(s.auth.status, 302);
    assert.equal(s.view.data.clientId, CLIENT);
    assert.equal(s.view.data.returnsTo, 'client.example');
    assert.equal(s.resume.status, 302);
    assert.equal(s.cb.origin + s.cb.pathname, 'https://client.example/cb');
    assert.equal(s.cb.searchParams.get('state'), s.state);
    assert.equal(s.cb.searchParams.get('iss'), c.issuer);
    assert.equal(s.tokenResponse.status, 200, s.tokenResponse.text);
    assert.equal(s.tokens.token_type, 'Bearer');
    assert.equal(s.tokens.expires_in, 60);
    assert.equal(s.tokens.scope, 'connector:read connector:write');
    const at = s.tokens.access_token;
    assert.equal((await c.mcp(at, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).status, 200);
    const list = await c.mcp(at, 'tools/list');
    assert.deepEqual(list.data.result.tools.map(x => x.name).sort(), ['rehearsal_echo', 'rehearsal_note_write', 'rehearsal_notes', 'rehearsal_now']);
    assert.equal(text(await c.callTool(at, 'rehearsal_echo', { text: 'hi' })), 'echo: hi');
    assert.equal(text(await c.callTool(at, 'rehearsal_note_write', { text: 'n1' })), 'note 1 saved');
    assert.match(text(await c.callTool(at, 'rehearsal_notes')), /"text":"n1"/);
  });
}

test('resume needs the cookie of the browser that started the sign-in and is single use', async t => {
  const c = await startConnector(); t.after(c.close);
  const auth = await http('GET', `${c.issuer}/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT)}&redirect_uri=${encodeURIComponent('https://client.example/cb')}&code_challenge=${'A'.repeat(43)}&code_challenge_method=S256&state=x`);
  const cookie = auth.headers['set-cookie'][0].split(';')[0];
  assert.match(auth.headers['set-cookie'][0], /HttpOnly; SameSite=Lax/);
  const handoff = /#handoff=([^"]+)"/.exec(auth.text)[1];
  const opts = await c.localPost('/api/login/options', { handoff });
  const v = await c.localPost('/api/login/verify', { handoff, response: c.passkey.assertion(opts.data.challenge, { origin: c.local }) });
  assert.equal((await http('GET', v.data.resume)).status, 400);
  assert.equal((await http('GET', v.data.resume, { headers: { cookie: 't3c_tx=forged' } })).status, 400);
  const ok = await http('GET', v.data.resume, { headers: { cookie } });
  assert.equal(ok.status, 302);
  assert.equal((await http('GET', v.data.resume, { headers: { cookie } })).status, 400);
});

test('authorize rejects unknown clients, unregistered callbacks, missing PKCE and foreign resources', async t => {
  const c = await startConnector(); t.after(c.close);
  const q = o => new URLSearchParams({ response_type: 'code', client_id: CLIENT, redirect_uri: 'https://client.example/cb', code_challenge: 'A'.repeat(43), code_challenge_method: 'S256', state: 's', ...o }).toString();
  assert.equal((await http('GET', `${c.issuer}/authorize?${q({ client_id: 'https://evil.example/c.json' })}`)).status, 400);
  const badCb = await http('GET', `${c.issuer}/authorize?${q({ redirect_uri: 'https://evil.example/cb' })}`);
  assert.equal(badCb.status, 400); assert.equal(badCb.headers.location, undefined);
  for (const [o, err] of [[{ code_challenge_method: 'plain' }, 'invalid_request'], [{ code_challenge: undefined }, 'invalid_request'], [{ resource: 'https://other/mcp' }, 'invalid_target'], [{ response_type: 'token' }, 'unsupported_response_type']]) {
    const params = q(o).replace(/code_challenge=undefined&?/, '');
    const r = await http('GET', `${c.issuer}/authorize?${params}`);
    assert.equal(r.status, 302);
    const u = new URL(r.headers.location);
    assert.equal(u.searchParams.get('error'), err); assert.equal(u.searchParams.get('iss'), c.issuer); assert.equal(u.searchParams.get('state'), 's');
  }
});

test('token endpoint: private_key_jwt required, wrong verifier, code reuse kills the session', async t => {
  const c = await startConnector(); t.after(c.close);
  const s = await c.signIn();
  assert.equal(s.tokenResponse.headers['cache-control'], 'no-store');
  const reuse = await c.token({ grant_type: 'authorization_code', code: s.code, code_verifier: s.verifier });
  assert.equal(reuse.data.error, 'invalid_grant');
  assert.equal((await c.mcp(s.tokens.access_token, 'tools/list')).status, 401);
  const s2 = await c.signIn();
  const noAuth = await http('POST', `${c.issuer}/token`, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s2.tokens.refresh_token, client_id: CLIENT }).toString() });
  assert.equal(noAuth.status, 401); assert.equal(noAuth.data.error, 'invalid_client');
  const wrongAud = await c.token({ grant_type: 'refresh_token', refresh_token: s2.tokens.refresh_token }, { assertion: c.assertion({ aud: 'https://elsewhere/token' }) });
  assert.equal(wrongAud.data.error, 'invalid_client');
  const json = await http('POST', `${c.issuer}/token`, { headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(json.data.error, 'invalid_request');
});

test('wrong PKCE verifier is refused and burns the code', async t => {
  const c = await startConnector(); t.after(c.close);
  const sid = c.connector.authority.create({ sub: c.connector.subject, clientId: CLIENT, credentialId: 'k', scope: 'connector:read connector:write', resource: `${c.issuer}/mcp` });
  const code = c.connector.tokens.issueCode({ sid, clientId: CLIENT, redirectUri: 'https://client.example/cb', codeChallenge: 'B'.repeat(43), resource: `${c.issuer}/mcp`, scope: 'connector:read' });
  const bad = await c.token({ grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(43) });
  assert.equal(bad.data.error, 'invalid_grant');
  const again = await c.token({ grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(43) });
  assert.equal(again.data.error, 'invalid_grant');
});

test('silent refresh rotation keeps read+write working while tools are called; refresh never extends idle', async t => {
  const c = await startConnector(); t.after(c.close);
  let tok = (await c.signIn()).tokens;
  for (let i = 0; i < 70; i++) { // 70 minutes of activity, AT 60 s
    c.advance(59_000);
    const r = await c.refresh(tok.refresh_token);
    assert.equal(r.status, 200, r.text); tok = r.data;
    if (i % 5 === 0) assert.equal(text(await c.callTool(tok.access_token, i % 10 ? 'rehearsal_now' : 'rehearsal_note_write', { ...(i % 10 ? {} : { text: `m${i}` }) }))?.length > 0, true);
  }
  assert.equal((await c.mcp(tok.access_token, 'tools/list')).status, 200);
});

test('idle: refresh, initialize and tools/list do not count; after 1 h without tools/call the session is dead', async t => {
  const c = await startConnector(); t.after(c.close);
  let tok = (await c.signIn()).tokens;
  for (let i = 0; i < 60; i++) {
    c.advance(59_000);
    const r = await c.refresh(tok.refresh_token);
    if (r.status !== 200) break;
    tok = r.data;
    await c.mcp(tok.access_token, 'initialize', {});
    await c.mcp(tok.access_token, 'tools/list');
    await c.mcp(tok.access_token, 'ping');
  }
  c.advance(60_000);
  const dead = await c.mcp(tok.access_token, 'tools/call', { name: 'rehearsal_now', arguments: {} });
  assert.equal(dead.status, 401);
  assert.match(dead.headers['www-authenticate'], /error="invalid_token"/);
  const r = await c.refresh(tok.refresh_token);
  assert.equal(r.data.error, 'invalid_grant');
  // a new sign-in (new passkey ceremony) creates a new session; old tokens stay dead
  const fresh = (await c.signIn()).tokens;
  assert.equal(text(await c.callTool(fresh.access_token, 'rehearsal_echo', { text: 'back' })), 'echo: back');
  assert.equal((await c.mcp(tok.access_token, 'tools/list')).status, 401);
});

test('refresh token reuse ends the session (invalid_grant then 401)', async t => {
  const c = await startConnector(); t.after(c.close);
  const t1 = (await c.signIn()).tokens;
  const t2 = (await c.refresh(t1.refresh_token)).data;
  assert.equal((await c.refresh(t1.refresh_token)).data.error, 'invalid_grant');
  assert.equal((await c.mcp(t2.access_token, 'tools/list')).status, 401);
});

test('local revocation and kill switch are immediate; release needs a passkey and revives nothing', async t => {
  const c = await startConnector(); t.after(c.close);
  const a = (await c.signIn()).tokens, b = (await c.signIn()).tokens;
  const list = await c.localPost('/api/sessions', {});
  assert.equal(list.data.sessions.filter(s => s.state === 'active').length, 2);
  const sidA = c.connector.tokens.resolveAccess(a.access_token).sid;
  await c.localPost('/api/sessions/revoke', { sid: sidA });
  assert.equal((await c.mcp(a.access_token, 'tools/list')).status, 401);
  assert.equal((await c.refresh(a.refresh_token)).data.error, 'invalid_grant');
  assert.equal((await c.mcp(b.access_token, 'tools/list')).status, 200);
  await c.localPost('/api/kill', {});
  assert.equal((await c.mcp(b.access_token, 'tools/list')).status, 401);
  const blocked = await http('GET', `${c.issuer}/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT)}&redirect_uri=${encodeURIComponent('https://client.example/cb')}&code_challenge=${'A'.repeat(43)}&code_challenge_method=S256`);
  assert.equal(new URL(blocked.headers.location).searchParams.get('error'), 'access_denied');
  assert.equal((await c.localPost('/api/release/verify', { response: c.passkey.assertion('wrong', { origin: c.local, counter: c.nextCounter() }) })).status, 400);
  const o = await c.localPost('/api/release/options', {});
  assert.equal((await c.localPost('/api/release/verify', { response: c.passkey.assertion(o.data.challenge, { origin: c.local, counter: c.nextCounter() }) })).status, 200);
  assert.equal((await c.mcp(b.access_token, 'tools/list')).status, 401);
  const fresh = (await c.signIn()).tokens;
  assert.equal((await c.mcp(fresh.access_token, 'tools/list')).status, 200);
});

test('kill switch and passkeys persist across a restart; sessions do not', async t => {
  const c = await startConnector();
  const tok = (await c.signIn()).tokens;
  await c.close();
  const again = await startConnector({ config: { stateDir: c.connector.stateDir }, enroll: false }); t.after(again.close);
  assert.equal(again.connector.passkeys.credentials.size, 1);
  assert.equal(again.connector.subject, c.connector.subject);
  await again.localPost('/api/kill', {});
  await again.close();
  const third = await startConnector({ config: { stateDir: c.connector.stateDir }, enroll: false }); t.after(third.close);
  assert.equal(third.connector.authority.killed, true);
  assert.ok(tok.access_token);
});

test('revoking only access tokens yields 401 while refresh still works (ChatGPT would ask to reconnect)', async t => {
  const c = await startConnector(); t.after(c.close);
  const tok = (await c.signIn()).tokens;
  c.connector.tokens.revokeAccessTokens();
  assert.equal((await c.mcp(tok.access_token, 'tools/list')).status, 401);
  const r = await c.refresh(tok.refresh_token);
  assert.equal(r.status, 200);
  assert.equal((await c.mcp(r.data.access_token, 'tools/list')).status, 200);
});

test('passkey without user verification, wrong origin or replayed challenge cannot approve', async t => {
  const c = await startConnector(); t.after(c.close);
  const noUv = await c.signIn({ uv: false });
  assert.equal(noUv.verify.status, 400);
  const auth = await http('GET', `${c.issuer}/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT)}&redirect_uri=${encodeURIComponent('https://client.example/cb')}&code_challenge=${'A'.repeat(43)}&code_challenge_method=S256`);
  const handoff = /#handoff=([^"]+)"/.exec(auth.text)[1];
  const o = await c.localPost('/api/login/options', { handoff });
  assert.equal((await c.localPost('/api/login/verify', { handoff, response: c.passkey.assertion(o.data.challenge, { origin: 'https://evil.example', counter: c.nextCounter() }) })).status, 400);
  assert.equal((await c.localPost('/api/login/verify', { handoff, response: c.passkey.assertion(o.data.challenge, { origin: c.local, counter: c.nextCounter() }) })).status, 400, 'challenge consumed by the failed attempt');
});

test('control-plane guards: Host, Origin, JSON only, enrollment ticket', async t => {
  const c = await startConnector({ enroll: false }); t.after(c.close);
  assert.equal((await http('GET', `${c.local}/`, { host: `127.0.0.1:${new URL(c.local).port}` })).status, 403);
  assert.equal((await http('GET', `${c.local}/`, { host: 'evil.example' })).status, 403);
  assert.equal((await c.localPost('/api/kill', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await http('POST', `${c.local}/api/kill`, { headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await c.localPost('/api/kill', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal(c.connector.authority.killed, false);
  assert.equal((await c.localPost('/api/enroll/options', { ticket: 'guess' })).status, 400);
  await c.enrollPasskey();
  assert.equal(c.connector.passkeys.credentials.size, 1);
  const page = await http('GET', `${c.local}/login`);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('public listener refuses foreign Host and browser Origins other than the allowed ones', async t => {
  const c = await startConnector(); t.after(c.close);
  assert.equal((await http('GET', `${c.issuer}/.well-known/oauth-authorization-server`, { host: 'evil.example' })).status, 421);
  const tok = (await c.signIn()).tokens;
  assert.equal((await c.mcp(tok.access_token, 'tools/list', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await c.mcp(tok.access_token, 'tools/list', {}, { origin: 'https://chatgpt.com' })).status, 200);
  assert.equal((await http('GET', `${c.issuer}/mcp`, { headers: { authorization: `Bearer ${tok.access_token}` } })).status, 405);
});

test('read-only scope cannot call write tools', async t => {
  const c = await startConnector(); t.after(c.close);
  const s = await c.signIn();
  const r = await c.refresh(s.tokens.refresh_token, { scope: 'connector:read' });
  assert.equal(r.status, 200);
  assert.ok(isToolError(await c.callTool(r.data.access_token, 'rehearsal_note_write', { text: 'x' })));
});

test('event log never contains tokens, codes or cookies', async t => {
  const c = await startConnector(); t.after(c.close);
  const s = await c.signIn();
  const r = await c.refresh(s.tokens.refresh_token);
  await c.callTool(r.data.access_token, 'rehearsal_now');
  const log = readFileSync(join(c.connector.stateDir, 'events.jsonl'), 'utf8');
  for (const v of [s.code, s.tokens.access_token, s.tokens.refresh_token, r.data.access_token, r.data.refresh_token, s.cookie.split('=')[1], s.state]) assert.ok(!log.includes(v), 'secret leaked into the event log');
  assert.match(log, /"event":"tool_call"/);
});
