import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ambientesFalsos, dadosPadrao, config, conectarMcp } from './apoio.mjs';
import { startConnector } from './oauth-apoio.mjs';
import { thread, projecao, mensagem } from './fixtures.mjs';
import { memoryJournal } from './escrita-fixtures.mjs';
import { t3Tools } from '../src/oauth/t3-tools.mjs';
import { loadOAuthConfig } from '../src/oauth/config.mjs';
import { carregarConfigOAuthAll, validarConfigOAuthAll, assertEnvironmentParity, consentAll, liveReadContext } from '../src/oauth/project-policy.mjs';
import { carregarConfig, validarConfig } from '../src/config.mjs';
import { SessionAuthority } from '../src/oauth/session-authority.mjs';
import { sessionWrites } from '../src/oauth/session-writes.mjs';
import { ACTIONS } from '../src/escrita/adapters.mjs';

const body = r => JSON.parse(r.data.result.content[0].text);
const invokes = c => c.calls.filter(x => x.method).length;
async function fixture(t, { empty = false } = {}) {
  const data = dadosPadrao(), reads = ambientesFalsos(data), journal = { ...memoryJournal(), audit() {} };
  const connections = reads.registros.map(r => {
    const d = data[r.alias]; if (empty) d.shell = { projects: [], threads: [] };
    const c = { registro: { ...r, destination: `t3://${r.environmentId}`, acoes: ACTIONS }, calls: [],
      inventario: async () => { throw new Error('all login must not snapshot inventory'); },
      cliente: async () => ({ shell: async () => { await c.inventoryHook?.(); if (c.offline) throw new Error('ambiente_indisponivel'); return structuredClone(d.shell); } }),
      adapter: { prepare: async () => { c.calls.push('prepare'); await c.prepareHook?.(); }, invoke: async (method, payload) => { c.calls.push({ method, payload }); return { sequence: 1 }; }, receipt: r => r, verifyWorkspace: async (path, roots) => { await c.workspaceHook?.(); return roots.includes(path); }, reconcile: async r => ({ found: !!r.receipt, state: 'unknown' }) }, fechar() {} };
    return c;
  });
  const c = await startConnector({ tools: t3Tools({ ambientes: reads, conexoes: connections, journal, projectPolicy: 'all' }) }); t.after(c.close);
  const add = (alias, id = `new-${alias}`) => {
    const d = data[alias]; d.shell.projects.push({ id, title: id, workspaceRoot: `/${alias}/${id}` });
    d.shell.threads.push(thread({ id: `t-${id}`, projectId: id, title: id, latestRunId: null, status: 'idle', pendingRuntimeRequest: { id: 'req', kind: 'user_input' } }));
    d.bounded[`t-${id}`] = { projection: projecao({ mensagens: [mensagem({ text: `message-${id}` })], runs: [] }), hasMoreHistory: false };
    return id;
  };
  const send = (at, env, id, op = `op-${env}-${id}`) => c.callTool(at, 't3_escrever_thread_send', { environment: env, operationId: op, input: { threadId: `t-${id}`, text: 'hello', clientRequestId: op, delivery: 'start_immediately' } });
  return { c, data, reads, connections, journal, add, send };
}

test('all: same sign-in reads every tool and writes projects created later in both environments; stdio refuses', async t => {
  const f = await fixture(t); const s = await f.c.signIn(), at = s.tokens.access_token;
  assert.equal(s.view.data.writes.projectPolicy, 'all');
  assert.match(s.view.data.writes.consent, /current and future.*included automatically.*one hour.*revoked locally/);
  assert.deepEqual(s.view.data.writes.environments.map(e => e.projects), [undefined, undefined]);
  const grants = f.c.connector.authority.check(f.c.connector.tokens.resolveAccess(at).sid).grants;
  assert.equal(grants.projectPolicy, 'all'); assert.ok(Object.isFrozen(grants));
  assert.ok(grants.environments.every(e => !('projects' in e) && !('readProjectIds' in e)));
  const legacy = await conectarMcp(f.reads); t.after(() => legacy.close());
  for (const cx of f.connections) {
    const env = cx.registro.alias, id = f.add(env);
    assert.ok(body(await f.c.callTool(at, 't3_projetos', { environment: env })).projects.some(p => p.projectId === id));
    assert.equal(body(await f.c.callTool(at, 't3_threads', { environment: env, projectId: id, includeNoRun: true })).threads[0].threadId, `t-${id}`);
    assert.ok(body(await f.c.callTool(at, 't3_buscar_threads', { environment: env, threadId: `t-${id}` })).threads.length);
    assert.ok(body(await f.c.callTool(at, 't3_atencao', { environment: env })).threads.some(x => x.threadId === `t-${id}`));
    assert.equal(body(await f.c.callTool(at, 't3_thread', { environment: env, threadId: `t-${id}` })).threadId, `t-${id}`);
    assert.match(body(await f.c.callTool(at, 't3_mensagens', { environment: env, threadId: `t-${id}` })).messages[0].text, /message/);
    assert.equal(body(await f.c.callTool(at, 't3_aguardar_thread', { environment: env, threadId: `t-${id}`, timeoutMs: 100 })).threadId, `t-${id}`);
    assert.equal(body(await f.send(at, env, id)).state, 'completed'); assert.equal(invokes(cx), 1);
    assert.equal((await legacy.callTool({ name: 't3_thread', arguments: { environment: env, threadId: `t-${id}` } })).isError, true);
  }
  assert.equal(body(await f.c.callTool(at, 't3_ambientes', { check: true })).environments.length, 2);
  assert.deepEqual(f.c.connector.authority.check(f.c.connector.tokens.resolveAccess(at).sid).grants, grants);
});

test('all: empty inventory and offline host at login recover within the same session', async t => {
  const f = await fixture(t, { empty: true }); f.connections[1].offline = true;
  const at = (await f.c.signIn()).tokens.access_token;
  assert.equal(body(await f.c.callTool(at, 't3_projetos', { environment: 'local' })).total, 0);
  const id = f.add('remoto'); assert.equal((await f.send(at, 'remoto', id)).data.result.isError, true); assert.equal(invokes(f.connections[1]), 0);
  f.connections[1].offline = false;
  assert.equal(body(await f.send(at, 'remoto', id, 'recovered')).state, 'completed');
  assert.equal(body(await f.c.callTool(at, 't3_projetos', { environment: 'remoto' })).total, 1);
});

test('all: unknown environment, foreign thread and absent/deleted project fail with zero invokes', async t => {
  const f = await fixture(t); const at = (await f.c.signIn()).tokens.access_token; const id = f.add('remoto');
  for (const env of ['unknown', 'local']) assert.equal((await f.send(at, env, id)).data.result.isError, true);
  for (const name of ['t3_thread', 't3_mensagens', 't3_aguardar_thread']) assert.equal((await f.c.callTool(at, name, { environment: 'local', threadId: `t-${id}`, ...(name.includes('aguardar') ? { timeoutMs: 100 } : {}) })).data.result.isError, true);
  f.data.remoto.shell.projects.find(p => p.id === id).deletedAt = 'now';
  assert.equal((await f.send(at, 'remoto', id, 'deleted')).data.result.isError, true);
  assert.equal(body(await f.c.callTool(at, 't3_buscar_threads', { threadId: `t-${id}` })).total, 0);
  assert.equal(f.connections.reduce((n, c) => n + invokes(c), 0), 0);
});

for (const change of ['delete-project', 'move-thread', 'delete-thread', 'change-root']) test(`all: ${change} during prepare is refused before invoke`, async t => {
  const f = await fixture(t); const id = f.add('local'), cx = f.connections[0]; const at = (await f.c.signIn()).tokens.access_token;
  cx.prepareHook = () => {
    const p = f.data.local.shell.projects.find(p => p.id === id), th = f.data.local.shell.threads.find(x => x.id === `t-${id}`);
    if (change === 'delete-project') p.deletedAt = 'now';
    if (change === 'move-thread') th.projectId = f.data.local.shell.projects[0].id;
    if (change === 'delete-thread') th.deletedAt = 'now';
    if (change === 'change-root') p.workspaceRoot = '/different';
  };
  const res = change === 'change-root' ? await f.c.callTool(at, 't3_escrever_thread_launch', { environment: 'local', operationId: 'launch', input: { projectId: id, title: 'new', modelSelection: { instanceId: 'codex', model: 'test' }, workspaceStrategy: { type: 'existing_worktree', worktreePath: `/local/${id}` } } }) : await f.send(at, 'local', id);
  assert.equal(res.data.result.isError, true); assert.equal(invokes(cx), 0);
});

for (const phase of ['inventory', 'prepare']) for (const end of ['revoke', 'idle', 'kill']) test(`all: ${end} during ${phase} stops invocation and invalidates tokens`, async t => {
  const f = await fixture(t); const id = f.add('local'); const tokens = (await f.c.signIn()).tokens;
  const stop = () => { if (end === 'idle') f.c.advance(3600_000); else if (end === 'kill') f.c.connector.killSwitch.on(); else f.c.connector.authority.revokeAll(); };
  f.connections[0][phase === 'inventory' ? 'inventoryHook' : 'prepareHook'] = stop;
  assert.equal((await f.send(tokens.access_token, 'local', id)).data.result.isError, true); assert.equal(invokes(f.connections[0]), 0);
  assert.equal((await f.c.mcp(tokens.access_token, 'tools/list')).status, 401);
  assert.equal((await f.c.refresh(tokens.refresh_token)).status, 400);
});

test('all: dedupe/conflict and historical reconcile survive deletion without inventory; subjects stay isolated', async t => {
  const f = await fixture(t); const id = f.add('local'); const s = await f.c.signIn(), at = s.tokens.access_token;
  assert.equal(body(await f.send(at, 'local', id)).state, 'completed');
  f.data.local.shell.projects = []; f.connections[0].inventoryHook = () => { throw new Error('must not read inventory'); };
  assert.equal(body(await f.send(at, 'local', id)).state, 'completed'); assert.equal(invokes(f.connections[0]), 1);
  const refreshed = (await f.c.refresh(s.tokens.refresh_token)).data;
  assert.equal(body(await f.send(refreshed.access_token, 'local', id)).state, 'completed');
  const fresh = (await f.c.signIn()).tokens;
  assert.equal(body(await f.send(fresh.access_token, 'local', id)).state, 'completed');
  assert.equal(invokes(f.connections[0]), 1);
  const op = `op-local-${id}`;
  const conflict = await f.c.callTool(at, 't3_escrever_thread_send', { environment: 'local', operationId: op, input: { threadId: `t-${id}`, text: 'changed', clientRequestId: op, delivery: 'start_immediately' } });
  assert.match(conflict.data.result.content[0].text, /operation_conflict/);
  assert.equal(body(await f.c.callTool(at, 't3_reconciliar_escrita', { environment: 'local', operationId: op })).state, 'completed');
  const sid = f.c.connector.tokens.resolveAccess(at).sid, grants = f.c.connector.authority.check(sid).grants;
  const otherSid = f.c.connector.authority.create({ sub: 'local:otherSubject001', clientId: 'c', credentialId: 'k', scope: 'connector:write', resource: 'r', grants });
  const w = sessionWrites({ conexoes: f.connections, journal: f.journal, authority: f.c.connector.authority, issuer: f.c.issuer, projectPolicy: 'all' });
  await assert.rejects(w.reconcile({ sid: otherSid, sub: 'local:otherSubject001' }, { environment: 'local', operationId: op }), /operation_unknown/);
});

test('OAuth loader ignores ACL only in all; file unchanged; parser and parity fail closed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-all-config-')); t.after(() => rm(dir, { recursive: true })); const file = join(dir, 'read.json');
  const raw = { environments: { polaris: { environmentId: 'env-p', url: 'http://127.0.0.1:3773', tokenFile: '/tmp/token', allowedProjects: ['fleet'] } } }; const text = JSON.stringify(raw); await writeFile(file, text);
  assert.deepEqual((await carregarConfigOAuthAll(file)).ambientes[0].projetosPermitidos, []);
  assert.deepEqual((await carregarConfig(file)).ambientes[0].projetosPermitidos, ['fleet']); assert.equal(await readFile(file, 'utf8'), text);
  delete raw.environments.polaris.allowedProjects; assert.doesNotThrow(() => validarConfigOAuthAll(raw)); assert.throws(() => validarConfig(raw), /allowedProjects/);
  const env = { T3_CONNECTOR_OAUTH_ISSUER: 'https://as.example', T3_CONNECTOR_OAUTH_PROJECTS: 'all' };
  assert.equal(loadOAuthConfig(env).projectPolicy, 'all'); assert.throws(() => loadOAuthConfig({ ...env, T3_CONNECTOR_OAUTH_WRITE_PROJECTS: 'polaris:fleet' }), /conflicts/);
  assert.throws(() => loadOAuthConfig({ ...env, T3_CONNECTOR_OAUTH_PROJECTS: '*' }), /all or restricted/);
  const rs = config().ambientes;
  for (const field of ['alias', 'environmentId', 'destination']) assert.throws(() => assertEnvironmentParity(rs, rs.map((r, i) => i ? r : { ...r, [field]: 'changed' })), /must match/);
  assert.throws(() => t3Tools({ ambientes: ambientesFalsos(), conexoes: [], projectPolicy: 'all' }), /must match/);
});

for (const scope of ['connector:read', 'connector:write']) test(`all: ${scope} consent includes environments and scopes limit tools`, async t => {
  const f = await fixture(t); const s = await f.c.signIn({ scope }); const id = f.add('local');
  assert.equal(s.view.data.scope, scope); assert.equal(s.view.data.writes.projectPolicy, 'all'); assert.equal(s.view.data.writes.environments.length, 2);
  const write = await f.send(s.tokens.access_token, 'local', id), read = await f.c.callTool(s.tokens.access_token, 't3_projetos', { environment: 'local' });
  assert.equal(write.data.result.isError === true, scope === 'connector:read'); assert.equal(read.data.result.isError === true, scope === 'connector:write');
});

test('all: concurrent sessions/calls isolate inventory observations and destinations', async t => {
  const f = await fixture(t); const a = (await f.c.signIn()).tokens, b = (await f.c.signIn()).tokens;
  const p = f.add('local'), s = f.add('remoto');
  let resume, started; const entered = new Promise(resolve => { started = resolve; }); const held = new Promise(resolve => { resume = resolve; });
  f.connections[0].inventoryHook = async () => { started(); await held; };
  const pending = f.send(a.access_token, 'local', p, 'a'); await entered;
  assert.equal(body(await f.send(b.access_token, 'remoto', s, 'b')).state, 'completed');
  assert.equal(body(await f.c.callTool(b.access_token, 't3_threads', { environment: 'remoto', projectId: s, includeNoRun: true })).threads[0].project.projectId, s);
  f.data.local.shell.projects.find(x => x.id === p).deletedAt = 'now'; resume();
  assert.equal((await pending).data.result.isError, true); assert.equal(invokes(f.connections[0]), 0); assert.equal(invokes(f.connections[1]), 1);
});

test('all: read identity mismatch never exposes projections; write mismatch never invokes', async t => {
  const f = await fixture(t); const at = (await f.c.signIn()).tokens.access_token; const p = f.add('local');
  f.data.local.descritor.environmentId = 'another-host';
  assert.equal((await f.c.callTool(at, 't3_mensagens', { environment: 'local', threadId: `t-${p}` })).data.result.isError, true);
  f.connections[0].cliente = async () => { throw new Error('environment_mismatch'); };
  assert.equal((await f.send(at, 'local', p)).data.result.isError, true); assert.equal(invokes(f.connections[0]), 0);
});

for (const action of ['thread_fork', 'thread_merge_back']) test(`all: ${action} validates every reference in the chosen host`, async t => {
  const f = await fixture(t); const p = f.add('local'), s = f.add('remoto'); const at = (await f.c.signIn()).tokens.access_token;
  const input = { sourceThreadId: `t-${p}`, sourcePoint: { type: 'latest_stable' }, ...(action === 'thread_merge_back' ? { targetThreadId: `t-${s}` } : {}) };
  if (action === 'thread_fork') f.connections[0].prepareHook = () => { f.data.local.shell.threads.find(t => t.id === `t-${p}`).projectId = 'missing'; };
  const r = await f.c.callTool(at, `t3_escrever_${action}`, { environment: 'local', operationId: action, input });
  assert.equal(r.data.result.isError, true); assert.equal(invokes(f.connections[0]), 0); assert.equal(invokes(f.connections[1]), 0);
});

for (const failure of ['reserve', 'uncertain', 'audit', 'invoke', 'receipt']) test(`all: ${failure} failure fails closed without a resend`, async t => {
  const f = await fixture(t); const id = f.add('local'); const a = (await f.c.signIn()).tokens, b = (await f.c.signIn()).tokens;
  if (failure === 'reserve') f.journal.reserve = () => { throw new Error('disk'); };
  if (failure === 'uncertain') { const put = f.journal.put; f.journal.put = (k, v) => { if (v.state === 'uncertain') throw new Error('disk'); return put(k, v); }; }
  if (failure === 'audit') f.journal.audit = () => { throw new Error('disk'); };
  if (failure === 'invoke') f.connections[0].adapter.invoke = async () => { f.connections[0].calls.push({ method: 'failed' }); throw new Error('transport'); };
  if (failure === 'receipt') f.connections[0].adapter.receipt = () => { throw new Error('bad receipt'); };
  assert.equal((await f.send(a.access_token, 'local', id)).data.result.isError, true);
  assert.ok(invokes(f.connections[0]) <= 1); assert.equal((await f.c.mcp(b.access_token, 'tools/list')).status, 401);
  await f.send(a.access_token, 'local', id); assert.ok(invokes(f.connections[0]) <= 1);
});

for (const end of ['revoke', 'idle', 'kill']) test(`all: ${end} during a read withholds fetched data`, async t => {
  const f = await fixture(t); const at = (await f.c.signIn()).tokens.access_token; const id = f.add('local');
  const shell = f.data.local.shell;
  f.data.local.shell = async () => { if (end === 'idle') f.c.advance(3600_000); else if (end === 'kill') f.c.connector.killSwitch.on(); else f.c.connector.authority.revokeAll(); return shell; };
  const r = await f.c.callTool(at, 't3_mensagens', { environment: 'local', threadId: `t-${id}` });
  assert.equal(r.data.result.isError, true); assert.doesNotMatch(r.data.result.content[0].text, /message-new-local/);
});

test('all: read-only deployment consents without a write connection', async t => {
  const c = await startConnector({ tools: t3Tools({ ambientes: ambientesFalsos(), projectPolicy: 'all' }) }); t.after(c.close);
  const s = await c.signIn({ scope: 'connector:read' }); assert.equal(s.view.data.writes.environments.length, 2);
  assert.equal(body(await c.callTool(s.tokens.access_token, 't3_ambientes', { check: false })).environments.length, 2);
});

test('all: mutation during workspace canonicalization fails the final live validation', async t => {
  const f = await fixture(t); const p = f.add('local'), cx = f.connections[0]; const at = (await f.c.signIn()).tokens.access_token;
  let checks = 0; cx.workspaceHook = () => { if (++checks === 2) f.data.local.shell.projects.find(x => x.id === p).workspaceRoot = '/moved'; };
  const r = await f.c.callTool(at, 't3_escrever_thread_launch', { environment: 'local', operationId: 'root-race', input: { projectId: p, title: 'new', modelSelection: { instanceId: 'codex', model: 'test' }, workspaceStrategy: { type: 'existing_worktree', worktreePath: `/local/${p}` } } });
  assert.equal(r.data.result.isError, true); assert.equal(invokes(cx), 0);
});

test('all: nonexistent launch project, changed environment identity/destination require fresh consent', async t => {
  const f = await fixture(t); const p = f.add('local'), cx = f.connections[0]; const at = (await f.c.signIn()).tokens.access_token;
  const launch = await f.c.callTool(at, 't3_escrever_thread_launch', { environment: 'local', operationId: 'missing-project', input: { projectId: 'invented', title: 'new', modelSelection: { instanceId: 'codex', model: 'test' }, workspaceStrategy: { type: 'root' } } });
  assert.equal(launch.data.result.isError, true);
  cx.registro.destination = 't3://another-host';
  assert.equal((await f.send(at, 'local', p)).data.result.isError, true);
  f.reads.registros[0].environmentId = 'new-host';
  assert.equal((await f.c.callTool(at, 't3_projetos', { environment: 'local' })).data.result.isError, true); assert.equal(invokes(cx), 0);
});

test('all: inventory timeout fails closed for the operation without invoking or ending healthy sessions', async () => {
  const authority = new SessionAuthority(), r = { alias: 'local', environmentId: 'env-p', destination: 't3://env-p', acoes: ACTIONS };
  const sub = 'local:testSubject001', sid = authority.create({ sub, clientId: 'c', credentialId: 'k', scope: 'connector:write', resource: 'r', grants: consentAll([r]) });
  let calls = 0;
  const w = sessionWrites({ conexoes: [{ registro: r, cliente: async () => ({ shell: async () => new Promise(() => {}) }), adapter: { invoke: () => { calls++; } } }], journal: { ...memoryJournal(), audit() {} }, authority, issuer: 'https://as.example', projectPolicy: 'all', inventoryMs: 5 });
  const offered = await w.inventory(); assert.equal(offered.grants.projectPolicy, 'all'); assert.equal(offered.grants.environments[0].projects, undefined);
  await assert.rejects(w.dispatch({ sid, sub }, { environment: 'local', action: 'thread.settle', operationId: 'timeout', input: { threadId: 't' } }), /ambiente_indisponivel/);
  assert.equal(calls, 0); assert.doesNotThrow(() => authority.check(sid));
});

test('all: refresh/list/ping preserve policy and do not extend idle; admitted refused tools retain activity semantics', async t => {
  const f = await fixture(t); let tok = (await f.c.signIn()).tokens;
  const sid = f.c.connector.tokens.resolveAccess(tok.access_token).sid, grants = f.c.connector.authority.check(sid).grants;
  f.c.advance(50 * 60_000); tok = (await f.c.refresh(tok.refresh_token)).data;
  await f.c.mcp(tok.access_token, 'tools/list'); await f.c.mcp(tok.access_token, 'ping');
  assert.deepEqual(f.c.connector.authority.check(sid).grants, grants);
  assert.equal((await f.c.callTool(tok.access_token, 't3_thread', { environment: 'local', threadId: 'absent' })).data.result.isError, true);
  f.c.advance(50 * 60_000); tok = (await f.c.refresh(tok.refresh_token)).data;
  assert.equal((await f.c.mcp(tok.access_token, 'tools/list')).status, 200);
  f.c.advance(10 * 60_000); assert.equal((await f.c.refresh(tok.refresh_token)).status, 400);
});

test('all: simultaneous calls to the same host keep separate scope snapshots', async () => {
  const data = dadosPadrao(), base = ambientesFalsos(data), authority = new SessionAuthority(), grants = consentAll(base.registros);
  const principal = sub => ({ sub, sid: authority.create({ sub, clientId: 'c', credentialId: 'k', scope: 'connector:read', resource: 'r', grants }) });
  const a = liveReadContext(base, authority, principal('local:subjectAAAA01')), b = liveReadContext(base, authority, principal('local:subjectBBBB01'));
  let resume, entered; const started = new Promise(resolve => { entered = resolve; }), pause = new Promise(resolve => { resume = resolve; });
  const first = a.usar(a.resolver('local'), async client => { const shell = await client.shell(); entered(); await pause; return a.resolver('local').escopo.exigirThread(shell, shell.threads[0].id); });
  await started; data.local.shell = { projects: [], threads: [] };
  const second = await b.usar(b.resolver('local'), async client => { const shell = await client.shell(); return b.resolver('local').escopo.threadsVisiveis(shell); });
  assert.deepEqual(second, []); resume(); assert.ok((await first).id); base.fechar();
});
