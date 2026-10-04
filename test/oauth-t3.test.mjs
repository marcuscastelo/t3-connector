import test from 'node:test';
import assert from 'node:assert/strict';
import { startConnector } from './oauth-apoio.mjs';
import { ambientesFalsos } from './apoio.mjs';
import { memoryJournal } from './escrita-fixtures.mjs';
import { t3Tools } from '../src/oauth/t3-tools.mjs';
import { SessionWriteGate, writeToolName } from '../src/oauth/session-writes.mjs';
import { SessionAuthority } from '../src/oauth/session-authority.mjs';
import { ACTIONS } from '../src/escrita/adapters.mjs';
import { identidadeCanal, identidadeSessaoOAuth } from '../src/escrita/identidade.mjs';

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

async function montar({ local = {}, remoto = {}, journal = { ...memoryJournal(), audit: () => {} } } = {}) {
  const l = conexaoFalsa('local', 'env-p', local), r = conexaoFalsa('remoto', 'env-s', remoto);
  const c = await startConnector({ tools: t3Tools({ ambientes: ambientesFalsos(), conexoes: [l, r], journal }) });
  const data = res => JSON.parse(res.data.result.content[0].text);
  const send = (at, { environment = 'local', id = 'op-1', text = 'hi', threadId = 'thread' } = {}) => c.callTool(at, writeToolName('thread.send'), { environment, operationId: id, input: { threadId, text, clientRequestId: id, delivery: 'start_immediately' } });
  return { c, l, r, data, send, journal };
}

test('catalog: eight read tools plus the write catalog without leaseId; no lease approval tool', async t => {
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

test('sign-in shows and freezes the write scope; reads and writes work in the same session', async t => {
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

test('environment unavailable at sign-in gets no grant; projects added later need a new sign-in', async t => {
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
