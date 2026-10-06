// Settlement/settleGuard v2: bloqueios projetados de execution.continuation.blockers, fundo
// desconhecido bloqueia, obs2_ cobre workspace, resposta e fundo. v1 continua igual.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { avaliarGuard, lerObservacao, observarSettlement } from '../src/settlement.mjs';
import { Dispatcher } from '../src/escrita/adapters.mjs';
import { criarPonteEscrita } from '../src/escrita/ponte-mcp.mjs';
import { setup, memoryJournal } from './escrita-fixtures.mjs';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao } from './apoio.mjs';
import { mensagem, pedido, projecao, thread } from './fixtures.mjs';

const runs1 = [{ id: 'run-1', ordinal: 1, status: 'completed' }];
const resposta = (campos = {}) => mensagem({ id: 'msg-a', role: 'assistant', runId: 'run-1', text: 'Feito e verificado.', ...campos });
// Servidor com roster (providerThreads presente): ausência de fundo provada.
const snap = (campos = {}) => ({ snapshotSequence: 50, projection: { ...projecao({ runs: runs1, mensagens: [resposta()] }), thread: { id: 'thread-1', activeProviderThreadId: 'pt-1' }, providerThreads: [{ id: 'pt-1', pendingBackgroundTasks: [] }], ...campos } });
const obs = (version, t = {}, s = snap()) => observarSettlement({ environmentId: 'env-local', thread: thread(t), snapshot: s, version });
const guard = (o, campos = {}) => ({ version: o.contractVersion, expectedRunId: o.expectedRunId, expectedObservationId: o.observationId, acceptance: { accepted: true, evidenceRef: 'review:ok' }, ...campos });
const roster = (tasks) => snap({ providerThreads: [{ id: 'pt-1', pendingBackgroundTasks: tasks }] });

test('v2: elegível com roster vazio; obs2_ e contractVersion 2; v1 da mesma leitura segue obs1_', () => {
  const v2 = obs(2);
  assert.equal(v2.contractVersion, 2);
  assert.match(v2.observationId, /^obs2_[0-9a-f]{32}$/);
  assert.deepEqual(v2.blockers, []);
  assert.equal(v2.eligibleMechanically, true);
  assert.equal(avaliarGuard(guard(v2), v2), null);
  const v1 = obs(1);
  assert.match(v1.observationId, /^obs1_/);
  assert.deepEqual(v1.guardVersions, [1, 2]);
});

test('v2: fundo desconhecido (servidor sem roster) bloqueia como observação incompleta; v1 só avisa', () => {
  const semRoster = snap({ providerThreads: undefined });
  const v2 = obs(2, {}, semRoster);
  assert.deepEqual(v2.blockers, [{ code: 'background_work_unknown', knowledge: 'unknown' }]);
  assert.equal(v2.warnings.some((w) => w.code === 'background_work_unknown'), false);
  assert.equal(avaliarGuard(guard(v2), v2), 'settle_observation_incomplete');
  const v1 = obs(1, {}, semRoster);
  assert.deepEqual(v1.blockers, []);
  assert.ok(v1.warnings.some((w) => w.code === 'background_work_unknown'));
});

test('v2: plano só na projeção e limite com auto-resume bloqueiam (códigos de execution)', () => {
  const plano = obs(2, {}, snap({ plans: [{ id: 'plan-1', kind: 'proposed_plan', status: 'active' }] }));
  assert.deepEqual(plano.blockers, [{ code: 'proposed_plan' }]);
  assert.equal(avaliarGuard(guard(plano), plano), 'settle_unresolved_work');
  assert.deepEqual(obs(1, {}, snap({ plans: [{ id: 'plan-1', kind: 'proposed_plan', status: 'active' }] })).blockers, []);
  const auto = obs(2, { limitRecovery: { runId: 'run-1', autoResume: true } });
  assert.deepEqual(auto.blockers, [{ code: 'usage_limit_auto_resume', runId: 'run-1' }]);
  assert.equal(avaliarGuard(guard(auto), auto), 'settle_unresolved_work');
  assert.deepEqual(obs(1, { limitRecovery: { runId: 'run-1', autoResume: true } }).blockers, []);
});

test('v2: fundo que segura a thread bloqueia com a fonte; comando não; fila e pedido usam os códigos de execution', () => {
  const monitor = obs(2, {}, roster([{ taskId: 'mon-1', kind: 'monitor' }]));
  assert.deepEqual(monitor.blockers, [{ code: 'background_work_active', taskId: 'mon-1', backgroundKind: 'monitor', source: 'provider_roster' }]);
  assert.deepEqual(obs(2, {}, roster([{ taskId: 'cmd-1', kind: 'command' }])).blockers, []);
  const fila = obs(2, {}, snap({ runs: [...runs1, { id: 'run-2', ordinal: 2, status: 'queued', queueHeld: true }] }));
  assert.deepEqual(fila.blockers, [{ code: 'queued_runs', runId: 'run-2', queueHeld: true }]);
  assert.equal(avaliarGuard(guard(fila), fila), 'settle_queued_work');
  const req = obs(2, {}, snap({ runtimeRequests: [pedido({ id: 'req-7', kind: 'user_input' })] }));
  assert.deepEqual(req.blockers, [{ code: 'pending_request', requestId: 'req-7', kind: 'user_input' }]);
  assert.equal(avaliarGuard(guard(req), req), 'settle_pending_request');
});

test('v2: a shell só acrescenta (pedido, run ativo, roster que a projeção não traz)', () => {
  const o = obs(2, { pendingRuntimeRequest: { id: 'req-shell', kind: 'command' }, pendingBackgroundTasks: [{ kind: 'subagent', taskId: 'sub-1' }] });
  assert.deepEqual(o.blockers, [
    { code: 'pending_request', requestId: 'req-shell', kind: 'command', source: 'shell' },
    { code: 'background_work_active', taskId: 'sub-1', backgroundKind: 'subagent', source: 'shell_roster' },
  ]);
  const ativo = obs(2, { status: 'running', activeRunId: 'run-1', activityRunStatus: 'running' });
  assert.deepEqual(ativo.blockers.filter((b) => b.code === 'active_run'), [{ code: 'active_run', runId: 'run-1', status: 'running', source: 'shell' }]);
  assert.equal(avaliarGuard(guard(ativo), ativo), 'settle_active_run');
  // Shell atrasada (ainda completed) e run já rodando na projeção: o bloqueio vem de execution.
  const atrasada = obs(2, {}, snap({ runs: [{ id: 'run-1', ordinal: 1, status: 'running' }] }));
  assert.deepEqual(atrasada.blockers, [{ code: 'active_run', runId: 'run-1', status: 'running' }]);
  assert.equal(avaliarGuard(guard(atrasada), atrasada), 'settle_active_run');
});

test('v2: obs2_ muda com texto editado, tipo do fundo e workspace; obs1_ não vê o texto', () => {
  const base = obs(2);
  const editada = snap({ messages: [resposta({ text: 'Feito, mas os testes falharam.' })] });
  assert.notEqual(obs(2, {}, editada).observationId, base.observationId);
  assert.equal(obs(1, {}, editada).observationId, obs(1).observationId);
  assert.equal(avaliarGuard(guard(base), obs(2, {}, editada)), 'settle_observation_changed');
  const sub = obs(2, {}, roster([{ taskId: 't-1', kind: 'subagent' }]));
  assert.notEqual(obs(2, {}, roster([{ taskId: 't-1', kind: 'monitor' }])).observationId, sub.observationId);
  assert.notEqual(obs(2, { worktreePath: '/home/dev/outra' }).observationId, base.observationId);
  assert.notEqual(obs(2, { branch: 'outra' }).observationId, base.observationId);
});

test('aquisição exige coerência: versão, binding e mensagem da shell iguais à projeção (revisão 334a1840 P1)', async () => {
  const ler = (shellDe, projecao) => lerObservacao({ environmentId: 'env-local', threadId: 'thread-1', version: 2, lerShell: async () => ({ threads: [shellDe()] }), lerCompleto: async () => ({ snapshotSequence: 9, projection: projecao }) });
  const proj = (thread = {}) => ({ ...snap().projection, updatedAt: '2026-10-03T10:05:00.000Z', thread: { id: 'thread-1', activeProviderThreadId: 'pt-1', ...thread } });
  const t = (campos = {}) => () => thread({ updatedAt: '2026-10-03T10:05:00.000Z', ...campos });
  assert.equal((await ler(t(), proj())).complete, true);
  // Shell numa versão anterior à da projeção (shell_lagging): nunca completa.
  const atrasada = await ler(t({ updatedAt: '2026-10-03T10:04:00.000Z' }), proj());
  assert.equal(atrasada.complete, false);
  assert.equal(avaliarGuard({ version: 2, expectedRunId: 'run-1', expectedObservationId: 'x', acceptance: { accepted: true, evidenceRef: 'r' } }, atrasada), 'settle_observation_incomplete');
  // Workspace da shell (/repo/B) diferente do snapshot (/repo/A).
  assert.equal((await ler(t({ worktreePath: '/repo/B' }), proj({ worktreePath: '/repo/A' }))).complete, false);
  // Mensagem visível atualizada entre as duas leituras da shell, sem ID novo.
  let n = 0;
  const editando = () => thread({ updatedAt: '2026-10-03T10:05:00.000Z', latestVisibleMessage: { id: 'm-1', updatedAt: `2026-10-03T10:05:0${n++}.000Z` } });
  assert.equal((await ler(editando, proj())).complete, false);
});

test('guard: versão tem de bater com a observação; obs1 num guard v2 nunca confere; código novo não libera', () => {
  const v1 = obs(1);
  const v2 = obs(2);
  assert.equal(avaliarGuard(guard(v1, { version: 2 }), v2), 'settle_observation_changed');
  assert.equal(avaliarGuard(guard(v2, { version: 1 }), v2), 'settle_observation_incomplete');
  assert.equal(avaliarGuard(guard(v2), { ...v2, blockers: [{ code: 'something_new' }] }), 'settle_observation_incomplete');
  assert.equal(avaliarGuard(guard(v2, { version: 3 }), v2), 'settle_guard_version_unsupported');
});

// Dispatcher: o guard v2 observa na versão 2, recusa sem enviar e verifica na versão 2.
function mundo() {
  const st = { seq: 100, thread: thread({ id: 'thread', projectId: 'app' }), proj: { ...snap().projection, thread: { id: 'thread', activeProviderThreadId: 'pt-1' } } };
  const calls = [];
  const versoes = [];
  const adapter = {
    calls,
    verifyWorkspace: async () => true,
    projectForThread: async () => 'app',
    invoke: async (method, payload) => { calls.push({ method, payload }); st.seq++; st.thread = { ...st.thread, settledAt: '2026-10-05T12:00:00.000Z', settledOverride: 'settled' }; return { sequence: st.seq }; },
    receipt: (r) => ({ sequence: r.sequence }),
    reconcile: async () => ({ found: true }),
    settlementObservation: (threadId, { version } = {}) => {
      versoes.push(version);
      return lerObservacao({ environmentId: 'local', threadId, version, lerShell: async () => ({ threads: [st.thread] }), lerCompleto: async () => ({ snapshotSequence: st.seq, projection: st.proj }) });
    },
  };
  return { st, adapter, versoes };
}
async function preparar() {
  const s = setup();
  s.env.actions.push('thread.settle');
  const lease = await s.grant();
  const { st, adapter, versoes } = mundo();
  const d = new Dispatcher({ gate: s.gate, adapter, journal: memoryJournal(), environmentId: s.env.environmentId, destination: s.env.destination });
  const settle = (operationId, settleGuard) => d.dispatch(s.caller, lease.leaseId, { operationId, action: 'thread.settle', input: { threadId: 'thread', settleGuard } });
  return { st, adapter, versoes, settle };
}

test('dispatcher v2: observa na versão do guard, envia uma vez e verifica com contractVersion 2', async () => {
  const { adapter, versoes, settle } = await preparar();
  const o = await adapter.settlementObservation('thread', { version: 2 });
  versoes.length = 0;
  const r = await settle('v2-ok', guard(o));
  assert.equal(r.state, 'completed');
  assert.equal(r.settlement.contractVersion, 2);
  assert.equal(r.settlement.postCheck, 'verified');
  assert.deepEqual(versoes, [2, 2]);
  assert.equal(adapter.calls.length, 1);
  const replay = await settle('v2-ok', guard(o));
  assert.equal(replay.settlement.contractVersion, 2);
  assert.equal(adapter.calls.length, 1);
});

test('dispatcher v2: fundo desconhecido recusa antes do envio; obs1 num guard v2 recusa', async () => {
  const { st, adapter, settle } = await preparar();
  const o1 = await adapter.settlementObservation('thread', { version: 1 });
  await assert.rejects(settle('obs1-em-v2', { ...guard(o1), version: 2 }), /settle_observation_changed/);
  const o2 = await adapter.settlementObservation('thread', { version: 2 });
  st.proj = { ...st.proj, providerThreads: undefined };
  await assert.rejects(settle('sem-roster', guard(o2)), /settle_observation_incomplete/);
  assert.equal(adapter.calls.length, 0);
});

test('t3_thread e bridge: settlementContractVersion 2 traz settlement v2 da mesma observação', async () => {
  const d = dadosPadrao();
  d.local.completo = { 't-comum': { snapshotSequence: 77, projection: { ...d.local.bounded['t-comum'].projection, thread: { id: 't-comum' }, providerThreads: [] } } };
  const c = await conectarMcp(ambientesFalsos(d));
  const r = dados(await c.callTool({ name: 't3_thread', arguments: { threadId: 't-comum', settlementContractVersion: 2 } }));
  assert.equal(r.settlement.contractVersion, 2);
  assert.match(r.settlement.observationId, /^obs2_/);
  assert.equal(r.execution.source.kind, 'thread_full_snapshot');
  const server = criarPonteEscrita({ relay: async () => ({}), aliases: ['local'], approvalOrigin: 'http://localhost:7433' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const ponte = new Client({ name: 't', version: '0' });
  await ponte.connect(a);
  const { tools } = await ponte.listTools();
  assert.match(JSON.stringify(tools.find((t) => t.name === 't3_thread').inputSchema.properties.settlementContractVersion), /2/);
  await ponte.close();
});
