// Regressões da revisão R8 (3698695, GO com achados não bloqueantes): a confirmação da espera
// não sobrevive ao retorno, evento novo durante a confirmação a invalida, e o atalho de
// `run_terminal` pela shell só vale com a linha no contrato.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aguardarThread } from '../src/espera.mjs';
import { ambientesFalsos, dadosPadrao, LOCAL } from './apoio.mjs';
import { mensagem, projecao, thread } from './fixtures.mjs';

const proj = (extra = {}) => ({ ...projecao({ runs: [{ id: 'run-1', ordinal: 1, status: 'completed' }], mensagens: [mensagem()] }), thread: { id: 't-comum', activeProviderThreadId: 'pt' }, providerThreads: [{ id: 'pt', pendingBackgroundTasks: [] }], ...extra });
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const linhaComum = (campos = {}) => thread({ id: 't-comum', projectId: LOCAL.projeto, title: 'Comum no Local', status: 'completed', ...campos });

// Shell que demora `atraso` ms a partir da segunda leitura (a primeira é a autorização).
function shellLenta(linha, atraso) {
  const d = dadosPadrao();
  const base = d.local.shell;
  let n = 0;
  d.local.shell = async () => { if (n++ > 0) await dorme(atraso); return { ...base, threads: [linha, ...base.threads.filter((t) => t.id !== 't-comum')] }; };
  return d;
}

test('R8-1 subscription fechada durante a confirmação: nenhuma leitura da shell depois do retorno', async () => {
  // Shell atrasada (não confirma) e lenta: sem a correção, a confirmação reagendava para sempre.
  const d = shellLenta(linhaComum({ latestRunId: 'run-0', updatedAt: '2026-10-03T09:00:00.000Z' }), 100);
  const chamadas = [];
  let fechar;
  const assinar = async ({ aoReceber }) => {
    setTimeout(() => aoReceber([{ kind: 'snapshot', snapshotSequence: 5, projection: proj() }, { kind: 'synchronized' }]), 5);
    return { fim: new Promise((r) => { fechar = r; setTimeout(r, 60); }), encerrar() {} };
  };
  const r = await aguardarThread(ambientesFalsos(d, { chamadas }), { environment: 'local', threadId: 't-comum', timeoutMs: 5000, until: 'execution_idle' }, { assinarImpl: assinar });
  assert.equal(r.returnReason, 'subscription_closed');
  assert.notEqual(r.executionIdle, true);
  const noRetorno = chamadas.filter((c) => c === 'local:shell').length;
  await dorme(3600);
  assert.equal(chamadas.filter((c) => c === 'local:shell').length, noRetorno, 'nenhuma releitura da shell após o retorno');
  fechar?.();
});

test('R8-4 evento novo durante a confirmação invalida a confirmação em voo', async () => {
  // A shell lenta descreve a versão ociosa; enquanto ela é lida, chega run.created de run-2.
  const d = shellLenta(linhaComum(), 150);
  const run2 = { id: 'run-2', ordinal: 2, status: 'running', requestedAt: '2026-10-03T10:06:00.000Z', startedAt: '2026-10-03T10:06:01.000Z', completedAt: null };
  const assinar = async ({ aoReceber }) => {
    const t1 = setTimeout(() => aoReceber([{ kind: 'snapshot', snapshotSequence: 5, projection: proj() }, { kind: 'synchronized' }]), 5);
    const t2 = setTimeout(() => aoReceber([{ kind: 'event', sequence: 6, event: { type: 'run.created', payload: run2, occurredAt: '2026-10-03T10:06:00.000Z' } }]), 60);
    return { fim: new Promise(() => {}), encerrar() { clearTimeout(t1); clearTimeout(t2); } };
  };
  const r = await aguardarThread(ambientesFalsos(d), { environment: 'local', threadId: 't-comum', timeoutMs: 1200, until: 'execution_idle' }, { assinarImpl: assinar });
  assert.equal(r.returnReason, 'timeout');
  assert.notEqual(r.executionIdle, true);
  assert.equal(r.execution.runs.active?.runId, 'run-2');
});

test('R8-2 run_terminal: linha da shell fora do contrato não encurta pela shell', async () => {
  for (const chave of ['hasActionableProposedPlan', 'pendingRuntimeRequest', 'activeRunId']) {
    const linha = linhaComum();
    delete linha[chave];
    const d = dadosPadrao();
    d.local.shell.threads = d.local.shell.threads.map((t) => (t.id === 't-comum' ? linha : t));
    let assinou = false;
    const assinar = async () => { assinou = true; return { fim: new Promise(() => {}), encerrar() {} }; };
    const r = await aguardarThread(ambientesFalsos(d), { environment: 'local', threadId: 't-comum', timeoutMs: 200, until: 'run_terminal' }, { assinarImpl: assinar });
    assert.equal(assinou, true, `${chave}: a subscription decide`);
    assert.notEqual(r.returnReason, 'terminal', chave);
  }
  // Controle: com a linha no contrato o atalho continua valendo.
  let assinou = false;
  const r = await aguardarThread(ambientesFalsos(), { environment: 'local', threadId: 't-comum', timeoutMs: 200, until: 'run_terminal' }, { assinarImpl: async () => { assinou = true; return { fim: new Promise(() => {}), encerrar() {} }; } });
  assert.equal(r.returnReason, 'terminal');
  assert.equal(assinou, false);
});
