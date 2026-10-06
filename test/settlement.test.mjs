// Observação de settlement (contrato v1): fatos mecânicos para o host decidir
// continue/wait/ask/settle. completed != settled != aceite; pedido pendente e run ativo
// bloqueiam; qualquer mudança relevante troca o observationId.

import test from 'node:test';
import assert from 'node:assert/strict';
import { avaliarGuard, lerObservacao, observarSettlement } from '../src/settlement.mjs';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao } from './apoio.mjs';
import { mensagem, pedido, projecao, thread } from './fixtures.mjs';

const runs1 = [{ id: 'run-1', ordinal: 1, status: 'completed' }];
const snap = (campos = {}, seq = 50) => ({ snapshotSequence: seq, projection: { ...projecao({ runs: runs1, mensagens: [mensagem()] }), thread: { id: 'thread-1' }, ...campos } });
const observar = (t = {}, s = snap()) => observarSettlement({ environmentId: 'env-local', thread: thread(t), snapshot: s });
const guard = (o, campos = {}) => ({ version: 1, expectedRunId: o.expectedRunId, expectedObservationId: o.observationId, acceptance: { accepted: true, evidenceRef: 'review-ok' }, ...campos });

test('completed sem aceite: elegível mecanicamente, não liquidada, aceite continua obrigatório', () => {
  const o = observar();
  assert.equal(o.complete, true);
  assert.equal(o.state, 'completed');
  assert.equal(o.settled, false);
  assert.equal(o.eligibleMechanically, true);
  assert.equal(o.acceptanceRequired, true);
  assert.equal(o.expectedRunId, 'run-1');
  assert.match(o.observationId, /^obs1_[0-9a-f]{32}$/);
  assert.equal(avaliarGuard(guard(o, { acceptance: { accepted: false, evidenceRef: 'x' } }), o), 'settle_acceptance_required');
  assert.equal(avaliarGuard(guard(o), o), null);
  assert.equal(avaliarGuard(guard(o, { version: 2 }), o), 'settle_guard_version_unsupported');
});

test('pedido pendente só no snapshot completo bloqueia o settle', () => {
  const o = observar({}, snap({ runtimeRequests: [pedido({ id: 'req-7', kind: 'user_input' })] }));
  assert.deepEqual(o.blockers, [{ code: 'pending_request', requestId: 'req-7', kind: 'user_input' }]);
  assert.equal(o.eligibleMechanically, false);
  assert.equal(avaliarGuard(guard(o), o), 'settle_pending_request');
});

test('run ativo bloqueia mesmo com zero pedidos e run mais novo cancelado (steer)', () => {
  const s = snap({ runs: [{ id: 'run-1', ordinal: 1, status: 'running' }, { id: 'run-4', ordinal: 4, status: 'cancelled' }] });
  const o = observar({ status: 'cancelled', latestRunId: 'run-4', activeRunId: 'run-1', activityRunStatus: 'running' }, s);
  assert.equal(o.state, 'running');
  assert.deepEqual(o.blockers, [{ code: 'active_run', runId: 'run-1', status: 'running' }]);
  // Mesmo com expectedRunId velho, a recusa é pelo trabalho ativo.
  assert.equal(avaliarGuard(guard(o, { expectedRunId: 'run-0' }), o), 'settle_active_run');
});

test('fila retida, limite de uso, plano proposto e trabalho de fundo bloqueiam', () => {
  const fila = observar({}, snap({ runs: [...runs1, { id: 'run-2', ordinal: 2, status: 'queued', queueHeld: true }] }));
  assert.deepEqual(fila.blockers, [{ code: 'queued_work', runId: 'run-2', queueHeld: true }]);
  assert.equal(avaliarGuard(guard(fila), fila), 'settle_queued_work');
  const plano = observar({ hasActionableProposedPlan: true });
  assert.equal(plano.blockers[0].kind, 'proposed_plan');
  const fundo = observar({ pendingBackgroundTasks: [{ kind: 'shell', taskId: 'bg-1' }] });
  assert.deepEqual(fundo.blockers, [{ code: 'unresolved_work', kind: 'background_task', taskId: 'bg-1' }]);
  assert.equal(avaliarGuard(guard(fundo), fundo), 'settle_unresolved_work');
});

test('observationId muda com atividade e lifecycle, não com updatedAt', () => {
  const base = observar();
  assert.equal(observar({ updatedAt: '2026-10-09T00:00:00.000Z' }).observationId, base.observationId);
  const outraMensagem = observar({}, snap({ messages: [mensagem(), mensagem({ id: 'msg-2' })] }));
  const reaberta = observar({ unsettledAt: '2026-10-05T10:00:00.000Z' });
  const comPr = observar({ linkedPullRequest: { number: 1, url: 'https://x/1', state: 'merged' } });
  for (const o of [outraMensagem, reaberta, comPr]) {
    assert.notEqual(o.observationId, base.observationId);
    assert.equal(avaliarGuard(guard(base), o), 'settle_observation_changed');
  }
  assert.deepEqual(comPr.warnings, [{ code: 'linked_pr_merge_can_auto_settle' }]);
  const novoRun = observar({ latestRunId: 'run-2' }, snap({ runs: [...runs1, { id: 'run-2', ordinal: 2, status: 'completed' }] }));
  assert.equal(avaliarGuard(guard(base), novoRun), 'settle_run_changed');
});

test('snapshot sem runs/pedidos, de outra thread ou sem o último run é incompleto', () => {
  for (const s of [{ snapshotSequence: 1, projection: { thread: {} } }, snap({ thread: { id: 'outra' } }), snap({ runs: [] }), null]) {
    const o = observar({}, s);
    assert.equal(o.complete, false);
    assert.equal(o.observationId, null);
    assert.equal(o.blockers[0].code, 'observation_incomplete');
    assert.equal(avaliarGuard({ version: 1, expectedRunId: 'run-1', expectedObservationId: 'x', acceptance: { accepted: true, evidenceRef: 'r' } }, o), 'settle_observation_incomplete');
  }
});

test('campos opcionais ausentes ficam indisponíveis, não falsos', () => {
  const o = observar();
  assert.equal(o.fieldAvailability.pinnedAt, false);
  assert.equal(o.fieldAvailability.pullRequests, false);
  assert.equal(o.pinnedAt, null);
  assert.deepEqual(o.warnings, [{ code: 'linked_pr_state_unavailable' }]);
});

test('lerObservacao repete enquanto a thread muda na shell e desiste no limite', async () => {
  let n = 0;
  const instavel = { lerShell: async () => ({ threads: [thread({ latestVisibleMessage: { id: `m-${n++}` } })] }), lerCompleto: async () => snap() };
  const o = await lerObservacao({ environmentId: 'env-local', threadId: 'thread-1', ...instavel });
  assert.equal(o.complete, false);
  assert.equal(o.blockers[0].reason, 'thread_changed_during_observation');
  assert.equal(n, 6);
  let m = 0;
  const umaVez = { lerShell: async () => ({ threads: [thread({ latestVisibleMessage: { id: m++ < 2 ? `m-${m}` : 'm-fixo' } })] }), lerCompleto: async () => snap() };
  assert.equal((await lerObservacao({ environmentId: 'env-local', threadId: 'thread-1', ...umaVez })).complete, true);
});

test('t3_thread: sem settlementContractVersion a resposta não muda; com 1 traz settlement do snapshot completo', async () => {
  const d = dadosPadrao();
  d.local.completo = { 't-comum': { snapshotSequence: 77, projection: { ...d.local.bounded['t-comum'].projection, thread: { id: 't-comum' } } } };
  const chamadas = [];
  const c = await conectarMcp(ambientesFalsos(d, { chamadas }));
  const antes = dados(await c.callTool({ name: 't3_thread', arguments: { threadId: 't-comum' } }));
  assert.equal('settlement' in antes, false);
  assert.ok(!chamadas.some((x) => x.startsWith('local:completo')));
  const r = dados(await c.callTool({ name: 't3_thread', arguments: { threadId: 't-comum', settlementContractVersion: 1 } }));
  assert.equal(r.settlement.complete, true);
  assert.equal(r.settlement.snapshotSequence, 77);
  assert.equal(r.settlement.eligibleMechanically, true);
  assert.equal(r.settlement.settled, false);
  assert.ok(chamadas.includes('local:completo:t-comum'));
  // Sem snapshot completo disponível, o opt-in falha como erro; nunca devolve settlement vazio.
  const semCompleto = await c.callTool({ name: 't3_thread', arguments: { threadId: 't-local', settlementContractVersion: 1 } });
  assert.equal(semCompleto.isError, true);
  const invalido = await c.callTool({ name: 't3_thread', arguments: { threadId: 't-comum', settlementContractVersion: 2 } });
  assert.equal(invalido.isError, true);
});

test('lerObservacao: shell em cache com lifecycle diferente do snapshot completo não vira observação', async () => {
  // Shell fixa (como no OAuth all, que reaproveita a shell da chamada) e thread já reaberta no snapshot.
  const shell = { threads: [thread({ settledAt: '2026-10-05T10:00:00.000Z' })] };
  const reaberta = snap({ thread: { id: 'thread-1', settledAt: null, unsettledAt: '2026-10-05T11:00:00.000Z' } });
  const o = await lerObservacao({ environmentId: 'env-local', threadId: 'thread-1', lerShell: async () => shell, lerCompleto: async () => reaberta });
  assert.equal(o.complete, false);
  assert.equal(o.blockers[0].reason, 'thread_changed_during_observation');
  const igual = snap({ thread: { id: 'thread-1', settledAt: '2026-10-05T10:00:00Z' } });
  assert.equal((await lerObservacao({ environmentId: 'env-local', threadId: 'thread-1', lerShell: async () => shell, lerCompleto: async () => igual })).complete, true);
});

// Regressões da revisão independente de d862666.

test('review P1: t3_thread opt-in não mistura entrega antiga com expectedRunId novo', async () => {
  const d = dadosPadrao();
  const run1 = thread({ id: 't-comum', projectId: 'proj-app-local', title: 'Comum no Local', latestRunId: 'run-1' });
  const run2 = { ...run1, latestRunId: 'run-2', latestVisibleMessage: { id: 'msg-2' } };
  let shells = 0;
  const { projects, threads } = d.local.shell;
  const outras = threads.filter((t) => t.id !== 't-comum');
  // A primeira shell (e o bounded) ainda mostram run-1; run-2 termina antes da observação.
  d.local.shell = () => ({ projects, threads: [shells++ === 0 ? run1 : run2, ...outras] });
  d.local.completo = {
    't-comum': {
      snapshotSequence: 80,
      projection: {
        ...projecao({ runs: [{ id: 'run-1', ordinal: 1, status: 'completed' }, { id: 'run-2', ordinal: 2, status: 'completed' }], mensagens: [mensagem({ id: 'msg-1', runId: 'run-1', text: 'entrega 1' }), mensagem({ id: 'msg-2', runId: 'run-2', text: 'entrega 2' })] }),
        thread: { id: 't-comum' },
      },
    },
  };
  const c = await conectarMcp(ambientesFalsos(d));
  const r = dados(await c.callTool({ name: 't3_thread', arguments: { threadId: 't-comum', settlementContractVersion: 1 } }));
  assert.equal(r.settlement.expectedRunId, 'run-2');
  assert.equal(r.latestResponse.runId, 'run-2');
  assert.equal(r.latestResponse.text, 'entrega 2');
  assert.equal(r.latestRun.runId, 'run-2');
  assert.equal(r.history.source, 'full_snapshot');
});

test('review P1: observação incoerente não entrega observationId junto da leitura comum', async () => {
  const d = dadosPadrao();
  let n = 0;
  const base = d.local.shell;
  d.local.shell = () => ({ ...base, threads: base.threads.map((t) => (t.id === 't-comum' ? { ...t, latestVisibleMessage: { id: `m-${n++}` } } : t)) });
  d.local.completo = { 't-comum': { snapshotSequence: 1, projection: { ...d.local.bounded['t-comum'].projection, thread: { id: 't-comum' } } } };
  const c = await conectarMcp(ambientesFalsos(d));
  const r = dados(await c.callTool({ name: 't3_thread', arguments: { threadId: 't-comum', settlementContractVersion: 1 } }));
  assert.equal(r.settlement.complete, false);
  assert.equal(r.settlement.observationId, null);
  assert.equal('expectedRunId' in r.settlement, false);
  assert.notEqual(r.history.source, 'full_snapshot');
});

test('review P2: run com status desconhecido, pedido malformado ou snapshot sem sequence não ficam elegíveis', () => {
  const casos = [
    snap({ runs: [...runs1, { id: 'run-x', ordinal: 2, status: 'paused_by_new_server' }] }),
    snap({ runtimeRequests: [{ id: 'req-1', status: 'weird' }] }),
    { projection: snap().projection },
    snap({}, -1),
  ];
  for (const s of casos) {
    const o = observar({}, s);
    assert.equal(o.complete, false);
    assert.equal(o.eligibleMechanically, false);
    assert.equal(avaliarGuard({ version: 1, expectedRunId: 'run-1', expectedObservationId: 'x', acceptance: { accepted: true, evidenceRef: 'r' } }, o), 'settle_observation_incomplete');
  }
  assert.equal(observar({ status: 'brand_new_status' }).complete, false);
});
