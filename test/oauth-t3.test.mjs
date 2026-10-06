import test from 'node:test';
import assert from 'node:assert/strict';
import { startConnector } from './oauth-apoio.mjs';
import { ambientesFalsos } from './apoio.mjs';
import { memoryJournal } from './escrita-fixtures.mjs';
import { t3Tools, parseWriteProjects } from '../src/oauth/t3-tools.mjs';
import { SessionWriteGate, writeToolName, sessionWrites } from '../src/oauth/session-writes.mjs';
import { SessionAuthority } from '../src/oauth/session-authority.mjs';
import { ACTIONS } from '../src/escrita/adapters.mjs';
import { identidadeCanal, identidadeSessaoOAuth } from '../src/escrita/identidade.mjs';
import { Dispatcher } from '../src/escrita/adapters.mjs';

// Same shape as the fake write connection of escrita-controller.test.mjs: two environments with the
// same project and thread IDs, so routing must keep them apart.
function conexaoFalsa(alias, environmentId, { projetos = [{ id: 'app', name: 'app', directory: `/${alias}/app` }, { id: 'outro', name: 'outro', directory: `/${alias}/outro` }], threads = { thread: 'app', 't-outro': 'outro' }, falhaInventario = false, prepare } = {}) {
  const calls = [];
  const c = {
    calls, projetos, threads,
    registro: { alias, environmentId, destination: `t3://${environmentId}`, acoes: ['thread.send', 'thread.settle', 'thread.unsettle', 'run.interrupt'] },
    inventario: async () => { if (c.falhaInventario) throw new Error('ambiente_indisponivel'); return c.projetos; },
    adapter: { prepare: async () => { calls.push('prepare'); await prepare?.(); }, projectForThread: async id => c.threads[id], invoke: async (m, p) => { calls.push({ m, p }); return { sequence: calls.length }; }, receipt: r => ({ sequence: r.sequence }), reconcile: async r => ({ found: r.state === 'completed', state: 'unknown' }) },
    falhaInventario, fechar() {},
  };
  return c;
}

async function montar({ local = {}, remoto = {}, journal = { ...memoryJournal(), audit: () => {} }, writeProjects = null } = {}) {
  const l = conexaoFalsa('local', 'env-p', local), r = conexaoFalsa('remoto', 'env-s', remoto);
  const c = await startConnector({ tools: t3Tools({ ambientes: ambientesFalsos(), conexoes: [l, r], journal, writeProjects, projectPolicy: 'restricted' }) });
  const data = res => JSON.parse(res.data.result.content[0].text);
  const send = (at, { environment = 'local', id = 'op-1', text = 'hi', threadId = 'thread' } = {}) => c.callTool(at, writeToolName('thread.send'), { environment, operationId: id, input: { threadId, text, clientRequestId: id, delivery: 'start_immediately' } });
  return { c, l, r, data, send, journal };
}

test('catalog: the read tools plus the write catalog without leaseId; no lease approval tool', async t => {
  const { c } = await montar(); t.after(c.close);
  const tok = (await c.signIn()).tokens;
  const tools = (await c.mcp(tok.access_token, 'tools/list')).data.result.tools;
  const names = tools.map(x => x.name);
  for (const n of ['t3_ambientes', 't3_projetos', 't3_threads', 't3_buscar_threads', 't3_atencao', 't3_thread', 't3_mensagens', 't3_aguardar_thread']) assert.ok(names.includes(n), n);
  for (const a of ACTIONS) assert.ok(names.includes(writeToolName(a)), a);
  assert.ok(names.includes('t3_reconciliar_escrita'));
  assert.ok(!names.includes('t3_pedir_aprovacao'));
  for (const tool of tools.filter(x => x.name.startsWith('t3_escrever_'))) {
    assert.equal(tool.inputSchema.properties.leaseId, undefined);
    assert.deepEqual(tool.inputSchema.required.sort(), ['environment', 'input', 'operationId']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.doesNotMatch(tool.description, /\blease\b|60.min/i);
  }
  assert.equal(new Set(names).size, names.length);
});

test('restricted mode: sign-in shows and freezes the write scope; reads and writes work in the same session', async t => {
  const { c, l, r, data, send } = await montar(); t.after(c.close);
  const s = await c.signIn();
  assert.deepEqual(s.view.data.writes.environments.map(e => [e.alias, e.projects]), [['local', ['app', 'outro']], ['remoto', ['app', 'outro']]]);
  const at = s.tokens.access_token;
  const amb = await c.callTool(at, 't3_ambientes', { check: false });
  assert.ok(!amb.data.result.isError, amb.text);
  const w = data(await send(at));
  assert.equal(w.state, 'completed'); assert.equal(w.environment.alias, 'local');
  assert.equal(l.calls.filter(x => x.m).length, 1); assert.equal(r.calls.length, 0);
  const legacy = await c.callTool(at, writeToolName('thread.send'), { ambiente: 'local', operationId: 'op-legacy', input: { threadId: 'thread', text: 'x', clientRequestId: 'op-legacy', delivery: 'start_immediately' } });
  assert.ok(legacy.data.error || legacy.data.result?.isError, 'legacy `ambiente` parameter must be refused');
  assert.equal(l.calls.filter(x => x.m).length, 1);
  const rec = data(await c.callTool(at, 't3_reconciliar_escrita', { environment: 'local', operationId: 'op-1' }));
  assert.equal(rec.state, 'completed');
});

test('write dedupe survives refresh and a new sign-in (stable subject), and nothing is resent', async t => {
  const { c, l, data, send } = await montar(); t.after(c.close);
  const a = (await c.signIn()).tokens;
  data(await send(a.access_token));
  const a2 = (await c.refresh(a.refresh_token)).data;
  assert.equal(data(await send(a2.access_token)).state, 'completed');
  const b = (await c.signIn()).tokens;
  assert.equal(data(await send(b.access_token)).state, 'completed');
  assert.equal(l.calls.filter(x => x.m).length, 1);
  const conflict = await send(b.access_token, { text: 'different' });
  assert.equal(conflict.data.result.isError, true);
});

test('restricted mode: environment unavailable at sign-in gets no grant; projects added later need a new sign-in', async t => {
  const { c, l, r, send } = await montar({ remoto: { falhaInventario: true } }); t.after(c.close);
  const s = await c.signIn();
  assert.deepEqual(s.view.data.writes.unavailable.map(u => [u.alias, u.reason]), [['remoto', 'environment_unavailable']]);
  const at = s.tokens.access_token;
  const denied = await send(at, { environment: 'remoto' });
  assert.match(denied.data.result.content[0].text, /^environment_not_in_lease: .*reconnect/);
  assert.equal(r.calls.length, 0);
  l.projetos.push({ id: 'novo', name: 'novo', directory: '/local/novo' }); l.threads['t-novo'] = 'novo';
  const late = await send(at, { id: 'op-2', threadId: 't-novo' });
  assert.match(late.data.result.content[0].text, /^scope_denied/);
  assert.equal((await c.mcp(at, 'tools/list')).status, 200, 'an out-of-scope target is refused without ending the session');
  assert.equal(l.calls.filter(x => x.m).length, 0);
  const fresh = (await c.signIn()).tokens;
  const ok = await send(fresh.access_token, { id: 'op-3', threadId: 't-novo' });
  assert.equal(JSON.parse(ok.data.result.content[0].text).state, 'completed');
});

test('session revoked during preflight: the final check stops the send', async t => {
  let revoke;
  const { c, l, send } = await montar({ local: { prepare: () => revoke() } }); t.after(c.close);
  const tok = (await c.signIn()).tokens;
  revoke = () => c.connector.authority.revokeAll('test');
  const res = await send(tok.access_token);
  assert.equal(res.data.result.isError, true);
  assert.equal(l.calls.filter(x => x.m).length, 0);
});

test('a write counts as activity; a read-only scope cannot write', async t => {
  const { c, send } = await montar(); t.after(c.close);
  let tok = (await c.signIn()).tokens;
  for (let i = 0; i < 3; i++) { c.advance(50 * 60_000); tok = (await c.refresh(tok.refresh_token)).data; await send(tok.access_token, { id: `op-${i}` }); }
  assert.equal((await c.mcp(tok.access_token, 'tools/list')).status, 200);
  const ro = (await c.refresh(tok.refresh_token, { scope: 'connector:read' })).data;
  const denied = await send(ro.access_token, { id: 'op-ro' });
  assert.match(denied.data.result.content[0].text, /insufficient_scope/);
});

test('journal failure fails closed: every OAuth session ends', async t => {
  const journal = { ...memoryJournal(), audit: () => {} };
  const { c, send } = await montar({ journal }); t.after(c.close);
  const a = (await c.signIn()).tokens, b = (await c.signIn()).tokens;
  journal.reserve = () => { throw new Error('disk'); };
  const res = await send(a.access_token);
  assert.equal(res.data.result.isError, true);
  assert.equal((await c.mcp(b.access_token, 'tools/list')).status, 401);
});

test('SessionWriteGate never accepts lease/channel identities or unknown session ids', () => {
  const authority = new SessionAuthority();
  const grants = { scopeVersion: 2, runtimeMode: 'full-access', environments: [{ alias: 'local', environmentId: 'env-p', label: 'local', destination: 't3://env-p', projects: [{ id: 'app', name: 'app', directory: '/a', workspaceRoots: ['/a'] }], actions: ['thread.send'], readProjectIds: ['app'] }] };
  const sid = authority.create({ sub: 'local:abcdefghijkl', clientId: 'c', credentialId: 'k', scope: 'connector:write', resource: 'r', grants });
  const gate = new SessionWriteGate({ authority, issuer: 'https://as.example' });
  const target = { environmentId: 'env-p', destination: 't3://env-p', projectIds: ['app'], action: 'thread.send' };
  const me = identidadeSessaoOAuth({ issuer: 'https://as.example', subject: 'local:abcdefghijkl' });
  gate.check(me, sid, target);
  assert.throws(() => gate.check(identidadeCanal({ organization: 'o', tunnelId: 'tunnel_x' }), sid, target), /lease_closed/);
  assert.throws(() => gate.check(identidadeSessaoOAuth({ issuer: 'https://other.example', subject: 'local:abcdefghijkl' }), sid, target), /lease_closed/);
  assert.throws(() => gate.check(me, 'lease-id-from-the-gate', target), /lease_closed/);
  assert.throws(() => gate.check(me, sid, { ...target, action: 'thread.delete' }), /scope_denied/);
  assert.throws(() => gate.check(me, sid, { ...target, projectIds: ['secret'] }), /scope_denied/);
  assert.throws(() => identidadeSessaoOAuth({ issuer: 'https://as.example', subject: 'canal:org' }), /oauth_identity_invalid/);
  grants.environments[0].projects.push({ id: 'x' });
  assert.equal(authority.check(sid).grants.environments[0].projects.length, 1, 'caller copy does not alias the session grant');
  assert.throws(() => authority.check(sid).grants.environments[0].projects.push({}), TypeError);
  let sent = false;
  gate.audit = () => authority.revoke(sid);
  assert.throws(() => gate.dispatch(me, sid, target, () => { sent = true; }, 'op'), /lease_closed/);
  assert.equal(sent, false);
});

test('restricted mode: write project allowlist narrows the sign-in grant (sandbox)', async t => {
  const { c, l, r, data, send } = await montar({ writeProjects: parseWriteProjects('local:outro') }); t.after(c.close);
  const s = await c.signIn();
  assert.deepEqual(s.view.data.writes.environments.map(e => [e.alias, e.projects]), [['local', ['outro']]]);
  assert.deepEqual(s.view.data.writes.unavailable.map(u => [u.alias, u.reason]), [['remoto', 'no_projects_allowed']]);
  const at = s.tokens.access_token;
  assert.match((await send(at)).data.result.content[0].text, /^scope_denied/);
  assert.equal(data(await send(at, { id: 'op-2', threadId: 't-outro' })).state, 'completed');
  assert.match((await send(at, { environment: 'remoto', id: 'op-3', threadId: 't-outro' })).data.result.content[0].text, /^environment_not_in_lease/);
  assert.equal(l.calls.filter(x => x.m).length, 1); assert.equal(r.calls.length, 0);
  assert.throws(() => parseWriteProjects('nocolon'), /alias:projectId/);
  assert.equal(parseWriteProjects(''), null);
});

// C1: a write refused before sending is journaled `rejected` without a target.
test('reconcile reports a write refused before sending as rejected, sent:false, without touching the backend', async t => {
  const { c, l, data, send } = await montar(); t.after(c.close);
  const tok = (await c.signIn()).tokens;
  const refused = await send(tok.access_token, { id: 'op-gone', threadId: 'archived-thread' });
  assert.match(refused.data.result.content[0].text, /^thread_not_found/);
  const callsBefore = l.calls.length;
  const rec = data(await c.callTool(tok.access_token, 't3_reconciliar_escrita', { environment: 'local', operationId: 'op-gone' }));
  assert.deepEqual({ state: rec.state, sent: rec.sent, observation: rec.observation, env: rec.environment.alias }, { state: 'rejected', sent: false, observation: null, env: 'local' });
  assert.equal(l.calls.length, callsBefore, 'no prepare/invoke/observation call');
  // after refresh and after a new sign-in (same subject) it still answers
  const t2 = (await c.refresh(tok.refresh_token)).data;
  assert.equal(data(await c.callTool(t2.access_token, 't3_reconciliar_escrita', { environment: 'local', operationId: 'op-gone' })).state, 'rejected');
  const t3 = (await c.signIn()).tokens;
  assert.equal(data(await c.callTool(t3.access_token, 't3_reconciliar_escrita', { environment: 'local', operationId: 'op-gone' })).sent, false);
  // unknown operations and other environments keep the existing errors
  const unknown = await c.callTool(t3.access_token, 't3_reconciliar_escrita', { environment: 'local', operationId: 'never-sent' });
  assert.match(unknown.data.result.content[0].text, /operation_unknown/);
  const otherEnv = await c.callTool(t3.access_token, 't3_reconciliar_escrita', { environment: 'remoto', operationId: 'op-gone' });
  assert.match(otherEnv.data.result.content[0].text, /operation_unknown/);
});

test('another subject cannot see a rejected record; a session without the environment grant is refused', async t => {
  const { c, data, send } = await montar({ remoto: { falhaInventario: true } }); t.after(c.close);
  const tok = (await c.signIn()).tokens;
  await send(tok.access_token, { id: 'op-gone', threadId: 'archived-thread' });
  const { authority, tokens } = c.connector;
  const mint = (sub, grants) => {
    const sid = authority.create({ sub, clientId: 'https://client.example/oauth/client.json', credentialId: 'k', scope: 'connector:read connector:write', resource: `${c.issuer}/mcp`, grants });
    const code = tokens.issueCode({ sid, clientId: 'https://client.example/oauth/client.json', redirectUri: 'r', codeChallenge: 'C', resource: `${c.issuer}/mcp`, scope: 'connector:read connector:write' });
    return tokens.consumeCode(code, { clientId: 'https://client.example/oauth/client.json', verifyPkce: () => true });
  };
  const ownGrants = authority.check(tokens.resolveAccess(tok.access_token).sid).grants;
  const other = mint('local:anotherSubject01', ownGrants);
  assert.match((await c.callTool(other.access_token, 't3_reconciliar_escrita', { environment: 'local', operationId: 'op-gone' })).data.result.content[0].text, /operation_unknown/);
  const noGrant = mint(c.connector.subject, { scopeVersion: 2, runtimeMode: 'full-access', environments: [] });
  assert.match((await c.callTool(noGrant.access_token, 't3_reconciliar_escrita', { environment: 'local', operationId: 'op-gone' })).data.result.content[0].text, /^environment_not_in_lease/);
  assert.equal(data(await c.callTool(tok.access_token, 't3_reconciliar_escrita', { environment: 'local', operationId: 'op-gone' })).state, 'rejected');
});

test('lease path unchanged: Dispatcher.reconcile still refuses a targetless record', async () => {
  const record = { hash: 'h', state: 'rejected', action: 'thread.send', operationId: 'x', environmentId: 'e', destination: 't3://e' };
  const d = new Dispatcher({ gate: {}, adapter: {}, journal: { reserve: () => true, get: () => record, put() {} }, environmentId: 'e', destination: 't3://e' });
  await assert.rejects(d.reconcile(identidadeCanal({ organization: 'o', tunnelId: 'tunnel_x' }), 'lease', 'x'), /reconciliation_target_unknown/);
});

// C3 review regressions for the local rejected answer.
function directWrites({ audit } = {}) {
  const authority = new SessionAuthority();
  const grants = { scopeVersion: 2, runtimeMode: 'full-access', environments: [{ alias: 'local', environmentId: 'env-p', label: 'local', destination: 't3://env-p', projects: [{ id: 'app', name: 'app', directory: '/a', workspaceRoots: ['/a'] }], actions: ['thread.send'], readProjectIds: ['app'] }] };
  const sub = 'local:abcdefghijkl', sid = authority.create({ sub, clientId: 'c', credentialId: 'k', scope: 'connector:write', resource: 'r', grants });
  const records = new Map(), calls = [];
  const journal = { reserve: (k, v) => (records.has(k) ? false : (records.set(k, v), true)), get: k => records.get(k), put: (k, v) => records.set(k, v), audit: e => audit?.(e, { authority, sid }) };
  const conexao = { registro: { alias: 'local', environmentId: 'env-p', destination: 't3://env-p', acoes: ['thread.send'] }, inventario: async () => [], adapter: { projectForThread: async () => undefined, invoke: async () => calls.push('invoke'), receipt: r => r, reconcile: async () => (calls.push('observe'), { found: false }) } };
  const w = sessionWrites({ conexoes: [conexao], journal, authority, issuer: 'https://as.example', audit: e => journal.audit(e) });
  return { w, authority, sid, sub, records, calls, principal: { sid, sub } };
}
const refuse = async d => { await assert.rejects(d.w.dispatch(d.principal, { environment: 'local', action: 'thread.send', operationId: 'op-r', input: { threadId: 'gone', text: 'x', clientRequestId: 'op-r', delivery: 'start_immediately' } }), /thread_not_found/); };

test('local rejected answer: audit failure fails closed with journal_failed and changes nothing', async () => {
  const d = directWrites({ audit: e => { if (e.event === 'reconciled_rejected') throw new Error('disk'); } });
  await refuse(d);
  const snapshot = JSON.stringify([...d.records]);
  await assert.rejects(d.w.reconcile(d.principal, { environment: 'local', operationId: 'op-r' }), /journal_failed/);
  assert.throws(() => d.authority.check(d.sid), /write_path_failure/);
  assert.equal(JSON.stringify([...d.records]), snapshot);
  assert.deepEqual(d.calls, []);
});

test('local rejected answer: a reentrant audit that ends the session withholds the answer', async () => {
  const d = directWrites({ audit: (e, { authority, sid }) => { if (e.event === 'reconciled_rejected') authority.revoke(sid); } });
  await refuse(d);
  await assert.rejects(d.w.reconcile(d.principal, { environment: 'local', operationId: 'op-r' }), /lease_closed/);
});

test('local rejected answer: revoked session, other issuer/subject, anomalous targetless states keep existing errors', async () => {
  const d = directWrites();
  await refuse(d);
  const snapshot = JSON.stringify([...d.records]);
  assert.equal((await d.w.reconcile(d.principal, { environment: 'local', operationId: 'op-r' })).sent, false);
  assert.equal(JSON.stringify([...d.records]), snapshot, 'reconcile does not mutate the journal');
  // a targetless record in any state other than rejected goes to Dispatcher.reconcile (unchanged error)
  const [key, rec] = [...d.records][0];
  for (const state of ['preparing', 'uncertain', 'completed']) {
    d.records.set(key, { ...rec, state });
    await assert.rejects(d.w.reconcile(d.principal, { environment: 'local', operationId: 'op-r' }), /reconciliation_target_unknown/);
  }
  d.records.set(key, rec);
  const other = sessionWrites({ conexoes: [{ registro: { alias: 'local', environmentId: 'env-p', destination: 't3://env-p', acoes: ['thread.send'] }, adapter: {} }], journal: { reserve: () => true, get: k => d.records.get(k), put() {}, audit() {} }, authority: d.authority, issuer: 'https://other.example' });
  await assert.rejects(other.reconcile(d.principal, { environment: 'local', operationId: 'op-r' }), /operation_unknown/);
  d.authority.revoke(d.sid);
  await assert.rejects(d.w.reconcile(d.principal, { environment: 'local', operationId: 'op-r' }), /lease_closed/);
  assert.deepEqual(d.calls, []);
});


test('write gate: an audit that cannot be written ends every session before the error surfaces', async () => {
  const { SessionWriteGate } = await import('../src/oauth/session-writes.mjs');
  const authority = new SessionAuthority();
  const sid = authority.create({ sub: 'local:abcdefghijkl', clientId: 'c', credentialId: 'k', scope: 'connector:write', resource: 'r' });
  const gate = new SessionWriteGate({ authority, issuer: 'https://as.example', audit: () => { throw new Error('disk'); } });
  assert.throws(() => gate.audit({ event: 'project_delete_live_threads' }), /audit_failed/);
  assert.throws(() => authority.check(sid), /write_path_failure/);
});
