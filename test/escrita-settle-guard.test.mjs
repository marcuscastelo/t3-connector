// settleGuard v1 em thread.settle: recusa objetiva antes do envio (nada sai para o T3),
// payload sem campos do guard, pós-check persistido, legacy intacto.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher, parseAction } from '../src/escrita/adapters.mjs';
import { digest } from '../src/escrita/gate.mjs';
import { lerObservacao } from '../src/settlement.mjs';
import { setup, memoryJournal } from './escrita-fixtures.mjs';
import { mensagem, pedido, projecao, thread } from './fixtures.mjs';

// Thread falsa com estado mutável: o invoke de thread.settle marca settledAt, como o T3.
function mundo() {
  const st = {
    seq: 100,
    thread: thread({ id: 'thread', projectId: 'app' }),
    proj: { ...projecao({ runs: [{ id: 'run-1', ordinal: 1, status: 'completed' }], mensagens: [mensagem()] }), thread: { id: 'thread' } },
    aposSettle: (s) => { s.thread = { ...s.thread, settledAt: '2026-10-05T12:00:00.000Z', settledOverride: 'settled' }; },
    lerFalha: false,
  };
  const calls = [];
  const adapter = {
    calls,
    verifyWorkspace: async () => true,
    projectForThread: async () => 'app',
    invoke: async (method, payload) => { calls.push({ method, payload }); st.seq++; st.aposSettle(st); return { sequence: st.seq }; },
    receipt: (r) => ({ sequence: r.sequence }),
    reconcile: async () => ({ found: true }),
    settlementObservation: (threadId) => {
      if (st.lerFalha) throw new Error('read failed');
      return lerObservacao({ environmentId: 'local', threadId, lerShell: async () => ({ threads: [st.thread] }), lerCompleto: async () => ({ snapshotSequence: st.seq - (st.atraso ?? 0), projection: st.proj }) });
    },
  };
  return { st, adapter };
}

async function preparar() {
  const s = setup();
  s.env.actions.push('thread.settle');
  const lease = await s.grant();
  const { st, adapter } = mundo();
  const d = new Dispatcher({ gate: s.gate, adapter, journal: memoryJournal(), environmentId: s.env.environmentId, destination: s.env.destination });
  const settle = (operationId, settleGuard) => d.dispatch(s.caller, lease.leaseId, { operationId, action: 'thread.settle', input: { threadId: 'thread', ...(settleGuard ? { settleGuard } : {}) } });
  const observar = () => adapter.settlementObservation('thread');
  const guard = (o, extra = {}) => ({ version: 1, expectedRunId: o.expectedRunId, expectedObservationId: o.observationId, acceptance: { accepted: true, evidenceRef: 'review:accept' }, ...extra });
  return { s, lease, st, adapter, settle, observar, guard };
}

test('legacy settle: mesmo schema/hash, sem leitura extra, payload {type,commandId,threadId}', async () => {
  const p = parseAction('thread.settle', { threadId: 'thread' });
  assert.deepEqual(p.input, { threadId: 'thread' });
  assert.equal(digest(['thread.settle', p.input]), digest(['thread.settle', { threadId: 'thread' }]));
  const { settle, adapter } = await preparar();
  let leituras = 0;
  const original = adapter.settlementObservation;
  adapter.settlementObservation = (id) => { leituras++; return original(id); };
  const r = await settle('legacy');
  assert.equal(r.state, 'completed');
  assert.equal('settlement' in r, false);
  assert.equal(leituras, 0);
  assert.deepEqual(Object.keys(adapter.calls[0].payload).sort(), ['commandId', 'threadId', 'type']);
});

test('guard: aceite explícito + observação atual envia exatamente um comando, sem os campos do guard', async () => {
  const { settle, adapter, observar, guard } = await preparar();
  const o = await observar();
  const r = await settle('ok', guard(o));
  assert.equal(r.state, 'completed');
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(Object.keys(adapter.calls[0].payload).sort(), ['commandId', 'threadId', 'type']);
  assert.equal(adapter.calls[0].payload.type, 'thread.settle');
  assert.deepEqual({ postCheck: r.settlement.postCheck, settled: r.settlement.settled }, { postCheck: 'verified', settled: true });
  // Replay do mesmo operationId devolve a mesma evidência sem reenviar.
  const replay = await settle('ok', guard(o));
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(replay.settlement, r.settlement);
  // Mesmo operationId com outra intenção é conflito, não novo envio.
  await assert.rejects(settle('ok', guard(o, { acceptance: { accepted: true, evidenceRef: 'other' } })), /operation_conflict/);
});

test('completed não é aceite: accepted=false é recusado e nada é enviado', async () => {
  const { settle, adapter, observar, guard, s, lease } = await preparar();
  const o = await observar();
  assert.equal(o.state, 'completed');
  await assert.rejects(settle('sem-aceite', guard(o, { acceptance: { accepted: false, evidenceRef: 'run completed' } })), /^Error: settle_acceptance_required$/);
  assert.equal(adapter.calls.length, 0);
  // Recusa antes do envio não fecha a lease.
  assert.equal(s.gate.status(lease.leaseId).active, true);
});

test('pedido pendente bloqueia o settle; o código sobrevive ao replay', async () => {
  const { settle, adapter, observar, guard, st } = await preparar();
  const o = await observar();
  st.proj = { ...st.proj, runtimeRequests: [pedido({ id: 'req-1', kind: 'user_input' })] };
  await assert.rejects(settle('pedido', guard(o)), /settle_pending_request/);
  assert.equal(adapter.calls.length, 0);
  const replay = await settle('pedido', guard(o));
  assert.equal(replay.state, 'rejected');
  assert.equal(replay.error, 'settle_pending_request');
  assert.equal(adapter.calls.length, 0);
});

test('run ativo bloqueia o settle mesmo com zero pedidos', async () => {
  const { settle, adapter, observar, guard, st } = await preparar();
  const o = await observar();
  st.thread = { ...st.thread, status: 'cancelled', latestRunId: 'run-5', activeRunId: 'run-1', activityRunStatus: 'running' };
  st.proj = { ...st.proj, runs: [{ id: 'run-1', ordinal: 1, status: 'running' }, { id: 'run-5', ordinal: 5, status: 'cancelled' }] };
  await assert.rejects(settle('ativo', guard(o)), /settle_active_run/);
  assert.equal(adapter.calls.length, 0);
});

test('observação velha não é aplicada em silêncio: mensagem nova ou thread reaberta recusam', async () => {
  const { settle, adapter, observar, guard, st } = await preparar();
  const o = await observar();
  st.proj = { ...st.proj, messages: [...st.proj.messages, mensagem({ id: 'msg-2', text: 'falta ativação' })] };
  await assert.rejects(settle('velha-1', guard(o)), /settle_observation_changed/);
  const o2 = await observar();
  st.thread = { ...st.thread, unsettledAt: '2026-10-05T11:00:00.000Z' };
  await assert.rejects(settle('velha-2', guard(o2)), /settle_observation_changed/);
  const o3 = await observar();
  st.thread = { ...st.thread, latestRunId: 'run-2' };
  st.proj = { ...st.proj, runs: [...st.proj.runs, { id: 'run-2', ordinal: 2, status: 'completed' }] };
  await assert.rejects(settle('velha-3', guard(o3)), /settle_run_changed/);
  assert.equal(adapter.calls.length, 0);
  // Depois de reler e reavaliar, uma NOVA operação passa.
  const nova = await settle('nova', guard(await observar()));
  assert.equal(nova.state, 'completed');
  assert.equal(adapter.calls.length, 1);
});

test('leitura que falha antes do envio é recusa (nada enviado), não incerteza', async () => {
  const { settle, adapter, observar, guard, st, s, lease } = await preparar();
  const o = await observar();
  st.lerFalha = true;
  await assert.rejects(settle('sem-leitura', guard(o)), /settle_observation_incomplete/);
  assert.equal(adapter.calls.length, 0);
  assert.equal(s.gate.status(lease.leaseId).active, true);
});

test('pós-check: reabertura após o ACK é mismatch e leitura falha/atrasada é unavailable; nunca reenvia', async () => {
  for (const [caso, esperado] of [['reaberta', 'mismatch'], ['falha', 'unavailable'], ['atrasada', 'unavailable']]) {
    const { settle, adapter, observar, guard, st, s, lease } = await preparar();
    const o = await observar();
    st.aposSettle = (x) => {
      if (caso === 'reaberta') x.proj = { ...x.proj, runs: [...x.proj.runs, { id: 'run-2', ordinal: 2, status: 'running' }] };
      if (caso === 'falha') x.lerFalha = true;
      if (caso === 'atrasada') x.atraso = 5;
    };
    const r = await settle(`pos-${caso}`, guard(o));
    assert.equal(r.state, 'completed', caso);
    assert.equal(r.receipt.sequence !== undefined, true);
    assert.equal(r.settlement.postCheck, esperado, caso);
    assert.equal(adapter.calls.length, 1, caso);
    assert.equal(s.gate.status(lease.leaseId).active, true, caso);
  }
});

test('versão de guard não suportada e campos desconhecidos nunca enviam', async () => {
  const { settle, adapter, observar, guard } = await preparar();
  const o = await observar();
  await assert.rejects(settle('v2', guard(o, { version: 2 })), /settle_guard_version_unsupported/);
  await assert.rejects(settle('extra', { ...guard(o), requireNoActiveRun: false }));
  assert.equal(adapter.calls.length, 0);
});
