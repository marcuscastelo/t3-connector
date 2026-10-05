import test from 'node:test';
import assert from 'node:assert/strict';
import { ambientesFalsos, dadosPadrao } from './apoio.mjs';
import { startConnector } from './oauth-apoio.mjs';
import { memoryJournal } from './escrita-fixtures.mjs';
import { t3Tools } from '../src/oauth/t3-tools.mjs';
import { loadOAuthConfig } from '../src/oauth/config.mjs';
import { ACTIONS, ALL_ACTIONS } from '../src/escrita/adapters.mjs';
import { contarOcupacao, lerOcupacao, guardProjectDelete, PROJECT_ACTIONS } from '../src/escrita/project-admin.mjs';
import { StagingRpcTransport } from '../src/escrita/transport-staging.mjs';
import { sessionWrites } from '../src/oauth/session-writes.mjs';

const body = r => JSON.parse(r.data.result.content[0].text);
const errorText = r => (assert.equal(r.data.result.isError, true), r.data.result.content[0].text);
const ISO = '2026-10-04T00:00:00.000Z';

// Simulated T3 server with the native semantics of commit 8ed276c2: HTTP shell carries only
// active threads; the archived snapshot carries archived ones; project.delete refuses live
// children without force, cascades with force, soft-deletes and replays by commandId.
function simulator(projects, threads) {
  const s = { seq: 1, projects: projects.map(p => ({ title: p.id, workspaceRoot: `/w/${p.id}`, deletedAt: null, ...p })), threads: threads.map(t => ({ archivedAt: null, deletedAt: null, latestRunId: 'r', status: 'completed', pendingRuntimeRequest: null, title: t.id, ...t })), receipts: new Map(), hooks: {} };
  const live = t => !t.deletedAt;
  s.shell = () => ({ snapshotSequence: s.seq, projects: s.projects.filter(p => !p.deletedAt), threads: s.threads.filter(t => live(t) && !t.archivedAt), archivedThreads: [] });
  s.archived = () => ({ snapshotSequence: s.archivedSeq ?? s.seq, projects: [], threads: s.threads.filter(t => live(t) && t.archivedAt) });
  s.addThread = (t) => { s.threads.push({ archivedAt: null, deletedAt: null, latestRunId: null, status: 'idle', pendingRuntimeRequest: null, title: t.id, ...t }); s.seq++; };
  s.liveOrphans = () => s.threads.filter(t => live(t) && s.projects.find(p => p.id === t.projectId)?.deletedAt);
  s.mutate = async (m) => {
    assert.equal(m.type, 'project.delete');
    if (s.receipts.has(m.commandId)) return s.receipts.get(m.commandId);
    const p = s.projects.find(x => x.id === m.projectId);
    if (!p || p.deletedAt) throw new Error('ProjectNotFoundError');
    const children = s.threads.filter(t => live(t) && t.projectId === p.id);
    if (children.length && m.force !== true) throw new Error('ProjectNotEmptyError');
    for (const t of children) t.deletedAt = ISO;
    await s.hooks.beforeProjectCommit?.(); // window between the child snapshot and the project commit
    p.deletedAt = ISO; s.seq++;
    const receipt = { ...p };
    s.receipts.set(m.commandId, receipt);
    return receipt;
  };
  s.launch = async (payload) => {
    // Native launch resolves the project once, then creates the thread without the project lock.
    if (!s.projects.some(p => p.id === payload.projectId && !p.deletedAt)) throw new Error('Project no longer exists.');
    await s.hooks.launchAfterResolve?.();
    s.addThread({ id: payload.threadId, projectId: payload.projectId });
    return { threadId: payload.threadId, projection: {}, resumed: false };
  };
  return s;
}

async function fixture(t, { projects, threads, projectAdmin = true }) {
  const data = dadosPadrao(), reads = ambientesFalsos(data), journal = { ...memoryJournal(), audit(e) { audits.push(e); } }, audits = [];
  const sims = {};
  const connections = reads.registros.map(r => {
    const sim = sims[r.alias] = simulator(projects, threads);
    data[r.alias].shell = () => sim.shell();
    const c = { registro: { ...r, destination: `t3://${r.environmentId}`, acoes: ACTIONS }, calls: [],
      inventario: async () => { throw new Error('all login must not snapshot inventory'); },
      cliente: async () => ({ shell: async () => { await c.onShell?.(); return structuredClone(sim.shell()); } }),
      adapter: {
        prepare: async () => {},
        invoke: async (method, payload) => {
          c.calls.push({ method, payload });
          await c.beforeInvoke?.(method, payload);
          if (method === 'projects.mutate') return sim.mutate(payload);
          if (method === 'orchestration.launchThread') return sim.launch(payload);
          throw new Error('unexpected');
        },
        receipt: r => ('id' in r && 'deletedAt' in r) ? { projectId: r.id, deletedAt: r.deletedAt } : ('threadId' in r ? { threadId: r.threadId, resumed: r.resumed } : { sequence: r.sequence }),
        occupancy: projectId => lerOcupacao({ projectId, readActive: async () => structuredClone(sim.shell()), readArchived: async () => structuredClone(sim.archived()) }),
        verifyWorkspace: async () => true,
        reconcile: async r => ({ found: !!r.receipt, state: 'unknown' }),
      }, fechar() {} };
    return c;
  });
  const c = await startConnector({ tools: t3Tools({ ambientes: reads, conexoes: connections, journal, projectPolicy: 'all', projectAdmin }) }); t.after(c.close);
  const s = await c.signIn(), at = s.tokens.access_token;
  const call = (name, args) => c.callTool(at, name, args);
  const del = (projectId, op = `del-${projectId}`) => call('t3_escrever_project_delete', { environment: 'local', operationId: op, input: { projectId } });
  const force = (input, op = `force-${input.projectId}`) => call('t3_escrever_project_delete_force', { environment: 'local', operationId: op, input });
  const count = projectId => call('t3_contar_threads_projeto', { environment: 'local', projectId });
  const invokes = () => connections[0].calls.filter(x => x.method === 'projects.mutate');
  return { c, s, at, sim: sims.local, cx: connections[0], call, del, force, count, invokes, audits };
}

test('project admin: count is pure, dedupes IDs, excludes deleted and is incomplete on a sequence mismatch', () => {
  const active = { snapshotSequence: 5, threads: [{ id: 'a', projectId: 'p', latestRunId: 'r', status: 'running' }, { id: 'n', projectId: 'p', latestRunId: null, status: 'idle' }, { id: 'x', projectId: 'q', status: 'idle' }, { id: 'd', projectId: 'p', deletedAt: ISO, status: 'idle' }], archivedThreads: [] };
  const archived = { snapshotSequence: 5, threads: [{ id: 'z', projectId: 'p', archivedAt: ISO, latestRunId: null, status: 'idle' }, { id: 'a', projectId: 'p', archivedAt: ISO, status: 'completed' }] };
  assert.deepEqual(contarOcupacao(active, archived, 'p'), { projectId: 'p', complete: true, sequence: 5, total: 3, active: 1, archived: 2, withoutRun: 2, busy: 1 });
  assert.deepEqual(contarOcupacao(active, { ...archived, snapshotSequence: 6 }, 'p'), { projectId: 'p', complete: false, total: null });
  assert.deepEqual(contarOcupacao(active, null, 'p'), { projectId: 'p', complete: false, total: null });
  assert.deepEqual(contarOcupacao({ snapshotSequence: 1, threads: [] }, { snapshotSequence: 1, threads: [] }, 'p').total, 0);
  // Fail closed on any malformed row, even one that might not belong to the project.
  const empty = { snapshotSequence: 1, threads: [] };
  for (const row of [{}, { id: 'r' }, { id: 'r', projectId: 'p' }, { id: 1, projectId: 'p', status: 'idle' }, { id: 'r', projectId: 'p', status: 'idle', archivedAt: 5 }, null, 'x']) {
    assert.deepEqual(contarOcupacao(empty, { snapshotSequence: 1, threads: [row] }, 'p'), { projectId: 'p', complete: false, total: null }, JSON.stringify(row));
    assert.deepEqual(contarOcupacao({ snapshotSequence: 1, threads: [row] }, empty, 'p'), { projectId: 'p', complete: false, total: null });
  }
  assert.equal(contarOcupacao({ ...empty, archivedThreads: 'x' }, empty, 'p').complete, false);
  for (const bad of [{ complete: false, total: null }, undefined]) assert.throws(() => guardProjectDelete('project.delete', { projectId: 'p' }, bad), /project_count_incomplete/);
});

test('project admin: lerOcupacao retries until both reads agree, otherwise never reports zero', async () => {
  let n = 0;
  const ok = await lerOcupacao({ projectId: 'p', readActive: async () => ({ snapshotSequence: 2, threads: [] }), readArchived: async () => ({ snapshotSequence: ++n === 1 ? 1 : 2, threads: [] }) });
  assert.equal(ok.complete, true); assert.equal(ok.total, 0); assert.equal(n, 2);
  const never = await lerOcupacao({ projectId: 'p', readActive: async () => ({ snapshotSequence: 2, threads: [] }), readArchived: async () => ({ snapshotSequence: 1, threads: [] }) });
  assert.deepEqual(never, { projectId: 'p', complete: false, total: null });
});

test('project admin: count tool covers active, archived, no-run and busy threads', async t => {
  const f = await fixture(t, { projects: [{ id: 'p' }, { id: 'q' }], threads: [
    { id: 't1', projectId: 'p', status: 'running' }, { id: 't2', projectId: 'p', archivedAt: ISO, latestRunId: null, status: 'idle' },
    { id: 't3', projectId: 'p', latestRunId: null, status: 'idle', pendingRuntimeRequest: { id: 'r', kind: 'user_input' } }, { id: 't4', projectId: 'p', deletedAt: ISO }, { id: 't5', projectId: 'q' }] });
  const c = body(await f.count('p'));
  assert.deepEqual({ complete: c.complete, total: c.total, active: c.active, archived: c.archived, withoutRun: c.withoutRun, busy: c.busy }, { complete: true, total: 3, active: 2, archived: 1, withoutRun: 2, busy: 2 });
  assert.match(errorText(await f.count('missing')), /scope_denied/);
  f.sim.archivedSeq = 999; // reads that never agree
  const partial = body(await f.count('p'));
  assert.equal(partial.complete, false); assert.equal(partial.total, null);
});

test('project admin: delete of an empty project sends force:false once, with a stable commandId, and reports a clean post-check', async t => {
  const f = await fixture(t, { projects: [{ id: 'empty' }, { id: 'p' }], threads: [{ id: 't1', projectId: 'p' }] });
  const r = body(await f.del('empty'));
  assert.equal(r.state, 'completed'); assert.equal(r.receipt.projectId, 'empty'); assert.equal(r.receipt.deletedAt, ISO);
  assert.equal(r.postCheck, 'clean'); assert.equal(r.liveThreadsAfterDelete, 0);
  const [sent] = f.invokes();
  assert.deepEqual(Object.keys(sent.payload).sort(), ['commandId', 'force', 'projectId', 'type']);
  assert.equal(sent.payload.force, false); assert.equal(sent.payload.type, 'project.delete');
  assert.match(sent.payload.commandId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(f.sim.projects.find(p => p.id === 'empty').deletedAt, ISO);
  // Same operation again: journal receipt, no second mutation.
  const again = body(await f.del('empty'));
  assert.equal(again.state, 'completed'); assert.equal(again.reconciliationRequired, false); assert.equal(f.invokes().length, 1);
  assert.deepEqual(again.receipt, r.receipt); assert.equal(again.postCheck, 'clean');
  // Same operationId, different target: conflict, nothing sent.
  assert.match(errorText(await f.del('p', 'del-empty')), /operation_conflict/); assert.equal(f.invokes().length, 1);
  // The deleted project left the live inventory: a new operation on it is outside the scope.
  assert.match(errorText(await f.del('empty', 'del-empty-2')), /scope_denied/); assert.equal(f.invokes().length, 1);
});

test('project admin: delete without force refuses any live thread (active, archived-only, no-run-only) and never escalates', async t => {
  const f = await fixture(t, { projects: [{ id: 'act' }, { id: 'arc' }, { id: 'norun' }], threads: [
    { id: 'a', projectId: 'act' }, { id: 'b', projectId: 'arc', archivedAt: ISO }, { id: 'c', projectId: 'norun', latestRunId: null, status: 'idle' }] });
  for (const p of ['act', 'arc', 'norun']) assert.match(errorText(await f.del(p)), /project_not_empty/);
  assert.equal(f.invokes().length, 0);
  assert.ok(f.sim.projects.every(p => !p.deletedAt)); assert.ok(f.sim.threads.every(t => !t.deletedAt));
  // An incomplete count blocks too, with nothing sent.
  f.sim.archivedSeq = 999;
  f.sim.projects.push({ id: 'e2', title: 'e2', workspaceRoot: '/w/e2', deletedAt: null });
  assert.match(errorText(await f.del('e2')), /project_count_incomplete/); assert.equal(f.invokes().length, 0);
});

test('project admin: force requires literal true, confirmation and the current count; refuses busy threads', async t => {
  const f = await fixture(t, { projects: [{ id: 'p' }, { id: 'busy' }], threads: [
    { id: 'a', projectId: 'p' }, { id: 'b', projectId: 'p', archivedAt: ISO, latestRunId: null, status: 'idle' }, { id: 'c', projectId: 'busy', status: 'running' }] });
  const good = { projectId: 'p', force: true, confirmProjectId: 'p', expectedThreadCount: 2 };
  for (const [input, re, op] of [
    [{ projectId: 'p', confirmProjectId: 'p', expectedThreadCount: 2 }, /write_rejected|invalid|force/i, 'f1'],
    [{ ...good, force: 'true' }, /write_rejected|invalid|force/i, 'f2'],
    [{ ...good, confirmProjectId: 'busy' }, /project_confirmation_mismatch/, 'f3'],
    [{ ...good, expectedThreadCount: 1 }, /project_count_changed/, 'f4'],
    [{ projectId: 'busy', force: true, confirmProjectId: 'busy', expectedThreadCount: 1 }, /project_has_active_work/, 'f5'],
  ]) assert.match(errorText(await f.force(input, op)), re);
  assert.equal(f.invokes().length, 0);
  // Plain delete never turns into force.
  assert.match(errorText(await f.del('p')), /project_not_empty/); assert.equal(f.invokes().length, 0);
  // A thread created while the connector validates the target (after any earlier count) is
  // still caught: the count is the last read before the send.
  let reads = 0;
  f.cx.onShell = () => { if (++reads === 2) f.sim.addThread({ id: 'late', projectId: 'p', latestRunId: null }); };
  assert.match(errorText(await f.force(good, 'f-late')), /project_count_changed/); assert.equal(f.invokes().length, 0);
  f.cx.onShell = null; f.sim.threads.find(t => t.id === 'late').deletedAt = ISO;
  const r = body(await f.force(good, 'f-ok'));
  assert.equal(r.state, 'completed'); assert.equal(r.postCheck, 'clean'); assert.equal(f.invokes()[0].payload.force, true);
  assert.ok(f.sim.threads.filter(t => t.projectId === 'p').every(t => t.deletedAt === ISO));
  assert.deepEqual(f.sim.liveOrphans(), []);
  assert.ok(!f.sim.projects.find(p => p.id === 'busy').deletedAt);
});

test('project admin: off by default; opt-in tools, consent text and config validation', async t => {
  const off = await fixture(t, { projects: [{ id: 'empty' }], threads: [], projectAdmin: false });
  const names = body2 => body2.data.result.tools.map(x => x.name);
  const listOff = names(await off.c.mcp(off.at, 'tools/list'));
  assert.ok(!listOff.some(n => /project_delete|contar_threads_projeto/.test(n)));
  assert.doesNotMatch(off.s.view.data.writes.consent, /deleting projects/);
  const on = await fixture(t, { projects: [{ id: 'empty' }], threads: [] });
  const listOn = names(await on.c.mcp(on.at, 'tools/list'));
  for (const n of ['t3_escrever_project_delete', 't3_escrever_project_delete_force', 't3_contar_threads_projeto']) assert.ok(listOn.includes(n), n);
  assert.match(on.s.view.data.writes.consent, /deleting projects/);
  assert.equal(listOn.length - listOff.length, 3);
  // Existing catalogs are untouched: ACTIONS has no project action.
  assert.ok(!ACTIONS.some(a => PROJECT_ACTIONS.includes(a))); assert.ok(PROJECT_ACTIONS.every(a => ALL_ACTIONS.includes(a)));
  const base = { T3_CONNECTOR_OAUTH_ISSUER: 'https://c.example' };
  assert.equal(loadOAuthConfig(base).projectAdmin, false);
  assert.equal(loadOAuthConfig({ ...base, T3_CONNECTOR_OAUTH_PROJECTS: 'all', T3_CONNECTOR_OAUTH_PROJECT_ADMIN: '1' }).projectAdmin, true);
  assert.equal(loadOAuthConfig({ ...base, T3_CONNECTOR_OAUTH_PROJECTS: 'all', T3_CONNECTOR_OAUTH_PROJECT_ADMIN: 'true' }).projectAdmin, false);
  assert.throws(() => loadOAuthConfig({ ...base, T3_CONNECTOR_OAUTH_PROJECT_ADMIN: '1' }), /requires T3_CONNECTOR_OAUTH_PROJECTS=all/);
});

test('project admin concurrency: connector launch and delete of the same project serialize; no live thread on a deleted project', async t => {
  for (const order of ['launch-first', 'delete-first']) {
    const f = await fixture(t, { projects: [{ id: 'p' }], threads: [] });
    let open; const gate = new Promise(r => { open = r; });
    const first = order === 'launch-first' ? 'orchestration.launchThread' : 'projects.mutate';
    f.cx.beforeInvoke = async (method) => { if (method === first) await gate; };
    const launch = () => f.call('t3_escrever_thread_launch', { environment: 'local', operationId: `l-${order}`, input: { projectId: 'p', title: 'x', workspaceStrategy: { type: 'root' }, modelSelection: { instanceId: 'codex', model: 'm' } } });
    const del = () => f.del('p', `d-${order}`);
    // The first operation reaches T3 and is held there; the second starts while it is in flight.
    const a = (order === 'launch-first' ? launch : del)();
    while (!f.cx.calls.some(x => x.method === first)) await new Promise(r => setTimeout(r, 2));
    const b = (order === 'launch-first' ? del : launch)();
    await new Promise(r => setTimeout(r, 30));
    // The second operation is held by the connector's project lock, not sent to T3.
    assert.equal(f.cx.calls.filter(x => x.method).length, 1, order);
    open();
    const [ra, rb] = await Promise.all([a, b]);
    assert.notEqual(ra.data.result.isError, true, `${order}: ${ra.data.result.content[0].text}`);
    assert.match(errorText(rb), order === 'launch-first' ? /project_not_empty/ : /scope_denied/, order);
    assert.deepEqual(f.sim.liveOrphans(), [], order);
  }
});

test('project admin concurrency: another client creating a thread between the guard and the send is refused natively (force:false)', async t => {
  const f = await fixture(t, { projects: [{ id: 'p' }], threads: [] });
  f.cx.beforeInvoke = async (method) => { if (method === 'projects.mutate') f.sim.addThread({ id: 'foreign', projectId: 'p' }); };
  // The native refusal of a send is uncertain for the connector: it fails closed (no retry,
  // sessions end) exactly like any other uncertain send.
  assert.match(errorText(await f.del('p')), /reconciliation_required|session_expired/);
  assert.equal(f.invokes().length, 1); assert.equal(f.sim.projects[0].deletedAt, null); assert.deepEqual(f.sim.liveOrphans(), []);
});

test('project admin concurrency: a thread created inside the backend delete window is reported, not hidden (backend limit)', async t => {
  // Models ProjectService.deleteChildThreads reading outside the project lock and thread.create not
  // checking the project: the backend can leave a live thread on a deleted project. The connector
  // cannot prevent another client from doing this; it must report it.
  const f = await fixture(t, { projects: [{ id: 'p' }], threads: [] });
  f.sim.hooks.beforeProjectCommit = () => f.sim.addThread({ id: 'foreign', projectId: 'p' });
  const r = body(await f.del('p'));
  assert.equal(r.state, 'completed'); assert.equal(r.postCheck, 'live_threads_remain'); assert.equal(r.liveThreadsAfterDelete, 1);
  assert.equal(f.sim.liveOrphans().length, 1);
  assert.ok(f.audits.some(e => e.event === 'project_delete_live_threads' && e.liveThreads === 1));
  // Replaying the operation returns the recorded receipt and the alert, without a new send.
  const again = body(await f.del('p'));
  assert.deepEqual({ state: again.state, receipt: again.receipt, postCheck: again.postCheck, live: again.liveThreadsAfterDelete }, { state: 'completed', receipt: r.receipt, postCheck: 'live_threads_remain', live: 1 });
  assert.equal(f.invokes().length, 1);
});

test('project admin transport: only the listed RPCs, each with its own result shape', () => {
  const sent = [];
  const socket = { readyState: 1, url: 'ws://127.0.0.1:1/ws?orchestrationProtocol=2', listeners: {}, addEventListener(k, f) { (this.listeners[k] ??= []).push(f); }, send: x => sent.push(JSON.parse(x)) };
  let failed = 0;
  const tr = new StagingRpcTransport({ socket, allowLoopback: true, onFailure: () => failed++ });
  assert.throws(() => tr.invoke('projects.list', {}), /rpc_unavailable/);
  const reply = (id, value) => socket.listeners.message[0]({ data: JSON.stringify({ _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value } }) });
  const del = tr.invoke('projects.mutate', { type: 'project.delete', commandId: 'c', projectId: 'p', force: false });
  const arc = tr.invoke('orchestration.getArchivedShellSnapshot', {});
  reply(sent[0].id, { id: 'p', title: 'p', workspaceRoot: '/w', deletedAt: ISO });
  reply(sent[1].id, { schemaVersion: 1, snapshotSequence: 3, projects: [], threads: [] });
  return Promise.all([del, arc]).then(([d, a]) => {
    assert.deepEqual(tr.receipt(d), { projectId: 'p', deletedAt: ISO });
    assert.equal(a.snapshotSequence, 3); assert.equal(failed, 0);
    // A project-shaped answer to a dispatch is a protocol failure, not a receipt.
    const bad = tr.invoke('orchestration.dispatchCommand', {}); reply(sent[2].id, { id: 'p', deletedAt: null });
    return bad.then(() => assert.fail('accepted'), e => { assert.match(e.message, /control_transport_uncertain/); assert.equal(failed, 1); });
  });
});

test('project admin: tools follow the session grant; an older consent without project actions gets none', () => {
  const names = grants => {
    const registered = [];
    const authority = { check: () => ({ sub: 's', grants }) };
    const w = sessionWrites({ conexoes: [], journal: memoryJournal(), authority, issuer: 'https://i', projectPolicy: 'all', projectAdmin: true });
    w.registerTools({ registerTool: n => registered.push(n) }, { sid: 'x', sub: 's' });
    return registered;
  };
  const env = actions => ({ projectPolicy: 'all', scopeVersion: 3, environments: [{ alias: 'local', environmentId: 'e', destination: 't3://e', actions }] });
  const old = names(env([...ACTIONS]));
  assert.ok(!old.some(n => /project_delete|contar_threads_projeto/.test(n)));
  const fresh = names(env([...ACTIONS, ...PROJECT_ACTIONS]));
  for (const n of ['t3_escrever_project_delete', 't3_escrever_project_delete_force', 't3_contar_threads_projeto']) assert.ok(fresh.includes(n), n);
  assert.deepEqual(names(env([...ACTIONS, 'project.delete'])).filter(n => /project|contar/.test(n)), ['t3_escrever_project_delete', 't3_contar_threads_projeto']);
});
