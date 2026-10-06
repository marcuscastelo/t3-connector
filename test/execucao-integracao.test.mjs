// Snapshot de execução nas ferramentas: t3_thread (leitura coerente com releitura),
// t3_aguardar_thread until=execution_idle (corrida de eventos do incidente) e a recusa
// estruturada de thread.send com trabalho em segundo plano.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aguardarThread } from '../src/espera.mjs';
import { Dispatcher } from '../src/escrita/adapters.mjs';
import { derivarExecucao } from '../src/execucao.mjs';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao, LOCAL } from './apoio.mjs';
import { setup, memoryJournal } from './escrita-fixtures.mjs';
import { mensagem, thread } from './fixtures.mjs';

const T = (min, s = 0) => `2026-10-05T20:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;
const PT = 'pt-root';
const MONITOR = { taskId: 'task-monitor', kind: 'monitor', description: 'observe CI for 3 minutes' };
const run = (n, status) => ({
  id: `run-${n}`, ordinal: n, status, requestedAt: T(n * 10), startedAt: T(n * 10, 1),
  completedAt: ['completed', 'failed'].includes(status) ? T(n * 10 + 1) : null,
});
const R1 = mensagem({ id: 'msg-r1', runId: 'run-1', text: 'Observer started; it will watch CI for 3 minutes.' });
const projecao = ({ runs, roster = [], updatedAt, mensagens = [R1] }) => ({
  thread: { id: 't-comum', providerInstanceId: 'claudeAgent', activeProviderThreadId: PT, updatedAt },
  runs, runtimeRequests: [], subagents: [], plans: [], turnItems: [],
  providerThreads: [{ id: PT, pendingBackgroundTasks: roster, updatedAt }],
  providerSessions: [{ id: 'ps-1', providerInstanceId: 'claudeAgent', status: 'ready', cwd: '/repo', model: 'claude-opus-5-5', updatedAt: T(0), lastError: null }],
  messages: mensagens, updatedAt,
});

function comThread(shellThreads, bounded) {
  const d = dadosPadrao();
  let i = 0;
  const base = d.local.shell;
  d.local.shell = () => ({ ...base, threads: [shellThreads[Math.min(i++, shellThreads.length - 1)], ...base.threads.filter((t) => t.id !== 't-comum')] });
  d.local.bounded['t-comum'] = bounded;
  return d;
}

test('t3_thread: shell atrás da projeção é relida uma vez; execution vem da mesma leitura', async () => {
  const p = projecao({ runs: [run(1, 'completed'), run(2, 'failed')], updatedAt: T(24) });
  const velha = thread({ id: 't-comum', projectId: LOCAL.projeto, latestRunId: 'run-1', status: 'completed', updatedAt: T(11), pendingBackgroundTasks: [] });
  const nova = thread({ id: 't-comum', projectId: LOCAL.projeto, latestRunId: 'run-2', status: 'failed', updatedAt: T(24), activeProviderThreadId: PT });
  const chamadas = [];
  const mcp = await conectarMcp(ambientesFalsos(comThread([velha, nova], { snapshotSequence: 77, projection: p, hasMoreHistory: true }), { chamadas }));
  const r = dados(await mcp.callTool({ name: 't3_thread', arguments: { threadId: 't-comum' } }));
  assert.deepEqual(chamadas.filter((c) => c.startsWith('local:shell') || c.startsWith('local:thread')), ['local:shell', 'local:thread:t-comum', 'local:shell', 'local:thread:t-comum']);
  assert.equal(r.state, 'failed', 'topo da resposta vem da shell relida');
  const e = r.execution;
  assert.equal(e.contractVersion, 1);
  assert.equal(e.coherence.status, 'coherent');
  assert.equal(e.coherence.attempts, 2);
  assert.equal(e.source.threadSequence, 77);
  assert.equal(e.runs.latestExecuted.runId, 'run-2');
  assert.equal(e.latestResponse.relation, 'older_run');
  assert.equal(e.signals.responseStale, true);
  assert.equal(e.continuation.canStartNow, true);
  assert.equal(e.continuation.target, 'same_thread');
});

test('t3_thread: shell que continua atrasada é marcada, nunca misturada em silêncio', async () => {
  const p = projecao({ runs: [run(1, 'completed')], roster: [MONITOR], updatedAt: T(12) });
  const velha = thread({ id: 't-comum', projectId: LOCAL.projeto, latestRunId: 'run-1', status: 'completed', updatedAt: T(11) });
  const mcp = await conectarMcp(ambientesFalsos(comThread([velha], { snapshotSequence: 9, projection: p, hasMoreHistory: true })));
  const r = dados(await mcp.callTool({ name: 't3_thread', arguments: { threadId: 't-comum' } }));
  assert.equal(r.state, 'completed');
  assert.equal(r.execution.coherence.status, 'shell_lagging');
  assert.equal(r.execution.coherence.attempts, 2);
  assert.equal(r.execution.signals.backgroundWorkActive, true, 'o roster da projeção aparece mesmo com o topo dizendo completed');
  assert.equal(r.execution.continuation.canStartNow, false);
});

/** Subscription falsa: emite lotes nos tempos pedidos. */
function assinaturaFalsa(lotes, registro = {}) {
  return async ({ aoReceber, payload }) => {
    registro.payload = payload;
    let falhar;
    const fim = new Promise((_, reject) => { falhar = reject; });
    fim.catch(() => {});
    const timers = lotes.map(([ms, itens]) => setTimeout(() => { try { aoReceber(itens); } catch (e) { falhar(e); } }, ms));
    return { fim, encerrar() { timers.forEach(clearTimeout); } };
  };
}
const evento = (sequence, type, payload, occurredAt) => ({ kind: 'event', sequence, event: { type, payload, occurredAt } });
const shellDoIncidente = () => {
  const d = dadosPadrao();
  d.local.shell.threads = d.local.shell.threads.map((t) => (t.id === 't-comum'
    ? thread({ id: 't-comum', projectId: LOCAL.projeto, latestRunId: 'run-1', status: 'completed', updatedAt: T(11), activeProviderThreadId: PT, pendingBackgroundTasks: [MONITOR] })
    : t));
  return d;
};

test('aguardar execution_idle: o fim do run não encerra a espera; o fim do observador sim', async () => {
  const agora = Date.now();
  const iso = (ms) => new Date(agora + ms).toISOString();
  const snap = { kind: 'snapshot', snapshotSequence: 10, projection: projecao({ runs: [run(1, 'completed')], roster: [MONITOR], updatedAt: T(11) }) };
  const r2 = run(2, 'running');
  const lotes = [
    [5, [snap, { kind: 'synchronized' }]],
    // run2 começa e falha por causa do observador, sem mensagem nova.
    [20, [evento(11, 'run.created', r2, iso(20))]],
    [30, [evento(12, 'run.updated', { ...r2, status: 'failed', completedAt: iso(30) }, iso(30))]],
    // O observador termina: roster vazio, nenhuma mensagem nova.
    [60, [evento(13, 'provider-thread.updated', { id: PT, pendingBackgroundTasks: [], updatedAt: iso(60) }, iso(60))]],
  ];
  const inicio = Date.now();
  const reg = {};
  const r = await aguardarThread(ambientesFalsos(shellDoIncidente()), { environment: 'local', threadId: 't-comum', timeoutMs: 5000, until: 'execution_idle' }, { assinarImpl: assinaturaFalsa(lotes, reg) });
  assert.deepEqual(reg.payload, { threadId: 't-comum', requestCompletionMarker: true }, 'projeção completa: a janela não prova ausência');
  assert.equal(r.returnReason, 'execution_idle');
  assert.equal(r.timedOut, false);
  assert.equal(r.executionIdle, true);
  assert.ok(Date.now() - inicio >= 1400, 'espera ficar quieta 1.5 s antes de declarar ociosa');
  assert.equal(r.runId, 'run-2');
  assert.equal(r.state, 'failed');
  assert.deepEqual(r.backgroundClearedDuringWait.map((t) => [t.taskId, t.kind, t.threadSequence]), [['task-monitor', 'monitor', 13]]);
  const e = r.execution;
  assert.equal(e.source.kind, 'thread_subscription');
  assert.equal(e.source.threadSequence, 13);
  assert.equal(e.signals.backgroundWorkActive, false);
  assert.equal(e.signals.responseStale, true);
  assert.equal(e.signals.latestRunHasNoAssistantResponse, true);
  assert.equal(e.continuation.canStartNow, true);
  assert.deepEqual(e.continuation.reasons, ['latest_run_without_assistant_response', 'latest_run_failed']);
});

test('aguardar execution_idle: wake run logo após o fim do observador não é confundido com ociosidade', async () => {
  const agora = Date.now();
  const iso = (ms) => new Date(agora + ms).toISOString();
  const snap = { kind: 'snapshot', snapshotSequence: 10, projection: projecao({ runs: [run(1, 'completed')], roster: [MONITOR], updatedAt: T(11) }) };
  const wake = { ...run(2, 'running'), requestedAt: iso(300), startedAt: iso(300) };
  const lotes = [
    [5, [snap]],
    [20, [evento(11, 'provider-thread.updated', { id: PT, pendingBackgroundTasks: [], updatedAt: iso(20) }, iso(20))]],
    [300, [evento(12, 'run.created', wake, iso(300))]],
  ];
  const r = await aguardarThread(ambientesFalsos(shellDoIncidente()), { environment: 'local', threadId: 't-comum', timeoutMs: 900, until: 'execution_idle' }, { assinarImpl: assinaturaFalsa(lotes) });
  assert.equal(r.returnReason, 'timeout');
  assert.equal(r.timedOut, true);
  assert.equal(r.executionIdle, false);
  assert.equal(r.execution.signals.foregroundActive, true);
  assert.deepEqual(r.execution.continuation.blockers, ['active_run']);
});

test('aguardar execution_idle: runId é recusado (segue a thread inteira)', async () => {
  await assert.rejects(
    aguardarThread(ambientesFalsos(), { environment: 'local', threadId: 't-comum', timeoutMs: 100, until: 'execution_idle', runId: 'run-1' }),
    /runId only applies to until=run_terminal/,
  );
});

const segurando = derivarExecucao({ projecao: projecao({ runs: [run(1, 'completed')], roster: [MONITOR], updatedAt: T(11) }), fonte: { historyComplete: true } });
const livre = derivarExecucao({ projecao: projecao({ runs: [run(1, 'completed')], updatedAt: T(11) }), fonte: { historyComplete: true } });
const envio = (campos = {}) => ({ operationId: 'op-1', action: 'thread.send', input: { threadId: 't', text: 'continue', clientRequestId: 'op-1', delivery: 'start_immediately', ...campos } });

async function dispatcher(snapshot) {
  const s = setup(), lease = await s.grant(), journal = memoryJournal(), enviados = [];
  const adapter = {
    projectForThread: async () => 'app',
    executionSnapshot: async () => (typeof snapshot === 'function' ? snapshot() : snapshot),
    invoke: async (method, payload) => { enviados.push(payload); return { sequence: 5 }; },
    receipt: (r) => ({ sequence: r.sequence }),
  };
  const d = new Dispatcher({ gate: s.gate, adapter, journal, environmentId: s.env.environmentId, destination: s.env.destination });
  return { d, s, lease, journal, enviados };
}

test('send com trabalho em segundo plano segurando a thread: recusa estruturada, nada enviado', async () => {
  const { d, s, lease, enviados } = await dispatcher(segurando);
  const r = await d.dispatch(s.caller, lease.leaseId, envio());
  assert.equal(r.state, 'rejected');
  assert.equal(r.sent, false);
  assert.equal(r.reconciliationRequired, false);
  assert.equal(r.refusal.code, 'background_work_active');
  assert.match(r.refusal.message, /monitor task-monitor.*until=execution_idle.*new clientRequestId/);
  assert.deepEqual(r.execution.continuation.blockers, ['background_work_active']);
  assert.equal(enviados.length, 0);
  assert.equal(s.gate.status(lease.leaseId).active, true, 'recusa não fecha a lease');
  // Replay do mesmo operationId devolve a mesma recusa, sem reenviar.
  const replay = await d.dispatch(s.caller, lease.leaseId, envio());
  assert.deepEqual([replay.state, replay.sent, replay.refusal.code], ['rejected', false, 'background_work_active']);
  assert.equal(enviados.length, 0);
});

test('send: sem trabalho segurando, ou com onBackgroundWork=send, segue normal; outros modos não leem', async () => {
  let a = await dispatcher(livre);
  assert.equal((await a.d.dispatch(a.s.caller, a.lease.leaseId, envio())).state, 'completed');
  assert.equal(a.enviados[0].dispatchMode.type, 'start_immediately');
  assert.equal('onBackgroundWork' in a.enviados[0], false, 'campo só do connector');
  a = await dispatcher(segurando);
  assert.equal((await a.d.dispatch(a.s.caller, a.lease.leaseId, envio({ onBackgroundWork: 'send' }))).state, 'completed');
  let lidas = 0;
  a = await dispatcher(() => { lidas++; return segurando; });
  const steer = { operationId: 'op-2', action: 'thread.send', input: { threadId: 't', text: 'fix', clientRequestId: 'op-2', delivery: 'steer_active', targetRunId: 'run-1' } };
  assert.equal((await a.d.dispatch(a.s.caller, a.lease.leaseId, steer)).state, 'completed');
  assert.equal(lidas, 0);
});

test('send: leitura do snapshot falhou antes do envio: recusa conhecida, nada enviado', async () => {
  const { d, s, lease, enviados } = await dispatcher(() => { throw new Error('boom'); });
  await assert.rejects(d.dispatch(s.caller, lease.leaseId, envio()), /execution_snapshot_unavailable/);
  assert.equal(enviados.length, 0);
});
