// Regressões da revisão R7 (5e61520): a leitura que sustenta uma derivação (alvo, sequência,
// linha da shell) conferida em `derivarExecucao`, para todo consumidor; a espera só afirma
// ociosidade com a shell da mesma versão; campos obrigatórios da shell e roster null.
import test from 'node:test';
import assert from 'node:assert/strict';
import { derivarExecucao } from '../src/execucao.mjs';
import { lerObservacao, lerExecucaoDaThread, avaliarGuard } from '../src/settlement.mjs';
import { problemasDaProjecao } from '../src/validacao.mjs';
import { Dispatcher } from '../src/escrita/adapters.mjs';
import { aguardarThread } from '../src/espera.mjs';
import { setup, memoryJournal } from './escrita-fixtures.mjs';
import { ambientesFalsos, dadosPadrao, LOCAL } from './apoio.mjs';
import { mensagem, projecao, thread } from './fixtures.mjs';

const proj = (id = 'thread-1', extra = {}) => ({ ...projecao({ runs: [{ id: 'run-1', ordinal: 1, status: 'completed' }], mensagens: [mensagem()] }), thread: { id, activeProviderThreadId: 'pt' }, providerThreads: [{ id: 'pt', pendingBackgroundTasks: [] }], ...extra });
const guard = (o, version = 2) => ({ version, expectedRunId: 'run-1', expectedObservationId: o.observationId ?? 'x', acceptance: { accepted: true, evidenceRef: 'r' } });
const sem = (o, chave) => { const c = { ...o }; delete c[chave]; return c; };

async function sendLegado(execucao) {
  const s = setup();
  const lease = await s.grant();
  const calls = [];
  const adapter = { verifyWorkspace: async () => true, projectForThread: async () => 'app', invoke: async (m, p) => { calls.push(p); return { sequence: 1 }; }, receipt: (r) => r, executionSnapshot: async () => execucao };
  const d = new Dispatcher({ gate: s.gate, adapter, journal: memoryJournal(), environmentId: s.env.environmentId, destination: s.env.destination });
  const r = await d.dispatch(s.caller, lease.leaseId, { operationId: 'op', action: 'thread.send', input: { threadId: 't', text: 'oi', clientRequestId: 'op', delivery: 'start_immediately' } });
  return { r, calls };
}

// Espera em `t-comum` (dadosPadrao): a shell é a do fixture; `linha` a substitui.
function esperar({ projection, snapshotSequence = 5, linha, timeoutMs = 2500 }) {
  const d = dadosPadrao();
  if (linha) d.local.shell.threads = d.local.shell.threads.map((t) => (t.id === 't-comum' ? linha : t));
  const assinar = async ({ aoReceber }) => { const t = setTimeout(() => aoReceber([{ kind: 'snapshot', snapshotSequence, projection }, { kind: 'synchronized' }]), 5); return { fim: new Promise(() => {}), encerrar() { clearTimeout(t); } }; };
  return aguardarThread(ambientesFalsos(d), { environment: 'local', threadId: 't-comum', timeoutMs, until: 'execution_idle' }, { assinarImpl: assinar });
}
const linhaComum = (campos = {}) => thread({ id: 't-comum', projectId: LOCAL.projeto, title: 'Comum no Local', status: 'completed', ...campos });

test('R7 controle: espera com projeção do alvo e shell da mesma versão declara ociosa', async () => {
  const r = await esperar({ projection: proj('t-comum') });
  assert.equal(r.returnReason, 'execution_idle');
  assert.equal(r.executionIdle, true);
});

test('R7-1 espera: snapshot de outra thread (ou sem thread) nunca é ociosidade do alvo', async () => {
  for (const projection of [proj('thread-1'), sem(proj('t-comum'), 'thread')]) {
    const r = await esperar({ projection, timeoutMs: 600 });
    assert.equal(r.returnReason, 'timeout');
    assert.notEqual(r.executionIdle, true);
    assert.equal(r.execution.evidence.valid, false);
    assert.ok(r.execution.evidence.problems.includes('snapshot_of_another_thread'));
  }
});

test('R7-2 sequência fora do contrato: espera, fallback sem shell e com shell incoerente não provam nada', async () => {
  const w = await esperar({ projection: proj('t-comum'), snapshotSequence: 'BAD', timeoutMs: 600 });
  assert.equal(w.returnReason, 'timeout');
  assert.ok(w.execution.evidence.problems.includes('snapshot_sequence_invalid'));
  const incoerente = thread({ latestRunId: 'run-9', updatedAt: '2026-10-03T11:00:00.000Z' });
  for (const threads of [[], [incoerente]]) {
    const { execucao } = await lerExecucaoDaThread({ environmentId: 'e', threadId: 'thread-1', lerShell: async () => ({ threads }), lerCompleto: async () => ({ snapshotSequence: 'BAD', projection: proj() }) });
    assert.equal(execucao.evidence.valid, false, JSON.stringify(threads));
    assert.ok(execucao.evidence.problems.includes('snapshot_sequence_invalid'));
    const { r, calls } = await sendLegado(execucao);
    assert.equal(r.refusal?.code, 'execution_evidence_invalid');
    assert.equal(calls.length, 0);
  }
});

test('R7-3 espera: plano acionável que só a shell mostra não vira execution_idle', async () => {
  const r = await esperar({ projection: proj('t-comum'), linha: linhaComum({ hasActionableProposedPlan: true }) });
  assert.equal(r.returnReason, 'needs_intervention');
  assert.notEqual(r.executionIdle, true);
  assert.ok(r.execution.continuation.blockers.includes('proposed_plan'));
});

test('R7-3 espera: shell atrasada não confirma; continua esperando e não afirma ociosidade', async () => {
  const r = await esperar({ projection: proj('t-comum'), linha: linhaComum({ latestRunId: 'run-0', updatedAt: '2026-10-03T09:00:00.000Z' }), timeoutMs: 2200 });
  assert.equal(r.returnReason, 'timeout');
  assert.equal(r.executionIdle, null);
});

test('R7-4 campos obrigatórios da shell ausentes: settle incompleto, fallback inválido, send recusa', async () => {
  for (const chave of ['hasActionableProposedPlan', 'pendingRuntimeRequest', 'activeRunId']) {
    const linha = sem(thread(), chave);
    const args = { environmentId: 'e', threadId: 'thread-1', lerShell: async () => ({ threads: [linha] }), lerCompleto: async () => ({ snapshotSequence: 3, projection: proj() }) };
    for (const version of [1, 2]) {
      const o = await lerObservacao({ ...args, version });
      assert.equal(o.complete, false, `${chave} v${version}`);
      assert.equal(avaliarGuard(guard(o, version), o), 'settle_observation_incomplete');
    }
    const { execucao } = await lerExecucaoDaThread(args);
    assert.equal(execucao.evidence.valid, false, chave);
    const { r, calls } = await sendLegado(execucao);
    assert.equal(r.refusal?.code, 'execution_evidence_invalid', chave);
    assert.equal(calls.length, 0);
  }
  // O mesmo vale para quem deriva direto com a linha (t3_thread).
  assert.equal(derivarExecucao({ projecao: proj(), shellThread: sem(thread(), 'hasActionableProposedPlan'), threadId: 'thread-1', fonte: { historyComplete: true } }).evidence.valid, false);
});

test('R7-5 roster null (projeção ou shell) não é roster vazio conhecido', async () => {
  const p = proj('thread-1', { providerThreads: [{ id: 'pt', pendingBackgroundTasks: null }] });
  assert.ok(problemasDaProjecao(p).includes('providerThreads_roster_not_a_list'));
  for (const [threads, projection] of [[[thread()], p], [[thread({ pendingBackgroundTasks: null })], proj()]]) {
    for (const version of [1, 2]) {
      const o = await lerObservacao({ environmentId: 'e', threadId: 'thread-1', version, lerShell: async () => ({ threads }), lerCompleto: async () => ({ snapshotSequence: 3, projection }) });
      assert.equal(o.complete, false);
      assert.equal(avaliarGuard(guard(o, version), o), 'settle_observation_incomplete');
    }
    const { execucao } = await lerExecucaoDaThread({ environmentId: 'e', threadId: 'thread-1', lerShell: async () => ({ threads }), lerCompleto: async () => ({ snapshotSequence: 3, projection }) });
    assert.equal(execucao.evidence.valid, false);
    assert.equal(execucao.signals.operationallyIdle, false);
  }
  // Omitido continua válido (o contrato decodifica para []).
  assert.deepEqual(problemasDaProjecao(proj('thread-1', { providerThreads: [{ id: 'pt' }] })), []);
});
