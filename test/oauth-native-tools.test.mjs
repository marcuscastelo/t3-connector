import test from 'node:test';
import assert from 'node:assert/strict';
import { ambientesFalsos, dadosPadrao } from './apoio.mjs';
import { startConnector } from './oauth-apoio.mjs';
import { memoryJournal, providersFor } from './escrita-fixtures.mjs';
import { t3Tools } from '../src/oauth/t3-tools.mjs';
import { loadOAuthConfig } from '../src/oauth/config.mjs';
import { ACTIONS } from '../src/escrita/adapters.mjs';
import { NATIVE_WRITE_ACTIONS, NATIVE_READ_TOOLS, NATIVE_OMITTED, NativeRpcError, preferences, queuedRunsInDeliveryOrder, queueEntry, scheduledTaskSummary } from '../src/escrita/native.mjs';
import { StagingRpcTransport } from '../src/escrita/transport-staging.mjs';

const body = r => JSON.parse(r.data.result.content[0].text);
const errorText = r => (assert.equal(r.data.result.isError, true, JSON.stringify(r.data)), r.data.result.content[0].text);
const ISO = '2026-10-04T00:00:00.000Z';
const MODEL = { instanceId: 'codex', model: 'gpt', options: [{ id: 'reasoningEffort', value: 'high' }] };
const SETTINGS = { defaultThreadEnvMode: 'local', newWorktreesStartFromOrigin: true, enableProviderUpdateChecks: false, backgroundActivity: { profile: 'balanced', extra: 1 }, sourceControlWritingStyle: { mode: 'custom', followChangeRequestTemplates: true, customInstructions: 'x' }, secretPaths: ['/never'] };
const project = (id, extra = {}) => ({ id, title: id, workspaceRoot: `/w/${id}`, scripts: [], defaultModelSelection: null, createdAt: ISO, updatedAt: ISO, deletedAt: null, ...extra });
const task = (id, projectId, extra = {}) => ({ id, title: 't', prompt: 'p', enabled: true, schedule: { type: 'interval', everyMs: 60000 }, projectId, threadId: null, workspaceStrategy: { type: 'root' }, modelSelection: MODEL, runtimeMode: 'full-access', interactionMode: 'default', createdBy: 'user', creationSource: 'web', createdAt: ISO, updatedAt: ISO, nextRunAt: null, lastRunAt: null, lastRunStatus: 'never', lastRunError: null, runCount: 0, ...extra });

// Fake T3 environment answering the native-tool RPCs and GETs; records every send.
function environment() {
  const e = { projects: [project('p'), project('q'), project('gone', { deletedAt: ISO })], tasks: [task('s1', 'p'), task('s2', 'q')], failNext: null, sends: [], rpcs: [],
    threads: {
      tp: { thread: { id: 'tp', projectId: 'p', modelSelection: MODEL, runtimeMode: 'full-access', interactionMode: 'plan', worktreePath: '/wt/tp', branch: 'b', archivedAt: null },
        contextTransfers: [{ id: 'x1', sourceThreadId: 'a', targetThreadId: 'tp', status: 'completed', payload: 'secret' }],
        runs: [{ id: 'r3', status: 'queued', ordinal: 3, userMessageId: 'm3' }, { id: 'r2', status: 'queued', ordinal: 2, userMessageId: 'm2' }, { id: 'r1', status: 'completed', ordinal: 1, userMessageId: 'm1' }, { id: 'r4', status: 'queued', ordinal: 4, userMessageId: 'm4' }],
        messages: [{ id: 'm2', text: 'two' }, { id: 'm3', text: 'é'.repeat(1001) }, { id: 'm4', text: 'auto', delegatedCompletion: {} }, { id: 'm1', text: 'one' }] },
      tg: { thread: { id: 'tg', projectId: 'gone', modelSelection: MODEL, runtimeMode: 'full-access', interactionMode: 'default', worktreePath: null, branch: null, archivedAt: null }, contextTransfers: [], runs: [], messages: [] },
    } };
  const answer = (method, payload) => {
    if (e.failNext) { const f = e.failNext; e.failNext = null; throw new NativeRpcError(f.tag, f.message); }
    switch (method) {
      case 'projects.mutate': { const p = project(payload.projectId, payload.type === 'project.create' ? { title: payload.title, workspaceRoot: payload.workspaceRoot } : { title: payload.title ?? payload.projectId }); return p; }
      case 'projects.createNew': e.projects.push(project('new-1', { title: payload.name })); return { projectId: 'new-1', workspaceRoot: '/w/new-1', commitError: 'no git identity' };
      case 'sourceControl.cloneRepository': return { cwd: payload.destinationPath, remoteUrl: 'git@x:r.git', repository: null };
      case 'server.updateSettings': return { ...SETTINGS, ...payload.patch, sourceControlWritingStyle: { ...SETTINGS.sourceControlWritingStyle, ...payload.patch.sourceControlWritingStyle } };
      case 'server.getSettings': return SETTINGS;
      case 'scheduledTasks.list': return { tasks: e.tasks };
      case 'scheduledTasks.upsert': return { task: task(payload.id ?? 'new-task', payload.projectId, { ...payload, id: payload.id ?? 'new-task' }) };
      case 'scheduledTasks.delete': return { id: payload.id };
      case 'scheduledTasks.runNow': return { task: task(payload.id, 'p', { lastRunStatus: 'running', runCount: 1, threadId: 'launched' }) };
      case 'orchestration.searchThreads': return { matches: [{ threadId: 'tp', projectId: 'p', source: 'user', snippet: 's', messageCreatedAt: null }, { threadId: 'tq', projectId: 'q', source: 'assistant', snippet: 's', messageCreatedAt: ISO }] };
      case 'orchestration.launchThread': return { threadId: payload.threadId, projection: {}, resumed: false };
      case 'vcs.listRefs': return { refs: [{ name: 'main', worktreePath: null }], isRepo: true, hasPrimaryRemote: true, nextCursor: null, totalCount: 1 };
      default: throw new Error(`unexpected ${method}`);
    }
  };
  e.native = {
    rpc: async (method, payload) => { e.rpcs.push({ method, payload }); return answer(method, payload); },
    thread: async id => { if (!e.threads[id]) throw new Error('404'); return { snapshotSequence: 1, projection: structuredClone(e.threads[id]) }; },
    projects: async () => ({ projects: structuredClone(e.projects), updatedAt: ISO }),
    environment: async () => ({ environmentId: 'env-local', label: 'polaris', serverVersion: '0.0.46', platform: { os: 'darwin', arch: 'arm64' } }),
  };
  e.invoke = async (method, payload, opts) => { e.sends.push({ method, payload, opts }); return answer(method, payload); };
  e.shell = () => ({ projects: e.projects, threads: Object.values(e.threads).map(t => ({ ...t.thread, status: 'idle', latestRunId: null })) });
  return e;
}

async function fixture(t, { nativeTools = true, scope } = {}) {
  const data = dadosPadrao(), reads = ambientesFalsos(data), journal = { ...memoryJournal(), audit() {} };
  const envs = {};
  const connections = reads.registros.map(r => {
    const e = envs[r.alias] = environment();
    data[r.alias].shell = () => e.shell();
    return { registro: { ...r, destination: `t3://${r.environmentId}`, acoes: ACTIONS },
      inventario: async () => { throw new Error('unused'); },
      cliente: async () => ({ shell: async () => structuredClone(e.shell()) }),
      adapter: { prepare: async () => {}, providers: async () => providersFor(MODEL), invoke: e.invoke, native: e.native, receipt: r => r, verifyWorkspace: async () => true, reconcile: async () => ({ found: false, state: 'unknown' }) }, fechar() {} };
  });
  const c = await startConnector({ tools: t3Tools({ ambientes: reads, conexoes: connections, journal, projectPolicy: 'all', nativeTools }) }); t.after(c.close);
  const s = await c.signIn(scope ? { scope } : {}), at = s.tokens.access_token;
  const call = (name, args) => c.callTool(at, name, args);
  const write = (name, input, op = `${name}-1`) => call(name, { environment: 'local', operationId: op, input });
  const read = (name, args = {}) => call(name, { environment: 'local', ...args });
  const list = async () => (await c.mcp(at, 'tools/list')).data.result.tools;
  return { c, s, at, e: envs.local, call, write, read, list };
}

test('native: pure projections follow the native helpers', () => {
  const p = preferences({ ...SETTINGS, sourceControlWritingStyle: { mode: 'custom', followChangeRequestTemplates: false, customInstructions: '😀'.repeat(4001) } });
  assert.deepEqual(Object.keys(p), ['defaultThreadEnvMode', 'newWorktreesStartFromOrigin', 'enableProviderUpdateChecks', 'backgroundActivity', 'sourceControlWritingStyle']);
  assert.deepEqual(p.backgroundActivity, { profile: 'balanced' });
  assert.equal(Array.from(p.sourceControlWritingStyle.customInstructions).length, 4000); assert.equal(p.sourceControlWritingStyle.truncated, true);
  const proj = environment().threads.tp;
  assert.deepEqual(queuedRunsInDeliveryOrder(proj).map(r => r.id), ['r4', 'r2', 'r3']); // automatic completion first, then ordinal
  assert.deepEqual(queuedRunsInDeliveryOrder({ ...proj, runs: proj.runs.map(r => r.id === 'r3' ? { ...r, queuePosition: 0 } : r) }).map(r => r.id), ['r4', 'r3', 'r2']);
  const long = queueEntry(proj, 'r3', 1000);
  assert.equal(Array.from(long.text).length, 1000); assert.equal(long.truncated, true);
  assert.equal(queueEntry(proj, 'r1', 1000), undefined);
  assert.deepEqual(Object.keys(scheduledTaskSummary(task('s', 'p'))), ['scheduledTaskId', 'title', 'prompt', 'enabled', 'projectId', 'boundThreadId', 'schedule', 'nextRunAt', 'lastRunStatus']);
});

test('native transport: typed T3 failures are returned with their tag only when asked; anything else stays fail-closed', async () => {
  const sent = [];
  const socket = { readyState: 1, url: 'ws://127.0.0.1:1/ws?orchestrationProtocol=2', listeners: {}, addEventListener(k, f) { (this.listeners[k] ??= []).push(f); }, send: x => sent.push(JSON.parse(x)) };
  let failed = 0;
  const tr = new StagingRpcTransport({ socket, allowLoopback: true, onFailure: () => failed++ });
  const frame = (id, exit) => socket.listeners.message[0]({ data: JSON.stringify({ _tag: 'Exit', requestId: id, exit }) });
  const typed = { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { _tag: 'ScheduledTaskError', message: 'nope', taskId: 's1', nested: { x: 1 } } }] };
  const a = tr.invoke('scheduledTasks.upsert', {}, { nativeErrors: true }); frame(sent[0].id, typed);
  await assert.rejects(a, e => e instanceof NativeRpcError && e.native.code === 'ScheduledTaskError' && e.native.message === 'nope' && e.native.taskId === 's1' && !('nested' in e.native));
  assert.equal(failed, 0); assert.equal(tr.available, true);
  const b = tr.invoke('server.getSettings', {}, { nativeErrors: true }); frame(sent[1].id, { _tag: 'Success', value: SETTINGS });
  assert.deepEqual(await b, SETTINGS);
  // A defect (not a typed Fail) is uncertain even for native calls.
  const c = tr.invoke('scheduledTasks.list', {}, { nativeErrors: true }); frame(sent[2].id, { _tag: 'Failure', cause: [{ _tag: 'Die', defect: 'x' }] });
  await assert.rejects(c, /control_transport_uncertain/); assert.equal(failed, 1);
  const tr2 = new StagingRpcTransport({ socket: { ...socket, listeners: {}, addEventListener(k, f) { (this.listeners[k] ??= []).push(f); } }, allowLoopback: true, onFailure: () => failed++ });
  assert.throws(() => tr2.invoke('attachments.createUploadUrl', {}), /rpc_unavailable/);
});

test('native: off by default; with the flag only granted sessions see the 18 wrappers, under native names', async t => {
  const off = await fixture(t, { nativeTools: false });
  const namesOff = (await off.list()).map(x => x.name);
  for (const n of [...NATIVE_WRITE_ACTIONS, ...NATIVE_READ_TOOLS]) assert.ok(!namesOff.includes(n), n);
  assert.doesNotMatch(off.s.view.data.writes.consent, /native T3 operations/);
  const on = await fixture(t);
  const tools = await on.list(), names = tools.map(x => x.name);
  for (const n of [...NATIVE_WRITE_ACTIONS, ...NATIVE_READ_TOOLS]) assert.ok(names.includes(n), n);
  assert.equal(names.length - namesOff.length, 18);
  for (const n of NATIVE_READ_TOOLS) assert.equal(tools.find(x => x.name === n).annotations.readOnlyHint, true, n);
  for (const n of NATIVE_WRITE_ACTIONS) assert.equal(tools.find(x => x.name === n).annotations.readOnlyHint, false, n);
  for (const n of Object.keys(NATIVE_OMITTED)) assert.ok(!names.includes(n), n);
  assert.match(on.s.view.data.writes.consent, /native T3 operations/);
  assert.equal(loadOAuthConfig({ T3_CONNECTOR_OAUTH_ISSUER: 'https://c.example', T3_CONNECTOR_OAUTH_PROJECTS: 'all', T3_CONNECTOR_OAUTH_NATIVE_TOOLS: '1' }).nativeTools, true);
  assert.throws(() => loadOAuthConfig({ T3_CONNECTOR_OAUTH_ISSUER: 'https://c.example', T3_CONNECTOR_OAUTH_NATIVE_TOOLS: '1' }), /requires T3_CONNECTOR_OAUTH_PROJECTS=all/);
});

test('native project writes: exact payloads, stable commandId, native results and refusals', async t => {
  const f = await fixture(t);
  const created = body(await f.write('t3_project_create', { title: 'New', workspaceRoot: '/w/new', createWorkspaceRootIfMissing: true }));
  const [m] = f.e.sends;
  assert.equal(m.method, 'projects.mutate'); assert.deepEqual(m.opts, { nativeErrors: true });
  assert.deepEqual(Object.keys(m.payload).sort(), ['commandId', 'createWorkspaceRootIfMissing', 'projectId', 'title', 'type', 'workspaceRoot']);
  assert.equal(m.payload.type, 'project.create'); assert.equal(m.payload.projectId, m.payload.commandId);
  assert.equal(created.receipt.workspaceRoot, '/w/new');
  const again = body(await f.write('t3_project_create', { title: 'New', workspaceRoot: '/w/new', createWorkspaceRootIfMissing: true }));
  assert.equal(f.e.sends.length, 1); assert.deepEqual(again.receipt, created.receipt);
  // Title-only: projects.createNew, then the full Project with commitError.
  const titled = body(await f.write('t3_project_create', { title: 'Fresh' }, 'c2'));
  assert.deepEqual(f.e.sends[1].payload, { name: 'Fresh' }); assert.equal(f.e.sends[1].method, 'projects.createNew');
  assert.equal(titled.receipt.id, 'new-1'); assert.equal(titled.receipt.commitError, 'no git identity');
  assert.match(errorText(await f.write('t3_project_create', { title: 'X', scripts: [] }, 'c3')), /^invalid_request: A project started from its title/);
  assert.equal(f.e.sends.length, 2);
  // Update: only provided fields; nulls are sent (clear).
  body(await f.write('t3_project_update', { projectId: 'p', title: 'P2', faviconPath: null }, 'u1'));
  assert.deepEqual(Object.keys(f.e.sends[2].payload).sort(), ['commandId', 'faviconPath', 'projectId', 'title', 'type']);
  assert.match(errorText(await f.write('t3_project_update', { projectId: 'gone', title: 'x' }, 'u2')), /scope_denied/);
  // Clone: environment-scoped, payload identical to the input, result as answered.
  const clone = body(await f.write('t3_project_clone', { remoteUrl: 'git@x:r.git', destinationPath: '/w/r', protocol: 'ssh' }, 'k1'));
  assert.deepEqual(f.e.sends[3].payload, { remoteUrl: 'git@x:r.git', destinationPath: '/w/r', protocol: 'ssh' });
  assert.deepEqual(clone.receipt, { cwd: '/w/r', remoteUrl: 'git@x:r.git', repository: null });
  assert.match(errorText(await f.write('t3_project_clone', { destinationPath: '/w/r', cwd: '/x' }, 'k2')), /./); // unknown native field refused by the strict schema
  assert.equal(f.e.sends.length, 4);
});

test('native preferences: patch has only the provided fields; the result is the native preferences projection', async t => {
  const f = await fixture(t);
  const r = body(await f.write('t3_environment_preferences_update', { newWorktreesStartFromOrigin: false, sourceControlWritingStyle: { customInstructions: '' } }));
  assert.deepEqual(f.e.sends[0], { method: 'server.updateSettings', payload: { patch: { newWorktreesStartFromOrigin: false, sourceControlWritingStyle: { customInstructions: '' } } }, opts: { nativeErrors: true } });
  assert.equal(r.receipt.newWorktreesStartFromOrigin, false); assert.equal(r.receipt.sourceControlWritingStyle.customInstructions, '');
  assert.ok(!('secretPaths' in r.receipt));
  assert.match(errorText(await f.write('t3_environment_preferences_update', { backgroundActivity: { profile: 'custom' } }, 'p2')), /./);
});

test('native scheduler: create inherits the thread, update merges, delete and runNow keep native shapes and refusals', async t => {
  const f = await fixture(t);
  const created = body(await f.write('schedule_task', { threadId: 'tp', prompt: 'first line\nmore', schedule: '{"type":"fixed_time","timeOfDay":"09:30","weekdays":[1,2]}' }));
  const up = f.e.sends[0];
  assert.equal(up.method, 'scheduledTasks.upsert');
  assert.deepEqual({ ...up.payload, commandId: 'x' }, { title: 'first line', prompt: 'first line\nmore', enabled: true, schedule: { type: 'fixed_time', timeOfDay: '09:30', weekdays: [1, 2] }, projectId: 'p', threadId: 'tp', workspaceStrategy: { type: 'root' }, modelSelection: MODEL, runtimeMode: 'full-access', interactionMode: 'plan', createdBy: 'agent', creationSource: 'mcp', commandId: 'x' });
  assert.deepEqual(Object.keys(created.receipt), ['scheduledTaskId', 'title', 'prompt', 'enabled', 'projectId', 'boundThreadId', 'schedule', 'nextRunAt', 'lastRunStatus']);
  body(await f.write('schedule_task', { threadId: 'tp', prompt: 'x', schedule: { type: 'interval', everyMs: 60000 }, bindToCurrentThread: false }, 's2'));
  assert.deepEqual([f.e.sends[1].payload.threadId, f.e.sends[1].payload.workspaceStrategy], [null, { type: 'worktree', baseRef: 'main', startFromOrigin: true }]);
  assert.match(errorText(await f.write('schedule_task', { threadId: 'tp', prompt: 'x', schedule: { type: 'interval', everyMs: 1000 } }, 's3')), /./);
  // Update: read, merge, keep existing configuration and provenance.
  body(await f.write('update_scheduled_task', { projectId: 'p', scheduledTaskId: 's1', enabled: false }, 'u1'));
  const merged = f.e.sends[2].payload;
  assert.deepEqual({ id: merged.id, enabled: merged.enabled, title: merged.title, createdBy: merged.createdBy, creationSource: merged.creationSource, workspaceStrategy: merged.workspaceStrategy }, { id: 's1', enabled: false, title: 't', createdBy: 'user', creationSource: 'web', workspaceStrategy: { type: 'root' } });
  assert.match(errorText(await f.write('update_scheduled_task', { projectId: 'p', scheduledTaskId: 's2', enabled: false }, 'u2')), /^task_not_found:/);
  assert.match(errorText(await f.write('update_scheduled_task', { projectId: 'p', scheduledTaskId: 's1', bindToCurrentThread: true }, 'u3')), /^invalid_request: bindToCurrentThread true needs threadId/);
  assert.equal(f.e.sends.length, 3);
  const del = body(await f.write('delete_scheduled_task', { projectId: 'p', scheduledTaskId: 's1' }, 'd1'));
  assert.deepEqual(f.e.sends[3].payload, { id: 's1' }); assert.deepEqual(del.receipt, { scheduledTaskId: 's1', deleted: true });
  const ran = body(await f.write('run_scheduled_task_now', { projectId: 'p', taskId: 's1' }, 'n1'));
  assert.deepEqual(ran.receipt, { taskId: 's1', threadId: 'launched', lastRunStatus: 'running', runCount: 1, nextRunAt: null });
  assert.match(errorText(await f.write('run_scheduled_task_now', { projectId: 'p', taskId: 's2' }, 'n2')), /^invalid_request: The task was not found in the calling project/);
  assert.match(errorText(await f.write('run_scheduled_task_now', { projectId: 'gone', taskId: 's1' }, 'n3')), /scope_denied/);
});

test('native: a typed T3 refusal after the send is final (failed, not uncertain); sessions survive and the replay keeps the error', async t => {
  const f = await fixture(t);
  f.e.failNext = { tag: 'ScheduledTaskError', message: 'Schedule rejected' };
  assert.equal(errorText(await f.write('schedule_task', { threadId: 'tp', prompt: 'x', schedule: { type: 'interval', everyMs: 60000 } }, 'f1')), 'ScheduledTaskError: Schedule rejected');
  const replay = body(await f.write('schedule_task', { threadId: 'tp', prompt: 'x', schedule: { type: 'interval', everyMs: 60000 } }, 'f1'));
  assert.deepEqual({ state: replay.state, reconciliationRequired: replay.reconciliationRequired, error: replay.error }, { state: 'failed', reconciliationRequired: false, error: { code: 'ScheduledTaskError', message: 'Schedule rejected' } });
  assert.equal(f.e.sends.length, 1);
  // The session is still valid: the next call works.
  assert.equal(body(await f.read('t3_environment_read')).label, 'polaris');
});

test('native reads: native shapes, explicit thread/project context, live-project authorization', async t => {
  const f = await fixture(t);
  const env = body(await f.read('t3_environment_read'));
  assert.deepEqual(Object.keys(env), ['environmentId', 'label', 'serverVersion', 'platform', 'preferences']); assert.ok(!('secretPaths' in env.preferences));
  assert.equal(body(await f.read('t3_project_read', { projectId: 'p' })).workspaceRoot, '/w/p');
  assert.equal(errorText(await f.read('t3_project_read', { projectId: 'gone' })), 'invalid_request: The project was not found.');
  assert.deepEqual(body(await f.read('t3_thread_configuration', { threadId: 'tp' })), { threadId: 'tp', modelSelection: MODEL, runtimeMode: 'full-access', interactionMode: 'plan' });
  assert.deepEqual(body(await f.read('t3_thread_transfers', { threadId: 'tp' })), { transfers: [{ id: 'x1', sourceThreadId: 'a', targetThreadId: 'tp', status: 'completed' }] });
  const q = body(await f.read('t3_queue_list', { threadId: 'tp', limit: 2 }));
  assert.deepEqual(q.items.map(i => i.queuedRunId), ['r4', 'r2']); assert.equal(q.nextCursor, 2);
  const rest = body(await f.read('t3_queue_list', { threadId: 'tp', cursor: 2 }));
  assert.equal(Array.from(rest.items[0].text).length, 1000); assert.equal(rest.items[0].truncated, true); assert.equal(rest.nextCursor, null);
  assert.equal(body(await f.read('t3_queue_read', { threadId: 'tp', queuedRunId: 'r3' })).truncated, false);
  assert.equal(errorText(await f.read('t3_queue_read', { threadId: 'tp', queuedRunId: 'r1' })), 'invalid_request: The queued message was not found.');
  assert.deepEqual(body(await f.read('t3_thread_search', { query: 'ab', projectId: 'q' })).matches.map(m => m.threadId), ['tq']);
  assert.equal(body(await f.read('t3_thread_search', { query: 'ab', limit: 5 })).matches.length, 2);
  assert.deepEqual(f.e.rpcs.filter(r => r.method === 'orchestration.searchThreads').map(r => r.payload), [{ query: 'ab' }, { query: 'ab', limit: 5 }]);
  assert.deepEqual(body(await f.read('t3_worktree_status', { threadId: 'tp' })), { attached: true, worktreePath: '/wt/tp', branch: 'b', projectWorkspaceRoot: '/w/p', defaultStartFromOrigin: true });
  body(await f.read('t3_worktree_list', { threadId: 'tp', refKind: 'local' }));
  assert.deepEqual(f.e.rpcs.find(r => r.method === 'vcs.listRefs').payload, { refKind: 'local', cwd: '/wt/tp' });
  assert.deepEqual(body(await f.read('list_scheduled_tasks', { projectId: 'q' })).tasks.map(x => x.scheduledTaskId), ['s2']);
  // A thread of a deleted project is outside the live grant.
  assert.match(errorText(await f.read('t3_thread_configuration', { threadId: 'tg' })), /scope_denied/);
  assert.match(errorText(await f.read('list_scheduled_tasks', { projectId: 'gone' })), /scope_denied/);
});

test('native: a read-only sign-in can call the native reads but not the native writes', async t => {
  const f = await fixture(t, { scope: 'connector:read' });
  assert.equal(body(await f.read('t3_thread_configuration', { threadId: 'tp' })).threadId, 'tp');
  const denied = await f.write('t3_project_clone', { destinationPath: '/w/r', remoteUrl: 'u' }, 'r1');
  assert.equal(errorText(denied), "insufficient_scope: connector:write");
  assert.equal(f.e.sends.length, 0);
});

test('thread.launch forwards every workspaceStrategy as is: worktree (baseRef, branch?, startFromOrigin?), root and existing_worktree', async t => {
  const f = await fixture(t);
  const launch = (workspaceStrategy, op) => f.call('t3_escrever_thread_launch', { environment: 'local', operationId: op, input: { projectId: 'p', title: 'w', modelSelection: MODEL, workspaceStrategy } });
  const cases = [
    [{ type: 'worktree', baseRef: 'main' }, 'l1'],
    [{ type: 'worktree', baseRef: 'origin/release', branch: 'feat/x', startFromOrigin: true }, 'l2'],
    [{ type: 'worktree', baseRef: 'main', startFromOrigin: false }, 'l3'],
    [{ type: 'root' }, 'l4'],
    [{ type: 'root', branch: 'dev' }, 'l5'],
    [{ type: 'existing_worktree', worktreePath: '/w/p' }, 'l6'],
  ];
  for (const [strategy, op] of cases) {
    const r = await launch(strategy, op);
    assert.notEqual(r.data.result.isError, true, `${op}: ${r.data.result.content[0].text}`);
    const sent = f.e.sends.at(-1);
    assert.equal(sent.method, 'orchestration.launchThread', op);
    assert.deepEqual(sent.payload.workspaceStrategy, strategy, op);
    assert.equal(sent.payload.projectId, 'p'); assert.equal(sent.payload.runtimeMode, 'full-access');
  }
  // Still refused: worktree without baseRef, unknown fields, and an existing worktree outside the approved roots.
  assert.match(errorText(await launch({ type: 'worktree' }, 'b1')), /./);
  assert.match(errorText(await launch({ type: 'worktree', baseRef: 'main', path: '/x' }, 'b2')), /./);
  assert.match(errorText(await launch({ type: 'existing_worktree', worktreePath: '/elsewhere' }, 'b3')), /workspace_scope_denied/);
  assert.equal(f.e.sends.length, cases.length);
});


test('OAuth public schema and dispatch expose native runtime modes with backward-compatible omission', async t => {
  const f = await fixture(t);
  const list = await f.list();
  for (const action of ['thread_launch', 'thread_runtime_mode_set', 'delegated_task_request']) {
    const tool = list.find(x => x.name === `t3_escrever_${action}`);
    const input = tool.inputSchema.properties.input;
    assert.deepEqual(input.properties.runtimeMode.enum, ['approval-required', 'auto-accept-edits', 'auto', 'full-access']);
    assert.ok(!input.required.includes('runtimeMode'));
    assert.equal(input.properties.runtimeMode.default, 'full-access');
  }
  const r = body(await f.write('t3_escrever_thread_launch', {projectId:'p',title:'restricted run',modelSelection:MODEL,workspaceStrategy:{type:'worktree',baseRef:'main'},runtimeMode:'approval-required'}, 'restricted-launch'));
  assert.equal(r.state, 'completed');
  assert.equal(f.e.sends[0].payload.runtimeMode, 'approval-required');
});

test('OAuth tools/list points branch/worktree creation to thread.launch, from launch and from the worktree reads', async t => {
  const f = await fixture(t);
  const list = await f.list(), d = name => list.find(x => x.name === name).description;
  assert.match(d('t3_escrever_thread_launch'), /canonical way to open an implementation thread on a NEW branch and worktree/);
  assert.match(d('t3_escrever_thread_launch'), /no separate branch or worktree creation tool/);
  for (const name of ['t3_worktree_status', 't3_worktree_list']) assert.match(d(name), /Read-only; to create a new branch and worktree with a thread, use thread\.launch \(t3_escrever_thread_launch\) with workspaceStrategy\.type='worktree'/);
});
