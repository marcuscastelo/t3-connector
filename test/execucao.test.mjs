// Snapshot de execução (src/execucao.mjs). O cenário de regressão reproduz o incidente:
// run1 lança um observador (Monitor do Claude, no roster do provider thread) e responde
// "observador ativo"; o run termina e o observador continua; run2 falha por causa do
// trabalho em segundo plano, sem resposta nova; o observador termina; a shell fica em
// completed/failed com a resposta antiga. Em cada etapa o snapshot tem de dizer, sem
// interpretar texto, o que está rodando e se a continuação pode seguir na mesma thread.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aplicarItens, compararShell, derivarExecucao, trabalhoEmSegundoPlano } from '../src/execucao.mjs';
import { mensagem, thread } from './fixtures.mjs';

const T = (min, s = 0) => `2026-10-05T20:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;
const PT = 'pt-root';
const MONITOR = { taskId: 'task-monitor', kind: 'monitor', description: 'observe CI for 3 minutes' };
const run = (n, status, campos = {}) => ({
  id: `run-${n}`, ordinal: n, status, providerThreadId: PT, requestedAt: T(n * 10), startedAt: T(n * 10, 1),
  completedAt: ['completed', 'failed', 'cancelled', 'interrupted'].includes(status) ? T(n * 10 + 1) : null, ...campos,
});
const sessao = (status = 'ready') => ({ id: 'ps-1', providerInstanceId: 'claudeAgent', status, cwd: '/repo', model: 'claude-opus-5-5', updatedAt: T(0), lastError: null });
const erroDoRun = (runId, message) => ({
  id: `err-${runId}`, type: 'error', runId, status: 'failed', startedAt: null, completedAt: null, updatedAt: T(21),
  failure: { class: 'provider_error', code: null, message, retryable: null },
});

/** Projeção do /bounded: arrays de controle completos, janela de mensagens. */
function projecao({ runs, roster = [], mensagens = [], turnItems = [], subagents = [], pedidos = [], updatedAt = T(30), session = sessao() }) {
  return {
    thread: { id: 'thread-1', providerInstanceId: 'claudeAgent', activeProviderThreadId: PT, updatedAt },
    runs,
    runtimeRequests: pedidos,
    providerThreads: [
      { id: PT, status: 'idle', pendingBackgroundTasks: roster, updatedAt },
      // Provider thread de outra thread no mesmo runtime: nunca pode deixar esta ocupada.
      { id: 'pt-alheio', status: 'active', pendingBackgroundTasks: [{ taskId: 'alheia', kind: 'subagent' }], updatedAt },
    ],
    providerSessions: [session],
    subagents,
    plans: [],
    messages: mensagens,
    turnItems,
    updatedAt,
  };
}
const R1 = mensagem({ id: 'msg-r1', runId: 'run-1', text: 'Observer started; it will watch CI for 3 minutes.', createdAt: T(10, 30), updatedAt: T(10, 30) });
const shellDe = (p, campos = {}) => {
  const runs = [...p.runs].sort((a, b) => b.ordinal - a.ordinal);
  const ativo = runs.find((r) => ['preparing', 'starting', 'running'].includes(r.status));
  return thread({
    providerInstanceId: 'claudeAgent', activeProviderThreadId: PT,
    latestRunId: runs[0].id, status: runs[0].status, activeRunId: ativo?.id ?? null,
    updatedAt: p.updatedAt, pendingBackgroundTasks: [], ...campos,
  });
};
const executar = (p, shell = shellDe(p), historyComplete = false) =>
  derivarExecucao({ projecao: p, shellThread: shell, fonte: { historyComplete, threadSequence: 42, observedAt: T(59) } });

test('incidente A: run1 rodando com o observador já lançado; a shell vazia não prova ausência', () => {
  const p = projecao({ runs: [run(1, 'running')], roster: [MONITOR], updatedAt: T(10, 20) });
  const e = executar(p);
  assert.equal(e.coherence.status, 'coherent');
  assert.equal(e.signals.foregroundActive, true);
  assert.equal(e.signals.backgroundWorkActive, true, 'roster da projeção, não o da shell (vazio durante o run)');
  assert.equal(e.background.pending[0].source, 'provider_roster');
  assert.equal(e.background.pending.some((t) => t.taskId === 'alheia'), false, 'provider thread de outra thread fica fora');
  assert.equal(e.signals.operationallyIdle, false);
  assert.deepEqual(e.continuation.blockers, ['active_run', 'background_work_active']);
});

test('incidente B: run1 completed com o observador pendente: run terminou, trabalho não', () => {
  const p = projecao({ runs: [run(1, 'completed')], roster: [MONITOR], mensagens: [R1], updatedAt: T(11) });
  const e = executar(p, shellDe(p, { pendingBackgroundTasks: [MONITOR] }));
  assert.equal(e.signals.runTerminal, true);
  assert.equal(e.signals.backgroundWorkActive, true);
  assert.equal(e.signals.backgroundWorkHoldsThread, true);
  assert.equal(e.background.knowledge, 'complete', 'shell da mesma versão com o gate aberto cobre itens fora da janela');
  assert.equal(e.latestResponse.relation, 'latest_executed_run');
  assert.equal(e.signals.responseStale, false);
  assert.equal(e.continuation.canStartNow, false);
  assert.deepEqual(e.continuation.blockers, ['background_work_active']);
});

test('incidente C: run2 falha por causa do trabalho em segundo plano, sem resposta nova', () => {
  const p = projecao({
    runs: [run(1, 'completed'), run(2, 'failed')],
    roster: [MONITOR],
    mensagens: [R1],
    turnItems: [erroDoRun('run-2', 'Claude is still running background agents or commands, and this model or setting change would end them.')],
    updatedAt: T(21),
  });
  const e = executar(p, shellDe(p, { pendingBackgroundTasks: [MONITOR], lastError: 'x', lastErrorClass: 'provider_error' }));
  assert.equal(e.runs.latestExecuted.runId, 'run-2');
  assert.equal(e.latestRunFailure.class, 'provider_error');
  assert.equal(e.latestRunFailure.source, 'turn_item');
  assert.equal(e.latestResponse.runId, 'run-1');
  assert.equal(e.latestResponse.relation, 'older_run');
  assert.equal(e.signals.responseStale, true);
  assert.equal(e.signals.latestRunHasNoAssistantResponse, true);
  assert.equal(e.signals.backgroundWorkActive, true, 'a falha do run2 não apaga o observador');
  assert.equal(e.continuation.canStartNow, false, 'não é thread travada: o observador segura a thread');
  assert.deepEqual(e.continuation.blockers, ['background_work_active']);
});

test('incidente D/E: observador termina; snapshot final é inequívoco e a continuação vai para a mesma thread', () => {
  // Roster vazio; nenhuma mensagem nova; a shell ainda diz failed e a resposta é a do run1.
  const p = projecao({
    runs: [run(1, 'completed'), run(2, 'failed')],
    roster: [],
    mensagens: [R1],
    turnItems: [erroDoRun('run-2', 'background work')],
    updatedAt: T(24),
  });
  const e = executar(p);
  assert.equal(e.coherence.status, 'coherent');
  assert.equal(e.background.knowledge, 'complete');
  assert.deepEqual(e.background.pending, []);
  assert.equal(e.signals.backgroundWorkActive, false, 'o trabalho em segundo plano acabou');
  assert.equal(e.signals.backgroundWorkHoldsThread, false);
  assert.equal(e.signals.responseStale, true, 'a resposta é do run1; não descreve o presente');
  assert.equal(e.signals.latestRunHasNoAssistantResponse, true);
  assert.equal(e.signals.operationallyIdle, true);
  assert.equal(e.continuation.canStartNow, true);
  assert.equal(e.continuation.recommended, true);
  assert.equal(e.continuation.target, 'same_thread');
  assert.deepEqual(e.continuation.reasons, ['latest_run_without_assistant_response', 'latest_run_failed']);

  // Run3 completa também sem resposta: a resposta continua velha, o estado não muda por falta de texto.
  const p3 = projecao({ runs: [run(1, 'completed'), run(2, 'failed'), run(3, 'completed')], mensagens: [R1], updatedAt: T(32) });
  const e3 = executar(p3);
  assert.equal(e3.runs.latestExecuted.runId, 'run-3');
  assert.equal(e3.latestResponse.relation, 'older_run');
  assert.deepEqual(e3.continuation.reasons, ['latest_run_without_assistant_response']);
  assert.equal(e3.continuation.canStartNow, true);
});

test('fim registrado depois do último run: resultado ainda não absorvido por um turn', () => {
  const comando = { id: 'ti-cmd', type: 'command_execution', runId: 'run-1', status: 'completed', title: 'gh run watch', nativeItemRef: { nativeId: 'proc-9' }, startedAt: T(10, 5), completedAt: T(13), updatedAt: T(13) };
  const notificacao = mensagem({ id: 'msg-n', role: 'system', runId: null, text: '', createdAt: T(14), updatedAt: T(14), notification: { source: { kind: 'monitor' }, outcome: 'completed', summary: 'Monitor finished' } });
  const p = projecao({ runs: [run(1, 'completed')], mensagens: [R1, notificacao], turnItems: [comando], updatedAt: T(14) });
  const e = executar(p);
  assert.equal(e.signals.backgroundWorkEndedUnconsumed, true);
  assert.deepEqual(e.background.endedSinceLatestRun.map((t) => [t.taskId, t.kind, t.source]), [['proc-9', 'command', 'turn_item'], ['notification:msg-n', 'monitor', 'notification']]);
  assert.deepEqual(e.continuation.reasons, ['background_work_ended_after_latest_run']);
  assert.equal(e.continuation.recommended, true);
  // Um wake run que começou depois consome o resultado.
  const wake = projecao({ runs: [run(1, 'completed'), run(2, 'running')], mensagens: [R1, notificacao], turnItems: [comando], updatedAt: T(21) });
  assert.equal(executar(wake).signals.backgroundWorkEndedUnconsumed, false);
});

test('entrega de tarefa delegada ainda não observada conta como resultado não absorvido', () => {
  const sub = { id: 'node-sub', runId: 'run-1', status: 'completed', title: 'review', childThreadId: 'child-1', completedAt: T(10, 50), completionDelivery: { state: 'pending', observedByRunId: null } };
  const e = executar(projecao({ runs: [run(1, 'completed')], subagents: [sub], mensagens: [R1], updatedAt: T(12) }));
  assert.equal(e.background.endedSinceLatestRun[0].source, 'delegated_completion');
  assert.equal(e.signals.backgroundWorkEndedUnconsumed, true);
});

test('comando em segundo plano não segura a thread; subagent ativo fora do run segura', () => {
  const cmd = { id: 'ti-dev', type: 'command_execution', runId: 'run-1', status: 'running', title: 'npm run dev', nativeItemRef: { nativeId: 'proc-dev' }, startedAt: T(10, 5), completedAt: null, updatedAt: T(10, 5) };
  const e = executar(projecao({ runs: [run(1, 'completed')], turnItems: [cmd], mensagens: [R1], updatedAt: T(12) }), undefined, true);
  assert.equal(e.signals.backgroundWorkActive, true);
  assert.equal(e.signals.backgroundWorkHoldsThread, false);
  assert.equal(e.continuation.canStartNow, true);
  const sub = { id: 'node-sub', runId: 'run-1', status: 'running', title: 'tests', childThreadId: null, nativeTaskRef: { nativeId: 'agent-1' } };
  const e2 = executar(projecao({ runs: [run(1, 'completed')], subagents: [sub], mensagens: [R1], updatedAt: T(12) }), undefined, true);
  assert.deepEqual(e2.background.pending.map((t) => [t.taskId, t.source, t.holdsThread]), [['agent-1', 'subagent', true]]);
  // O mesmo subagent dentro do run ativo é o próprio turn, não segundo plano.
  const e3 = executar(projecao({ runs: [run(1, 'running')], subagents: [sub], updatedAt: T(12) }), undefined, true);
  assert.deepEqual(e3.background.pending, []);
});

test('janela de histórico sem a shell da mesma versão: ausência não é provada', () => {
  const p = projecao({ runs: [run(1, 'completed')], mensagens: [R1], updatedAt: T(12) });
  const shellAtrasada = shellDe(p, { updatedAt: T(11) });
  const e = executar(p, shellAtrasada, false);
  assert.equal(e.coherence.status, 'shell_lagging');
  assert.equal(e.coherence.reasons[0].code, 'thread_version_differs');
  assert.equal(e.background.knowledge, 'partial');
  assert.equal(e.signals.backgroundWorkActive, null);
  assert.equal(e.signals.operationallyIdle, false);
  assert.deepEqual(e.continuation.blockers, ['background_work_unknown']);
  // Servidor sem roster: unknown, nunca "zero".
  const { providerThreads, ...semRoster } = p;
  assert.equal(trabalhoEmSegundoPlano(semRoster, { historicoCompleto: true }).knowledge, 'unknown');
});

test('compararShell aponta cada divergência entre shell e projeção', () => {
  const p = projecao({ runs: [run(1, 'completed'), run(2, 'running')], pedidos: [{ id: 'req-9', kind: 'user_input', status: 'pending', createdAt: T(20) }], updatedAt: T(21) });
  const velha = thread({ latestRunId: 'run-1', status: 'completed', activeRunId: null, pendingRuntimeRequest: null, updatedAt: T(12) });
  assert.deepEqual(compararShell(velha, p).motivos.map((m) => m.code), ['thread_version_differs', 'newer_run_not_in_shell', 'active_run_differs', 'pending_request_differs']);
  const igual = shellDe(p, { pendingRuntimeRequest: { id: 'req-9', kind: 'user_input', createdAt: T(20) } });
  assert.deepEqual(compararShell(igual, p).motivos, []);
});

test('aplicarItens: snapshot + eventos em ordem, sequence repetida ignorada', () => {
  const estado = { projecao: null, sequencia: null, historicoCompleto: false };
  aplicarItens(estado, [{ kind: 'snapshot', snapshotSequence: 10, hasMoreHistory: true, projection: projecao({ runs: [run(1, 'completed')], roster: [MONITOR], updatedAt: T(11) }) }]);
  assert.equal(estado.historicoCompleto, false);
  const limpo = { id: PT, status: 'idle', pendingBackgroundTasks: [], updatedAt: T(15) };
  aplicarItens(estado, [{ kind: 'event', sequence: 11, event: { type: 'provider-thread.updated', payload: limpo, occurredAt: T(15) } }]);
  aplicarItens(estado, [{ kind: 'event', sequence: 11, event: { type: 'provider-thread.updated', payload: { ...limpo, pendingBackgroundTasks: [MONITOR] } } }]);
  assert.equal(estado.sequencia, 11);
  assert.deepEqual(estado.projecao.providerThreads.find((t) => t.id === PT).pendingBackgroundTasks, [], 'evento repetido não ressuscita a task');
  assert.equal(estado.projecao.updatedAt, T(15));
  aplicarItens(estado, [{ kind: 'snapshot', snapshotSequence: 12, projection: projecao({ runs: [run(1, 'completed')] }) }]);
  assert.equal(estado.historicoCompleto, true, 'snapshot sem hasMoreHistory é a projeção completa');
});
