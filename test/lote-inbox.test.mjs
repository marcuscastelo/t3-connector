import test from 'node:test';
import assert from 'node:assert/strict';
import { startConnector } from './oauth-apoio.mjs';
import { ambientesFalsos, dadosPadrao } from './apoio.mjs';
import { memoryJournal } from './escrita-fixtures.mjs';
import { t3Tools } from '../src/oauth/t3-tools.mjs';
import { sessionWrites } from '../src/oauth/session-writes.mjs';
import { SessionAuthority } from '../src/oauth/session-authority.mjs';
import { ACTIONS } from '../src/escrita/adapters.mjs';
import { admitirLote } from '../src/escrita/lote-inbox.mjs';

const TOOL = 't3_thread_inbox_update_batch';
const AMANHA = '2026-10-06T09:00:00-03:00', AMANHA_UTC = '2026-10-06T12:00:00.000Z';

// Two environments with the same project and thread IDs, so routing must keep them apart.
function conexaoFalsa(alias, environmentId, { invoke } = {}) {
  const calls = [];
  const c = {
    calls, threads: { thread: 'app', 't-outro': 'outro' },
    registro: { alias, environmentId, destination: `t3://${environmentId}`, acoes: ['thread.send', 'thread.snooze', 'thread.unsnooze'] },
    inventario: async () => [{ id: 'app', name: 'app', directory: `/${alias}/app` }, { id: 'outro', name: 'outro', directory: `/${alias}/outro` }],
    adapter: {
      prepare: async () => {},
      projectForThread: async id => c.threads[id],
      invoke: async (m, p) => { calls.push({ m, p }); if (c.invokeHook) return c.invokeHook(p, calls.length); return { sequence: calls.length }; },
      receipt: r => ({ sequence: r.sequence }),
      reconcile: async r => ({ found: r.state === 'completed', state: 'unknown' }),
    },
    fechar() {},
  };
  if (invoke) c.invokeHook = invoke;
  return c;
}

async function montar(t, { writeProjects = null } = {}) {
  const l = conexaoFalsa('local', 'env-p'), r = conexaoFalsa('remoto', 'env-s');
  const journal = { ...memoryJournal(), audit: () => {} };
  const c = await startConnector({ tools: t3Tools({ ambientes: ambientesFalsos(), conexoes: [l, r], journal, writeProjects, projectPolicy: 'restricted' }) });
  t.after(c.close);
  const batch = (at, args) => c.callTool(at, TOOL, args);
  return { c, l, r, journal, batch };
}
const body = res => JSON.parse(res.data.result.content[0].text);
const errorText = res => res.data.result?.isError ? res.data.result.content[0].text : null;
const sent = c => c.calls.length;
const item = (key, over = {}) => ({ key, environment: 'local', threadId: 'thread', expectedProjectId: 'app', operationId: `op-${key}`, snoozedUntil: AMANHA, ...over });

test('catalog: the batch tool is a strict write tool with a homogeneous action and per-item targets', async t => {
  const { c } = await montar(t);
  const at = (await c.signIn()).tokens.access_token;
  const tool = (await c.mcp(at, 'tools/list')).data.result.tools.find(x => x.name === TOOL);
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required.sort(), ['action', 'batchId', 'items']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['snooze', 'unsnooze']);
  assert.equal(tool.inputSchema.properties.items.maxItems, 20);
  assert.deepEqual(tool.inputSchema.properties.items.items.required.sort(), ['environment', 'expectedProjectId', 'key', 'operationId', 'threadId']);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.match(tool.description, /never pass a title/);
  const legacy = await c.callTool(at, TOOL, { batchId: 'b', action: 'snooze', items: [{ ...item('a'), ambiente: 'local' }] });
  assert.ok(legacy.data.error || legacy.data.result?.isError, 'unknown item keys are refused');
});

test('partial success: refused items do not stop the others; one result per item in order', async t => {
  const { c, l, r, batch } = await montar(t);
  const at = (await c.signIn()).tokens.access_token;
  const res = body(await batch(at, { batchId: 'round-1', action: 'snooze', items: [
    item('ok'),
    item('missing', { threadId: 'gone' }),
    item('moved', { environment: 'remoto', expectedProjectId: 'outro' }),
    item('nowhere', { environment: 'marte' }),
    item('ok2', { environment: 'remoto', threadId: 't-outro', expectedProjectId: 'outro', snoozedUntil: '2026-10-07T12:00:00Z' }),
  ] }));
  assert.deepEqual(res.items.map(i => [i.key, i.status, i.error?.code]), [
    ['ok', 'applied', undefined], ['missing', 'rejected', 'thread_not_found'], ['moved', 'rejected', 'precondition_failed'],
    ['nowhere', 'rejected', 'environment_unknown'], ['ok2', 'applied', undefined]]);
  assert.equal(res.replay, false);
  assert.equal(res.complete, true);
  assert.equal(res.allSucceeded, false);
  assert.deepEqual(res.summary, { applied: 2, rejected: 3, failed: 0, uncertain: 0, not_started: 0, replayed: 0 });
  assert.equal(res.stopped, undefined);
  assert.deepEqual(res.items[0].environment, { alias: 'local', environmentId: 'env-p' });
  assert.equal(res.items[3].environment, null);
  assert.match(res.items[2].error.message, /nothing was sent/);
  // Only the two applied items reached T3, each in its own environment, with the instant in UTC.
  assert.equal(sent(l), 1); assert.equal(sent(r), 1);
  assert.equal(l.calls[0].p.type, 'thread.snooze');
  assert.equal(l.calls[0].p.threadId, 'thread');
  assert.equal(l.calls[0].p.snoozedUntil, AMANHA_UTC);
  assert.equal(r.calls[0].p.snoozedUntil, '2026-10-07T12:00:00.000Z');
});

test('distinct environments: the same threadId in two environments is two targets, each routed to its own', async t => {
  const { c, l, r, batch } = await montar(t);
  const at = (await c.signIn()).tokens.access_token;
  const res = body(await batch(at, { batchId: 'both', action: 'snooze', items: [item('l'), item('r', { environment: 'remoto' })] }));
  assert.equal(res.allSucceeded, true);
  assert.deepEqual(res.items.map(i => i.environment.environmentId), ['env-p', 'env-s']);
  assert.equal(sent(l), 1); assert.equal(sent(r), 1);
});

test('unsnooze sends thread.unsnooze with the user reason and refuses snoozedUntil', async t => {
  const { c, l, batch } = await montar(t);
  const at = (await c.signIn()).tokens.access_token;
  const { snoozedUntil, ...semData } = item('u');
  const res = body(await batch(at, { batchId: 'wake', action: 'unsnooze', items: [semData] }));
  assert.equal(res.items[0].status, 'applied');
  assert.equal(l.calls[0].p.type, 'thread.unsnooze');
  assert.equal(l.calls[0].p.reason, 'user');
  assert.match(errorText(await batch(at, { batchId: 'wake-2', action: 'unsnooze', items: [item('u2')] })), /^snoozed_until_not_allowed: .*\(item key "u2"\)/);
});

test('duplicates and malformed items reject the whole call before anything is reserved or sent', async t => {
  const { c, l, batch } = await montar(t);
  const at = (await c.signIn()).tokens.access_token;
  const cases = [
    [[item('a'), item('a', { operationId: 'op-z' })], /^duplicate_key: .*"a"/],
    [[item('a'), item('b', { environment: 'env-p' })], /^duplicate_target: .*"b"/],
    [[item('a'), item('b', { threadId: 't-outro', expectedProjectId: 'outro', operationId: 'op-a' })], /^duplicate_operation_id: .*"b"/],
    [[item('a', { snoozedUntil: undefined })], /^snoozed_until_required/],
    [[item('a', { snoozedUntil: 'amanhã 9h' })], /^snoozed_until_invalid/],
    [[item('a', { snoozedUntil: '2026-10-06T09:00:00' })], /^snoozed_until_invalid/],
  ];
  for (const [items, pattern] of cases) assert.match(errorText(await batch(at, { batchId: 'same-id', action: 'snooze', items })) ?? 'no error', pattern);
  assert.equal(sent(l), 0);
  // No manifest was left behind: the batchId is still free.
  assert.equal(body(await batch(at, { batchId: 'same-id', action: 'snooze', items: [item('a')] })).items[0].status, 'applied');
  const big = await batch(at, { batchId: 'big', action: 'snooze', items: Array.from({ length: 21 }, (_, i) => item(`k${i}`, { threadId: `t${i}` })) });
  assert.ok(big.data.error || big.data.result?.isError, 'more than 20 items is refused by the schema');
  assert.equal(sent(l), 1);
});

test('idempotent retry: the same batchId replays the recorded results, even reordered or after a new sign-in, and never resends', async t => {
  const { c, l, batch } = await montar(t);
  const at = (await c.signIn()).tokens.access_token;
  const items = [item('a'), item('b', { threadId: 't-outro', expectedProjectId: 'outro' }), item('gone', { threadId: 'gone' })];
  const first = body(await batch(at, { batchId: 'round-2', action: 'snooze', items }));
  assert.deepEqual(first.items.map(i => i.status), ['applied', 'applied', 'rejected']);
  assert.equal(sent(l), 2);
  const again = body(await batch(at, { batchId: 'round-2', action: 'snooze', items }));
  assert.equal(again.replay, true);
  assert.deepEqual(again.items.map(i => [i.status, i.originalStatus]), [['replayed', 'applied'], ['replayed', 'applied'], ['replayed', 'rejected']]);
  assert.deepEqual(again.items[0].receipt, first.items[0].receipt);
  assert.equal(again.complete, true);
  assert.equal(again.allSucceeded, false);
  assert.equal(again.summary.replayed, 3);
  // Same items in another order are the same batch; the answer follows the new order.
  const reordered = body(await batch(at, { batchId: 'round-2', action: 'snooze', items: [...items].reverse() }));
  assert.deepEqual(reordered.items.map(i => i.key), ['gone', 'b', 'a']);
  const fresh = (await c.signIn()).tokens.access_token;
  assert.equal(body(await batch(fresh, { batchId: 'round-2', action: 'snooze', items })).replay, true);
  assert.equal(sent(l), 2);
  // Another value under the same batchId is a conflict, not a new batch.
  assert.match(errorText(await batch(at, { batchId: 'round-2', action: 'snooze', items: [item('a', { snoozedUntil: '2026-10-09T12:00:00Z' })] })), /^batch_conflict/);
  assert.match(errorText(await batch(at, { batchId: 'round-2', action: 'unsnooze', items: items.map(({ snoozedUntil, ...i }) => i) })), /^batch_conflict/);
  assert.equal(sent(l), 2);
});

test('operationIds already in the journal are replayed per item under a new batchId; another input conflicts', async t => {
  const { c, l, batch } = await montar(t);
  const at = (await c.signIn()).tokens.access_token;
  body(await batch(at, { batchId: 'b1', action: 'snooze', items: [item('a')] }));
  const res = body(await batch(at, { batchId: 'b2', action: 'snooze', items: [item('a'), item('n', { threadId: 't-outro', expectedProjectId: 'outro' })] }));
  assert.equal(res.replay, false);
  assert.deepEqual(res.items.map(i => [i.status, i.originalStatus]), [['replayed', 'applied'], ['applied', undefined]]);
  assert.equal(res.allSucceeded, true, 'a replayed applied operation counts as applied');
  assert.equal(sent(l), 2);
  const conflict = body(await batch(at, { batchId: 'b3', action: 'snooze', items: [item('a', { snoozedUntil: '2026-12-01T12:00:00Z' })] }));
  assert.equal(conflict.items[0].status, 'rejected');
  assert.equal(conflict.items[0].error.code, 'operation_conflict');
  assert.equal(sent(l), 2);
});

test('scope: an item outside the approved projects is refused without ending the session; the others apply', async t => {
  const { c, l, batch } = await montar(t, { writeProjects: new Map([['local', new Set(['app'])], ['remoto', new Set(['app'])]]) });
  const at = (await c.signIn()).tokens.access_token;
  const res = body(await batch(at, { batchId: 'scoped', action: 'snooze', items: [item('out', { threadId: 't-outro', expectedProjectId: 'outro' }), item('in')] }));
  assert.deepEqual(res.items.map(i => [i.status, i.error?.code]), [['rejected', 'scope_denied'], ['applied', undefined]]);
  assert.equal(sent(l), 1);
  assert.equal((await c.mcp(at, 'tools/list')).status, 200);
});

test('uncertain send stops the batch and ends the sessions; after reconnecting the same call recovers the recorded outcome without resending', async t => {
  const { c, l, batch } = await montar(t);
  l.invokeHook = (p, n) => { if (n === 2) throw new Error('socket hang up'); return { sequence: n }; };
  const at = (await c.signIn()).tokens.access_token;
  const items = [item('a'), item('b', { threadId: 't-outro', expectedProjectId: 'outro' }), item('c', { environment: 'remoto' })];
  const res = await batch(at, { batchId: 'round-3', action: 'snooze', items });
  // The session ended during the call, so the facade withholds the envelope.
  assert.match(errorText(res), /^session_expired/);
  assert.equal(sent(l), 2);
  const fresh = (await c.signIn()).tokens.access_token;
  const rec = body(await batch(fresh, { batchId: 'round-3', action: 'snooze', items }));
  assert.equal(rec.replay, true);
  assert.deepEqual(rec.stopped, { reason: 'uncertain_send', key: 'b' });
  assert.deepEqual(rec.items.map(i => [i.key, i.status, i.originalStatus, i.error?.code]), [
    ['a', 'replayed', 'applied', undefined], ['b', 'replayed', 'uncertain', 'reconciliation_required'], ['c', 'not_started', undefined, 'batch_stopped']]);
  assert.equal(rec.items[1].reconciliationRequired, true);
  assert.equal(rec.complete, false);
  assert.equal(sent(l), 2);
  const recon = body(await c.callTool(fresh, 't3_reconciliar_escrita', { environment: 'local', operationId: 'op-b' }));
  assert.equal(recon.state, 'uncertain');
});

// Direct calls: deadline, cancellation and a concurrent repeat of a batch still running.
function direto({ invoke } = {}) {
  const authority = new SessionAuthority();
  const l = conexaoFalsa('local', 'env-p', { invoke });
  const env = { alias: 'local', environmentId: 'env-p', label: 'local', destination: 't3://env-p', projects: [{ id: 'app', name: 'app', directory: '/a', workspaceRoots: ['/a'] }, { id: 'outro', name: 'outro', directory: '/o', workspaceRoots: ['/o'] }], actions: ['thread.snooze', 'thread.unsnooze'], readProjectIds: ['app', 'outro'] };
  const sub = 'local:abcdefghijkl', sid = authority.create({ sub, clientId: 'c', credentialId: 'k', scope: 'connector:write', resource: 'r', grants: { scopeVersion: 2, runtimeMode: 'full-access', environments: [env] } });
  const journal = { ...memoryJournal(), audit() {} };
  const w = sessionWrites({ conexoes: [l], journal, authority, issuer: 'https://as.example' });
  return { w, l, journal, principal: { sid, sub }, authority };
}
const tres = [item('a'), item('b', { threadId: 't-outro', expectedProjectId: 'outro' }), item('c', { threadId: 't-x' })];

test('deadline: items left when it passes are not_started and nothing is sent for them', async () => {
  const d = direto({ invoke: async (p, n) => { await new Promise(r => setTimeout(r, 30)); return { sequence: n }; } });
  d.l.threads['t-x'] = 'app';
  const res = await d.w.inboxBatch(d.principal, { batchId: 'slow', action: 'snooze', items: tres }, { deadlineMs: 10 });
  assert.deepEqual(res.items.map(i => i.status), ['applied', 'not_started', 'not_started']);
  assert.deepEqual(res.stopped, { reason: 'deadline', key: 'b' });
  assert.equal(res.complete, false);
  assert.equal(sent(d.l), 1);
});

test('cancellation stops admitting items; it does not undo the applied one', async () => {
  const ac = new AbortController();
  const d = direto({ invoke: async (p, n) => { ac.abort(); return { sequence: n }; } });
  d.l.threads['t-x'] = 'app';
  const res = await d.w.inboxBatch(d.principal, { batchId: 'cancel', action: 'snooze', items: tres }, { signal: ac.signal });
  assert.deepEqual(res.items.map(i => i.status), ['applied', 'not_started', 'not_started']);
  assert.equal(res.stopped.reason, 'cancelled');
  assert.equal(sent(d.l), 1);
});

test('repeating a batch that is still running only inspects it: inProgress, in-flight item uncertain, nothing sent twice', async () => {
  let release;
  const d = direto({ invoke: (p, n) => (n === 2 ? new Promise(r => { release = () => r({ sequence: n }); }) : { sequence: n }) });
  d.l.threads['t-x'] = 'app';
  const running = d.w.inboxBatch(d.principal, { batchId: 'live', action: 'snooze', items: tres });
  while (!release) await new Promise(r => setImmediate(r));
  const peek = await d.w.inboxBatch(d.principal, { batchId: 'live', action: 'snooze', items: tres });
  assert.equal(peek.replay, true);
  assert.equal(peek.inProgress, true);
  assert.equal(peek.complete, false);
  assert.deepEqual(peek.items.map(i => [i.status, i.originalStatus]), [['replayed', 'applied'], ['replayed', 'uncertain'], ['not_started', undefined]]);
  assert.equal(sent(d.l), 2);
  release();
  const done = await running;
  assert.deepEqual(done.items.map(i => i.status), ['applied', 'applied', 'applied']);
  assert.equal(sent(d.l), 3);
  const after = await d.w.inboxBatch(d.principal, { batchId: 'live', action: 'snooze', items: tres });
  assert.equal(after.inProgress, undefined);
  assert.equal(after.allSucceeded, true);
});

test('replay is bound to the caller: another subject never sees the manifest and a revoked session cannot read it', async () => {
  const d = direto();
  await d.w.inboxBatch(d.principal, { batchId: 'mine', action: 'snooze', items: [item('a')] });
  const env = d.authority.check(d.principal.sid).grants;
  const otherSub = 'local:otherSubject001', otherSid = d.authority.create({ sub: otherSub, clientId: 'c', credentialId: 'k', scope: 'connector:write', resource: 'r', grants: env });
  // Same batchId for another subject is another batch; its operationId is in another journal namespace too.
  const other = await d.w.inboxBatch({ sid: otherSid, sub: otherSub }, { batchId: 'mine', action: 'snooze', items: [item('a')] });
  assert.equal(other.replay, false);
  assert.equal(other.items[0].status, 'applied');
  d.authority.revoke(d.principal.sid);
  await assert.rejects(d.w.inboxBatch(d.principal, { batchId: 'mine', action: 'snooze', items: [item('a')] }), /lease_closed/);
});

test('admission normalizes offsets and hashes independently of order and of alias versus environmentId', () => {
  const resolver = k => { if (k === 'local' || k === 'env-p') return { alias: 'local', environmentId: 'env-p', destination: 't3://env-p' }; throw new Error('ambiente_desconhecido'); };
  const a = admitirLote({ batchId: 'x', action: 'snooze', items: [item('a'), item('b', { threadId: 't2' })] }, resolver);
  const b = admitirLote({ batchId: 'x', action: 'snooze', items: [item('b', { threadId: 't2', environment: 'env-p' }), item('a', { snoozedUntil: AMANHA_UTC })] }, resolver);
  assert.equal(a.hash, b.hash);
  assert.equal(a.itens[0].snoozedUntil, AMANHA_UTC);
  const c = admitirLote({ batchId: 'x', action: 'snooze', items: [item('a', { environment: 'marte' })] }, resolver);
  assert.equal(c.itens[0].env, null);
});

test('OAuth all: batch items use the live consented shell for the project check and the Dispatcher path', async t => {
  const data = dadosPadrao(), reads = ambientesFalsos(data), journal = { ...memoryJournal(), audit() {} };
  const connections = reads.registros.map(r => {
    const d = data[r.alias];
    const c = { registro: { ...r, destination: `t3://${r.environmentId}`, acoes: ACTIONS }, calls: [],
      inventario: async () => { throw new Error('unused'); },
      cliente: async () => ({ shell: async () => structuredClone(d.shell) }),
      adapter: { prepare: async () => {}, invoke: async (method, payload) => { c.calls.push({ method, payload }); return { sequence: c.calls.length }; }, receipt: x => x, reconcile: async () => ({ found: false }) }, fechar() {} };
    return c;
  });
  const c = await startConnector({ tools: t3Tools({ ambientes: reads, conexoes: connections, journal, projectPolicy: 'all' }) }); t.after(c.close);
  const at = (await c.signIn()).tokens.access_token;
  const res = body(await c.callTool(at, TOOL, { batchId: 'all-1', action: 'snooze', items: [
    { key: 'l', environment: 'local', threadId: 't-comum', expectedProjectId: 'proj-app-local', operationId: 'all-l', snoozedUntil: AMANHA },
    { key: 'r', environment: 'remoto', threadId: 't-comum', expectedProjectId: 'mcp-project:app-remoto', operationId: 'all-r', snoozedUntil: AMANHA },
    { key: 'wrong', environment: 'remoto', threadId: 't-llm', expectedProjectId: 'proj-app-local', operationId: 'all-w', snoozedUntil: AMANHA },
    { key: 'deleted', environment: 'local', threadId: 't-nope', expectedProjectId: 'proj-app-local', operationId: 'all-d', snoozedUntil: AMANHA },
  ] }));
  assert.deepEqual(res.items.map(i => [i.key, i.status, i.error?.code]), [['l', 'applied', undefined], ['r', 'applied', undefined], ['wrong', 'rejected', 'precondition_failed'], ['deleted', 'rejected', 'thread_not_found']]);
  assert.deepEqual(connections.map(x => x.calls.length), [1, 1]);
  assert.equal(connections[1].calls[0].payload.snoozedUntil, AMANHA_UTC);
  const again = body(await c.callTool(at, TOOL, { batchId: 'all-1', action: 'snooze', items: [
    { key: 'l', environment: 'local', threadId: 't-comum', expectedProjectId: 'proj-app-local', operationId: 'all-l', snoozedUntil: AMANHA },
    { key: 'r', environment: 'env-remoto', threadId: 't-comum', expectedProjectId: 'mcp-project:app-remoto', operationId: 'all-r', snoozedUntil: AMANHA_UTC },
    { key: 'wrong', environment: 'remoto', threadId: 't-llm', expectedProjectId: 'proj-app-local', operationId: 'all-w', snoozedUntil: AMANHA },
    { key: 'deleted', environment: 'local', threadId: 't-nope', expectedProjectId: 'proj-app-local', operationId: 'all-d', snoozedUntil: AMANHA },
  ] }));
  assert.equal(again.replay, true, 'alias/environmentId and offset/UTC spellings are the same batch');
  assert.deepEqual(again.items.map(i => i.originalStatus), ['applied', 'applied', 'rejected', 'rejected']);
  assert.deepEqual(connections.map(x => x.calls.length), [1, 1]);
});
