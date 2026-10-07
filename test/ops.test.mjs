// src/ops.mjs against a stateful fake T3 (HTTP server + fake WebSocket RPC).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { buildModelSelection, createOps, deriveUuid, findProject, refusal, resolveEnvironment, validateOpsConfig } from '../src/ops.mjs';

const ENV_ID = 'env-1';
let state, calls, server, base;

function reset() {
  calls = [];
  state = {
    scopes: ['orchestration:read', 'orchestration:operate', 'terminal:operate'],
    projects: [{ id: 'p1', title: 'Fleet', workspaceRoot: '/w/fleet' }, { id: 'p2', title: 'Revena', workspaceRoot: '/w/a' }, { id: 'p3', title: 'Revena', workspaceRoot: '/w/b' }],
    threads: [
      { id: 't-idle', projectId: 'p1', title: 'Idle', status: 'idle', createdBy: 'user' },
      { id: 't-run', projectId: 'p1', title: 'Running', status: 'running', createdBy: 'user' },
      { id: 't-ask', projectId: 'p1', title: 'Asking', status: 'idle', pendingRuntimeRequest: { kind: 'user_input' } },
      { id: 't-done', projectId: 'p1', title: 'Done', status: 'idle', settledAt: '2026-10-01T00:00:00Z' },
    ],
    messages: { 't-idle': [{ id: 'm1', role: 'user', text: 'one' }, { id: 'm2', role: 'assistant', text: 'two' }, { id: 'tool', role: 'tool', text: 'x' }, { id: 'm3', role: 'user', text: 'three' }] },
    providers: [{ instanceId: 'claudeAgent', models: [{ slug: 'opus', capabilities: { optionDescriptors: [{ id: 'effort', type: 'select', options: [{ id: 'low' }, { id: 'high' }] }] } }, { slug: 'plain', capabilities: { optionDescriptors: [] } }] },
      { instanceId: 'codex', models: [{ slug: 'gpt', capabilities: { optionDescriptors: [{ id: 'reasoningEffort', type: 'select', options: [{ id: 'high' }] }] } }] }],
  };
}

function rpc(tag, p) {
  calls.push({ tag, payload: p });
  if (tag === 'server.getConfig') return { environment: { environmentId: ENV_ID }, providers: state.providers };
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
    setImmediate(() => { const e = new Event('message'); e.data = JSON.stringify({ _tag: 'Exit', requestId: f.id, exit: { _tag: 'Success', value: rpc(f.tag, f.payload) } }); this.dispatchEvent(e); });
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
    if (url.pathname === '/api/orchestration/shell') return json({ threads: state.threads.filter((t) => !t.archivedAt), archivedThreads: [], projects: state.projects });
    const m = /^\/api\/orchestration\/threads\/([^/]+)(\/bounded|\/history)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const messages = state.messages[id] ?? [];
      if (m[2] === '/history') return json({ items: [{ item: { messageId: 'old-q', type: 'assistant_message', text: 'push v1 no repo?', ordinal: 0, startedAt: '2026-10-07T10:00:00Z' } }], hasMoreHistory: false });
      if (m[2] === '/bounded') return json({ projection: { messages, turnItems: messages.map((x, i) => ({ messageId: x.id, type: `${x.role}_message`, text: x.text, ordinal: i + 1, createdBy: 'user', creationSource: 'web', startedAt: '2026-10-07T11:00:00Z' })) }, hasMoreHistory: true, historyCursor: 'c1' });
      return json({ projection: { messages } });
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
