// src/ops.mjs against a stateful fake T3 (HTTP server + fake WebSocket RPC).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { buildModelSelection, createOps, deriveUuid, findProject, OPS_WAIT_MAX_MS, opsActions, QUERY_NAMES, refusal, resolveEnvironment, validateOpsConfig } from '../src/ops.mjs';
import { ALL_ACTIONS, ACTIONS } from '../src/escrita/adapters.mjs';
import { NATIVE_READ_TOOLS, NATIVE_WRITE_ACTIONS, OPS_NATIVE_READ_TOOLS } from '../src/escrita/native.mjs';
import { PROJECT_ACTIONS } from '../src/escrita/project-admin.mjs';
import { StagingRpcTransport } from '../src/escrita/transport-staging.mjs';

const ENV_ID = 'env-1';
let state, calls, server, base;

function reset() {
  calls = [];
  state = {
    scopes: ['orchestration:read', 'orchestration:operate', 'terminal:operate'],
    projects: [{ id: 'p1', title: 'Fleet', workspaceRoot: '/w/fleet' }, { id: 'p2', title: 'Revena', workspaceRoot: '/w/a' }, { id: 'p3', title: 'Revena', workspaceRoot: '/w/b' }],
    seq: 7,
    archived: [{ id: 't-arch', projectId: 'p1', title: 'Archived', status: 'completed', archivedAt: '2026-10-02T00:00:00Z' }],
    requests: {},
    threads: [
      { id: 't-idle', projectId: 'p1', title: 'Idle', status: 'idle', createdBy: 'user', modelSelection: { instanceId: 'claudeAgent', model: 'opus', options: [{ id: 'effort', value: 'high' }] }, runtimeMode: 'full-access' },
      { id: 't-run', projectId: 'p1', title: 'Running', status: 'running', createdBy: 'user' },
      { id: 't-ask', projectId: 'p1', title: 'Asking', status: 'idle', pendingRuntimeRequest: { kind: 'user_input' } },
      { id: 't-done', projectId: 'p1', title: 'Done', status: 'idle', settledAt: '2026-10-01T00:00:00Z' },
    ],
    messages: { 't-idle': [{ id: 'm1', role: 'user', text: 'one' }, { id: 'm2', role: 'assistant', text: 'two' }, { id: 'tool', role: 'tool', text: 'x' }, { id: 'm3', role: 'user', text: 'three' }] },
    providers: [{ instanceId: 'claudeAgent', models: [{ slug: 'opus', capabilities: { optionDescriptors: [{ id: 'effort', type: 'select', options: [{ id: 'low' }, { id: 'high' }] }] } }, { slug: 'plain', capabilities: { optionDescriptors: [] } }] },
      { instanceId: 'codex', models: [{ slug: 'gpt', capabilities: { optionDescriptors: [{ id: 'reasoningEffort', type: 'select', options: [{ id: 'high' }] }] } }] }],
  };
}

class Typed { constructor(error) { this.error = error; } }

function rpc(tag, p) {
  calls.push({ tag, payload: p });
  if (tag === 'server.getConfig') return { environment: { environmentId: ENV_ID }, providers: state.providers };
  if (tag === 'orchestration.getArchivedShellSnapshot') return { snapshotSequence: state.seq, threads: state.archived };
  if (tag === 'projects.mutate') {
    if (p.type === 'project.delete') { const pr = state.projects.find((x) => x.id === p.projectId); pr.deletedAt = '2026-10-07T12:00:00Z'; return { ...pr }; }
    const pr = state.projects.find((x) => x.id === p.projectId); Object.assign(pr, { title: p.title ?? pr.title }); return { ...pr, deletedAt: null };
  }
  if (p?.type === 'thread.pull-request.watch') return new Typed({ _tag: 'OrchestrationCommandInvalid', message: 'unknown command' });
  if (p?.type === 'thread.archive') { const i = state.threads.findIndex((x) => x.id === p.threadId); state.archived.push({ ...state.threads[i], archivedAt: '2026-10-07T12:00:00Z' }); state.threads.splice(i, 1); return { sequence: calls.length }; }
  if (p?.type === 'thread.unarchive') { const i = state.archived.findIndex((x) => x.id === p.threadId); const { archivedAt, ...t } = state.archived[i]; state.threads.push(t); state.archived.splice(i, 1); return { sequence: calls.length }; }
  if (p?.type === 'thread.model-selection.set' || p?.type === 'provider.switch') { state.threads.find((x) => x.id === p.threadId).modelSelection = p.modelSelection; return { sequence: calls.length }; }
  if (tag === 'orchestration.launchThread') {
    state.threads.push({ id: p.threadId, projectId: p.projectId, title: p.title, status: 'starting', createdBy: 'user', modelSelection: p.modelSelection, runtimeMode: p.runtimeMode });
    return { threadId: p.threadId, projection: {}, resumed: false };
  }
  const t = state.threads.find((x) => x.id === p.threadId);
  if (p.type === 'thread.settle') t.settledAt = '2026-10-07T12:00:00Z';
  if (p.type === 'thread.snooze') t.snoozedUntil = p.snoozedUntil;
  if (p.type === 'message.dispatch' && t.status !== 'running') (state.messages[t.id] ??= []).push({ id: p.messageId, role: 'user', text: p.text });
  return { sequence: calls.length };
}

class FakeSocket extends EventTarget {
  constructor(url) { super(); this.url = url; this.readyState = 0; setImmediate(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
  send(raw) {
    const f = JSON.parse(raw);
    setImmediate(() => {
      const value = rpc(f.tag, f.payload);
      const exit = value instanceof Typed ? { _tag: 'Failure', cause: [{ _tag: 'Fail', error: value.error }] } : { _tag: 'Success', value };
      const e = new Event('message'); e.data = JSON.stringify({ _tag: 'Exit', requestId: f.id, exit }); this.dispatchEvent(e);
    });
  }
  close() { this.readyState = 3; }
}

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (v, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (url.pathname === '/.well-known/t3/environment') return json({ environmentId: ENV_ID, label: 'test', orchestrationProtocolVersion: 2 });
    if (url.pathname === '/api/auth/session') return json({ scopes: state.scopes });
    if (url.pathname === '/api/auth/websocket-ticket') return json({ ticket: 'tk' });
    if (url.pathname === '/api/orchestration/shell') return json({ snapshotSequence: state.seq, threads: state.threads.filter((t) => !t.archivedAt), projects: state.projects });
    if (url.pathname === '/api/projects') return json({ projects: state.projects.map((p) => ({ deletedAt: null, ...p })) });
    const m = /^\/api\/orchestration\/threads\/([^/]+)(\/bounded|\/history)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const messages = state.messages[id] ?? [];
      if (m[2] === '/history') return json({ items: [{ item: { messageId: 'old-q', type: 'assistant_message', text: 'push v1 no repo?', ordinal: 0, startedAt: '2026-10-07T10:00:00Z' } }], hasMoreHistory: false });
      const req = state.requests[id] ?? [];
      if (m[2] === '/bounded') return json({ projection: { messages, runs: [], runtimeRequests: req.map((r) => r.request), turnItems: [...messages.map((x, i) => ({ messageId: x.id, type: `${x.role}_message`, text: x.text, ordinal: i + 1, createdBy: 'user', creationSource: 'web', startedAt: '2026-10-07T11:00:00Z' })), ...req.map((r) => r.item)] }, hasMoreHistory: true, historyCursor: 'c1' });
      const t = [...state.threads, ...state.archived].find((x) => x.id === id);
      return json({ snapshotSequence: state.seq, projection: { thread: t && { ...t, providerInstanceId: t.modelSelection?.instanceId ?? 'claudeAgent', interactionMode: 'default' }, messages, runs: [], contextTransfers: [] } });
    }
    json({}, 404);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(reset);

const ops = () => createOps({ alias: 'test', aliases: [], environmentId: ENV_ID, url: base, ssh: null, tokenFile: '/x' }, { readToken: () => 'tok', WebSocketImpl: FakeSocket });

test('config: aliases resolve, repeats and missing fields fail', () => {
  const { environments } = validateOpsConfig({ environments: { mac: { url: 'https://h.example', tokenFile: '~/t', aliases: ['polaris'] } } });
  assert.equal(resolveEnvironment(environments, 'polaris').alias, 'mac');
  assert.throws(() => resolveEnvironment(environments, 'vega'), /unknown environment: vega/);
  assert.throws(() => validateOpsConfig({ environments: { mac: { url: 'https://h.example', tokenFile: 't', aliases: ['mac'] } } }), /alias repeated/);
  assert.throws(() => validateOpsConfig({ environments: { mac: { tokenFile: 't' } } }), /exactly one/);
  assert.throws(() => validateOpsConfig({ environments: { s: { url: 'http://s.example.ts.net:3773', tokenFile: 't' } } }), /HTTPS or loopback/);
  assert.equal(validateOpsConfig({ environments: { s: { url: 'http://s.example.ts.net:3773', tokenFile: 't', insecureHttp: true } } }).environments[0].insecureHttp, true);
});

test('list hides settled threads; read keeps conversation order, since and last', async () => {
  const o = ops();
  assert.deepEqual((await o.list()).map((t) => t.threadId), ['t-idle', 't-run', 't-ask']);
  const r = await o.read('t-idle', { since: 1, last: 1 });
  assert.equal(r.total, 3);
  assert.deepEqual(r.messages.map((m) => [m.position, m.text]), [[3, 'three']]);
  await assert.rejects(o.read('nope'), { code: 'thread_not_found' });
  o.close();
});

test('read-only token reads; mutations are refused before anything is sent', async () => {
  state.scopes = ['orchestration:read'];
  const o = ops();
  assert.equal((await o.list()).length, 3);
  assert.equal((await o.timeline('t-idle', { messageIds: ['m3'] })).length, 4);
  await assert.rejects(o.send('t-idle', { text: 'x', messageId: 'x:9' }), { code: 'token_scope_missing' });
  await assert.rejects(o.create({ project: 'Fleet', title: 'x', instanceId: 'claudeAgent', model: 'opus', clientRequestId: 'r' }), { code: 'token_scope_missing' });
  assert.deepEqual((await o.settle(['t-idle']))[0].error, 'token_scope_missing');
  assert.deepEqual(calls, []);
  state.scopes = [];
  const p = ops();
  await assert.rejects(p.list(), { code: 'token_scope_missing' });
  o.close(); p.close();
});

test('settle and snooze refuse running or asking threads, confirm the rest, same commandId on repeat', async () => {
  const o = ops();
  const r = await o.settle(['t-idle', 't-run', 't-ask', 'nope']);
  assert.deepEqual(r.map((x) => [x.threadId, x.ok, x.reason ?? null]), [['t-idle', true, null], ['t-run', false, 'status_running'], ['t-ask', false, 'pending_request_user_input'], ['nope', false, 'not_found']]);
  const until = new Date('2026-10-09T17:00:00Z');
  delete state.threads[0].settledAt;
  assert.equal((await o.snooze('t-idle', until)).ok, true);
  assert.equal(state.threads[0].snoozedUntil, until.toISOString());
  await o.snooze('t-idle', until);
  const snoozes = calls.filter((c) => c.payload.type === 'thread.snooze');
  assert.equal(snoozes[0].payload.commandId, snoozes[1].payload.commandId);
  o.close();
});

test('send: delivered on idle, queued behind a running thread, requires an id', async () => {
  const o = ops();
  assert.deepEqual(await o.send('t-idle', { text: 'hi', messageId: 'x:1' }), { threadId: 't-idle', messageId: 'x:1', state: 'delivered' });
  assert.equal((await o.send('t-run', { text: 'hi', messageId: 'x:2' })).state, 'queued');
  const d = calls.find((c) => c.payload.messageId === 'x:1').payload;
  assert.equal(d.createdBy, 'agent');
  assert.equal(d.creationSource, 'mcp');
  assert.deepEqual(d.dispatchMode, { type: 'queue_after_active' });
  await assert.rejects(o.send('t-idle', { text: 'hi' }), { code: 'message_id_required' });
  o.close();
});

test('timeline pages history until every requested message is loaded', async () => {
  const o = ops();
  const items = await o.timeline('t-idle', { messageIds: ['m3', 'old-q'] });
  assert.deepEqual(items.map((i) => i.messageId), ['old-q', 'm1', 'm2', 'tool', 'm3']);
  assert.equal((await o.timeline('t-idle', { messageIds: ['m3'] })).length, 4);
  o.close();
});

test('project lookup: id, root, unique title; ambiguous title fails with candidates', () => {
  const projects = [{ id: 'p1', title: 'Fleet', workspaceRoot: '/w/fleet' }, { id: 'p2', title: 'Revena', workspaceRoot: '/w/a' }, { id: 'p3', title: 'Revena', workspaceRoot: '/w/b' }];
  assert.equal(findProject(projects, 'fleet').id, 'p1');
  assert.equal(findProject(projects, '/w/b').id, 'p3');
  assert.throws(() => findProject(projects, 'Revena'), (e) => e.code === 'project_ambiguous' && e.details.candidates.length === 2);
  assert.throws(() => findProject(projects, 'nope'), { code: 'project_not_found' });
});

test('model selection: effort maps to the model option and is checked against the catalog', () => {
  const p = [{ instanceId: 'a', models: [{ slug: 'm', capabilities: { optionDescriptors: [{ id: 'effort', type: 'select', options: [{ id: 'high' }] }] } }] },
    { instanceId: 'c', models: [{ slug: 'g', capabilities: { optionDescriptors: [{ id: 'reasoningEffort', type: 'select', options: [{ id: 'high' }] }] } }, { slug: 'n', capabilities: { optionDescriptors: [] } }] }];
  assert.deepEqual(buildModelSelection(p, { instanceId: 'a', model: 'm', effort: 'high' }), { instanceId: 'a', model: 'm', options: [{ id: 'effort', value: 'high' }] });
  assert.deepEqual(buildModelSelection(p, { instanceId: 'c', model: 'g', effort: 'high' }).options, [{ id: 'reasoningEffort', value: 'high' }]);
  assert.deepEqual(buildModelSelection(p, { instanceId: 'c', model: 'g' }), { instanceId: 'c', model: 'g' });
  assert.throws(() => buildModelSelection(p, { instanceId: 'a', model: 'm', effort: 'ultra' }), { code: 'model_option_value_unsupported' });
  assert.throws(() => buildModelSelection(p, { instanceId: 'c', model: 'n', effort: 'high' }), { code: 'effort_unsupported' });
  assert.throws(() => buildModelSelection(p, { instanceId: 'x', model: 'm' }), { code: 'provider_instance_unavailable' });
});

test('create: launches with the brief, validated model and derived ids; repeating returns the same thread', async () => {
  const o = ops();
  const req = { project: 'Fleet', title: 'Probe', instanceId: 'claudeAgent', model: 'opus', effort: 'high', text: 'brief', clientRequestId: 'req-1' };
  const first = await o.create(req);
  assert.equal(first.created, true);
  assert.equal(first.threadId, deriveUuid('t3-connector-ops:create', ENV_ID, 'req-1'));
  const launch = calls.find((c) => c.tag === 'orchestration.launchThread').payload;
  assert.equal(launch.projectId, 'p1');
  assert.deepEqual(launch.modelSelection, { instanceId: 'claudeAgent', model: 'opus', options: [{ id: 'effort', value: 'high' }] });
  assert.equal(launch.initialMessage.text, 'brief');
  assert.equal(launch.runtimeMode, 'full-access');
  assert.equal(launch.creationSource, 'mcp');
  assert.deepEqual(launch.workspaceStrategy, { type: 'root' });
  const again = await o.create(req);
  assert.equal(again.created, false);
  assert.equal(calls.filter((c) => c.tag === 'orchestration.launchThread').length, 1);
  await assert.rejects(o.create({ ...req, clientRequestId: 'req-2', project: 'Revena' }), { code: 'project_ambiguous' });
  await assert.rejects(o.create({ ...req, clientRequestId: 'req-3', model: 'nope' }), { code: 'provider_model_unavailable' });
  assert.equal(calls.filter((c) => c.tag === 'orchestration.launchThread').length, 1);
  o.close();
});

test('refusal reasons', () => {
  assert.equal(refusal(undefined), 'not_found');
  assert.equal(refusal({ status: 'waiting' }), 'status_waiting');
  assert.equal(refusal({ status: 'idle' }), null);
});

// ---- actions / act / query ------------------------------------------------------------------------
const dispatched = (type) => calls.filter((c) => c.tag === 'orchestration.dispatchCommand' && c.payload.type === type).map((c) => c.payload);

test('actions(): exactly the action tables plus the reads, each with kind and description', () => {
  const catalog = opsActions();
  assert.deepEqual(catalog.filter((a) => a.kind !== 'read' && a.kind !== 'native-read').map((a) => a.action), [...ALL_ACTIONS]);
  assert.deepEqual(catalog.filter((a) => a.kind === 'read' || a.kind === 'native-read').map((a) => a.action), [...QUERY_NAMES]);
  assert.deepEqual(catalog.filter((a) => a.kind === 'native-read').map((a) => a.action), [...NATIVE_READ_TOOLS, ...OPS_NATIVE_READ_TOOLS]);
  assert.deepEqual(catalog.filter((a) => a.kind === 'project').map((a) => a.action), [...PROJECT_ACTIONS]);
  assert.ok(NATIVE_WRITE_ACTIONS.every((a) => catalog.find((x) => x.action === a).kind === 'native-write'));
  assert.ok(ACTIONS.every((a) => catalog.find((x) => x.action === a).kind === 'command'));
  for (const q of ['thread', 'pending_requests', 'search', 'attention', 'control_plane', 'wait', 'messages', 'read_batch']) assert.ok(QUERY_NAMES.includes(q), q);
  assert.equal(new Set(catalog.map((a) => a.action)).size, catalog.length);
  assert.ok(catalog.every((a) => typeof a.description === 'string' && a.description.length > 10 && typeof a.idempotent === 'boolean'));
  assert.equal(catalog.find((a) => a.action === 't3_project_clone').idempotent, false);
  // Operator-only actions stay out of the MCP catalogs.
  assert.ok(!ACTIONS.includes('thread.pull-request.watch') && !ACTIONS.includes('t3_thread_configure'));
  assert.deepEqual(createOps({ alias: 'x', aliases: [], url: 'https://x.example', ssh: null, tokenFile: '/x' }, { transport: { fechar() {} } }).actions(), catalog);
});

test('act: same operation → same commandId (replayed by T3); another operation → another id', async () => {
  const o = ops();
  const a = await o.act('thread.pin', { threadId: 't-idle' }, { operationId: 'op-1' });
  const b = await o.act('thread.pin', { threadId: 't-idle' }, { operationId: 'op-1' });
  const c = await o.act('thread.pin', { threadId: 't-idle' }, { operationId: 'op-2' });
  assert.equal(a.commandId, deriveUuid('t3-connector-ops', ENV_ID, 'thread.pin', 'op-1'));
  assert.equal(a.commandId, b.commandId);
  assert.notEqual(a.commandId, c.commandId);
  assert.deepEqual(dispatched('thread.pin').map((p) => p.commandId), [a.commandId, a.commandId, c.commandId]);
  assert.deepEqual(Object.keys(a).sort(), ['action', 'commandId', 'operationId', 'result']);
  assert.equal(typeof a.result.sequence, 'number');
  await assert.rejects(o.act('thread.pin', { threadId: 't-idle' }), { code: 'operation_id_required' });
  await assert.rejects(o.act('thread.nope', {}, { operationId: 'x' }), { code: 'action_unknown' });
  await assert.rejects(o.act('thread.pin', { threadId: 't-idle', extra: 1 }, { operationId: 'x' }), { code: 'input_invalid' });
  o.close();
});

test('act thread.launch / thread.fork: thread and message ids derive from the operation', async () => {
  const o = ops();
  const input = { projectId: 'p1', title: 'L', modelSelection: { instanceId: 'codex', model: 'gpt' }, workspaceStrategy: { type: 'root' }, text: 'go' };
  const r = await o.act('thread.launch', input, { operationId: 'launch-1' });
  const launch = calls.find((c) => c.tag === 'orchestration.launchThread').payload;
  assert.equal(launch.threadId, deriveUuid('t3-connector-ops', ENV_ID, 'thread.launch', 'launch-1', 'thread'));
  assert.equal(launch.initialMessage.messageId, r.ids.messageId);
  assert.deepEqual(r.result, { threadId: launch.threadId, resumed: false });
  await o.act('thread.fork', { sourceThreadId: 't-idle', sourcePoint: { type: 'latest_stable' } }, { operationId: 'f-1' });
  const fork = dispatched('thread.fork')[0];
  assert.equal(fork.targetThreadId, deriveUuid('t3-connector-ops', ENV_ID, 'thread.fork', 'f-1', 'thread'));
  o.close();
});

test('act validates modelSelection against server.getConfig and sends nothing when it is not offered', async () => {
  const o = ops();
  await assert.rejects(o.act('thread.model-selection.set', { threadId: 't-idle', modelSelection: { instanceId: 'nope', model: 'x' } }, { operationId: 'm-1' }),
    (e) => e.code === 'provider_instance_unavailable' && e.details.sent === false);
  await assert.rejects(o.act('provider.switch', { threadId: 't-idle', modelSelection: { instanceId: 'codex', model: 'gpt-9' } }, { operationId: 'm-2' }), { code: 'provider_model_unavailable' });
  await assert.rejects(o.act('t3_thread_configure', { threadId: 't-idle', modelSelection: { instanceId: 'codex', model: 'gpt', options: [{ id: 'reasoningEffort', value: 'max' }] } }, { operationId: 'm-3' }), { code: 'model_option_value_unsupported' });
  assert.deepEqual(calls.filter((c) => c.tag !== 'server.getConfig'), []);
  o.close();
});

test('t3_thread_configure: same instance → thread.model-selection.set, another → provider.switch; effort shows in list', async () => {
  const o = ops();
  const same = await o.act('t3_thread_configure', { threadId: 't-idle', modelSelection: { instanceId: 'claudeAgent', model: 'opus', options: [{ id: 'effort', value: 'low' }] } }, { operationId: 'c-1' });
  assert.equal(same.result.command, 'thread.model-selection.set');
  assert.equal((await o.list()).find((t) => t.threadId === 't-idle').effort, 'low');
  const other = await o.act('t3_thread_configure', { threadId: 't-idle', modelSelection: { instanceId: 'codex', model: 'gpt', options: [{ id: 'reasoningEffort', value: 'high' }] } }, { operationId: 'c-2' });
  assert.equal(other.result.command, 'provider.switch');
  assert.deepEqual(dispatched('provider.switch')[0].modelSelection, { instanceId: 'codex', model: 'gpt', options: [{ id: 'reasoningEffort', value: 'high' }] });
  const summary = (await o.list()).find((t) => t.threadId === 't-idle');
  assert.equal(summary.effort, 'high');
  assert.equal(summary.modelSelection.instanceId, 'codex');
  // The explicit actions stay available as they are.
  await o.act('thread.model-selection.set', { threadId: 't-idle', modelSelection: { instanceId: 'codex', model: 'gpt' } }, { operationId: 'c-3' });
  assert.equal(dispatched('thread.model-selection.set').length, 2);
  o.close();
});

test('act thread.send: steer needs targetRunId, queue needs explicit intent, messageId = commandId', async () => {
  const o = ops();
  await assert.rejects(o.act('thread.send', { threadId: 't-run', text: 'fix', clientRequestId: 's-1', delivery: 'steer_active' }), { code: 'target_run_id_required' });
  await assert.rejects(o.act('thread.send', { threadId: 't-run', text: 'later', clientRequestId: 's-2', delivery: 'queue_after_active' }), { code: 'queue_explicit_intent_required' });
  await assert.rejects(o.act('thread.send', { threadId: 't-run', text: 'x', clientRequestId: 's-3', delivery: 'start_immediately' }, { operationId: 'other' }), { code: 'request_id_mismatch' });
  assert.deepEqual(calls, []);
  const r = await o.act('thread.send', { threadId: 't-run', text: 'fix', clientRequestId: 's-4', delivery: 'steer_active', targetRunId: 'run-9' });
  const d = dispatched('message.dispatch')[0];
  assert.deepEqual(d.dispatchMode, { type: 'steer_active', targetRunId: 'run-9' });
  assert.equal(d.messageId, d.commandId);
  assert.equal(r.ids.messageId, r.commandId);
  assert.equal(r.operationId, 's-4');
  o.close();
});

test('act: a typed T3 refusal is t3_refused with the native error; the socket survives', async () => {
  const o = ops();
  await assert.rejects(o.act('thread.pull-request.watch', { threadId: 't-idle', host: 'github.com', repository: 'a/b', number: 3, watching: true }, { operationId: 'w-1' }),
    (e) => e.code === 't3_refused' && e.details.native.code === 'OrchestrationCommandInvalid');
  assert.equal(typeof (await o.act('thread.unpin', { threadId: 't-idle' }, { operationId: 'u-1' })).result.sequence, 'number');
  o.close();
});

test('act native write t3_project_update and project.delete guard with the active+archived count', async () => {
  const o = ops();
  const r = await o.act('t3_project_update', { projectId: 'p2', title: 'Renamed' }, { operationId: 'pu-1' });
  const mutate = calls.find((c) => c.tag === 'projects.mutate').payload;
  assert.equal(mutate.type, 'project.update');
  assert.equal(mutate.commandId, r.commandId);
  assert.equal(r.result.title, 'Renamed');
  await assert.rejects(o.act('project.delete', { projectId: 'p1' }, { operationId: 'pd-1' }), { code: 'project_not_empty' });
  await assert.rejects(o.act('project.delete-force', { projectId: 'p1', force: true, confirmProjectId: 'p1', expectedThreadCount: 2 }, { operationId: 'pd-2' }), { code: 'project_count_changed' });
  const del = await o.act('project.delete', { projectId: 'p3' }, { operationId: 'pd-3' });
  assert.deepEqual(del.result, { projectId: 'p3', deletedAt: '2026-10-07T12:00:00Z', postCheck: 'clean', liveThreadsAfterDelete: 0 });
  assert.equal(calls.filter((c) => c.payload?.type === 'project.delete').length, 1);
  o.close();
});

test('archive and unarchive end to end: archived threads are found and listed', async () => {
  const o = ops();
  await o.act('thread.archive', { threadId: 't-idle' }, { operationId: 'a-1' });
  assert.ok(!(await o.list()).some((t) => t.threadId === 't-idle'));
  assert.deepEqual((await o.list({ archived: true })).map((t) => t.threadId).sort(), ['t-arch', 't-idle']);
  assert.equal((await o.thread('t-idle')).archivedAt, '2026-10-07T12:00:00Z');
  assert.equal((await o.query('thread', { threadId: 't-idle' })).threadId, 't-idle');
  await o.act('thread.unarchive', { threadId: 't-idle' }, { operationId: 'a-2' });
  assert.ok((await o.list()).some((t) => t.threadId === 't-idle'));
  assert.deepEqual((await o.list({ settled: true })).map((t) => t.threadId), ['t-done']);
  o.close();
});

test('query thread: detailed state with pendingRequests content and nextAction; pending_requests list and read', async () => {
  state.threads[2].pendingRuntimeRequest = { id: 'rq-1', kind: 'user_input', createdAt: '2026-10-07T11:00:00Z' };
  state.requests['t-ask'] = [{
    request: { id: 'rq-1', kind: 'user_input', status: 'pending', createdAt: '2026-10-07T11:00:00Z', responseCapability: { type: 'live' } },
    item: { type: 'user_input_request', requestId: 'rq-1', questions: [{ id: 'q1', header: 'Push', question: 'Push now?', options: [{ label: 'Yes', description: 'push' }] }] },
  }];
  const o = ops();
  const d = await o.query('thread', { threadId: 't-ask' });
  assert.deepEqual(d.environment, { alias: 'test', environmentId: ENV_ID });
  assert.equal(d.state, 'needs_intervention');
  assert.equal(d.pendingRequests[0].requestId, 'rq-1');
  assert.equal(d.pendingRequests[0].content.questions[0].id, 'q1');
  assert.equal(d.pendingRequests[0].nextAction.action, 'runtime-request.answer');
  assert.ok('activeRun' in d && 'latestRun' in d && 'providerSession' in d && 'runtimeMode' in d);
  const list = await o.query('pending_requests', { threadId: 't-ask' });
  assert.equal(list.total, 1);
  assert.equal((await o.query('pending_requests', { threadId: 't-ask', requestId: 'rq-1' })).request.kind, 'user_input');
  await assert.rejects(o.query('pending_requests', { threadId: 't-ask', requestId: 'nope' }), { code: 'request_not_found' });
  await assert.rejects(o.query('thread', { threadId: 'nope' }), { code: 'thread_not_found' });
  await assert.rejects(o.query('thread', { threadId: 't-ask', environment: 'elsewhere' }), { code: 'not_found' });
  await assert.rejects(o.query('nope'), { code: 'query_unknown' });
  o.close();
});

test('query: native read t3_thread_configuration, attention, search, messages, read_batch', async () => {
  const o = ops();
  assert.deepEqual(await o.query('t3_thread_configuration', { threadId: 't-idle' }),
    { threadId: 't-idle', modelSelection: state.threads[0].modelSelection, runtimeMode: 'full-access', interactionMode: 'default' });
  await assert.rejects(o.query('t3_thread_configuration', {}), { code: 'input_invalid' });
  const att = await o.query('attention');
  assert.deepEqual(att.threads.map((t) => t.threadId), ['t-ask']);
  assert.equal(att.complete, true);
  assert.deepEqual((await o.query('search', { search: 'idle' })).threads.map((t) => t.threadId), ['t-idle']);
  assert.deepEqual((await o.query('messages', { threadId: 't-idle', limit: 2 })).messages.map((m) => m.messageId), ['tool', 'm3']);
  const batch = await o.query('read_batch', { items: [{ threadId: 't-idle' }, { threadId: 'nope' }] });
  assert.deepEqual(batch.items.map((i) => i.status), ['ok', 'error']);
  assert.equal(batch.items[0].thread.model.effort, 'high');
  const cp = await o.query('control_plane', { limit: 5 });
  assert.equal(cp.needsIntervention.total, 1);
  o.close();
});

test('query wait: terminal run answers at once; the ops ceiling is larger than the MCP one', async () => {
  state.threads.push({ id: 't-ok', projectId: 'p1', title: 'Ok', status: 'completed', latestRunId: 'run-1' });
  const o = ops();
  const w = await o.query('wait', { threadId: 't-ok', timeoutMs: 1000 });
  assert.equal(w.returnReason, 'terminal');
  assert.equal(w.state, 'completed');
  assert.ok(OPS_WAIT_MAX_MS > 5000);
  await assert.rejects(o.query('wait', { threadId: 't-ok', timeoutMs: OPS_WAIT_MAX_MS + 1 }), { code: 'input_invalid' });
  o.close();
});

test('insecureHttp: the WebSocket transport accepts ws: to a non-loopback host only when the environment declared it', async () => {
  const sock = (url) => Object.assign(new EventTarget(), { url, readyState: 1, send() {}, close() {} });
  const url = 'ws://sirius.example.ts.net:3773/ws?orchestrationProtocol=2&wsTicket=t';
  assert.throws(() => new StagingRpcTransport({ socket: sock(url), onFailure() {}, allowLoopback: true }), /control_socket_invalid/);
  assert.ok(new StagingRpcTransport({ socket: sock(url), onFailure() {}, allowLoopback: true, allowInsecureWs: true }));
  // Through ops: http://localhost is plain HTTP to a host the loopback rule does not cover for ws:.
  const local = base.replace('127.0.0.1', 'localhost');
  const env = (insecureHttp) => ({ alias: 'tail', aliases: [], environmentId: ENV_ID, url: local, insecureHttp, ssh: null, tokenFile: '/x' });
  const yes = createOps(env(true), { readToken: () => 'tok', WebSocketImpl: FakeSocket });
  assert.equal((await yes.providers()).length, 2);
  assert.equal(typeof (await yes.act('thread.pin', { threadId: 't-idle' }, { operationId: 'ins-1' })).result.sequence, 'number');
  yes.close();
  const no = createOps(env(false), { readToken: () => 'tok', WebSocketImpl: FakeSocket });
  await assert.rejects(no.act('thread.pin', { threadId: 't-idle' }, { operationId: 'ins-2' }), { code: 'control_socket_invalid' });
  no.close();
});
