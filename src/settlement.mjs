// Observação de settlement de uma thread (contrato v1), compartilhada pela leitura opt-in
// (`t3_thread` com settlementContractVersion: 1) e pelo guard opt-in de `thread.settle`.
//
// É fato mecânico, não decisão: `eligibleMechanically` só diz que nada objetivo impede o
// settle (run ativo, pedido pendente, fila, limite de uso, plano, trabalho de fundo,
// leitura incompleta). Aceite da entrega é sempre declaração de quem chama; `completed`
// do run nunca vale como aceite.
//
// A observação vem da shell (estado canônico, mesma precedência de estado.mjs) e do
// snapshot COMPLETO da thread (todos os runs e pedidos; o /bounded é janela de conversa).
// Coerência sem sequence global: shell → completo → shell; se os campos da thread na shell
// mudaram entre as duas leituras, ou o lifecycle da shell difere do snapshot completo,
// repete (limite fixo) e depois declara complete=false.
//
// Limites: é observação do connector, não compare-and-set no T3. Entre a última leitura e
// o comando ainda há janela para outro cliente, e o backend pode liquidar ou reabrir a
// thread depois (merge de PR vinculado, pin, atividade nova).

import { createHash } from 'node:crypto';
import { estadoDaThread, pedidosPendentes, runAtivoDaShell } from './estado.mjs';

export const SETTLEMENT_CONTRACT_VERSION = 1;
export const SETTLE_GUARD_VERSIONS = Object.freeze([1]);
export const TENTATIVAS_OBSERVACAO = 3;

const ATIVOS = new Set(['preparing', 'starting', 'running', 'waiting']);
// Enums do contrato V2 (OrchestrationV2RunStatus, RuntimeRequest.status). Valor fora deles
// não é interpretado: a observação fica incompleta e nada é elegível nem verificado.
const STATUS_RUN = new Set([...ATIVOS, 'queued', 'completed', 'interrupted', 'failed', 'cancelled', 'rolled_back']);
const STATUS_THREAD = new Set(['idle', ...STATUS_RUN]);
const STATUS_PEDIDO = new Set(['pending', 'resolved', 'expired', 'cancelled']);
const textoNaoVazio = (v) => typeof v === 'string' && v.length > 0;

const digest = (valor) => createHash('sha256').update(JSON.stringify(valor)).digest('hex').slice(0, 32);
const ordenar = (lista, chave) => [...lista].sort((a, b) => String(chave(a)).localeCompare(String(chave(b))));
const ou = (v) => (v === undefined ? null : v);

function prs(thread) {
  const lista = [
    ...(thread.linkedPullRequest ? [{ ...thread.linkedPullRequest, link: 'linked' }] : []),
    ...(Array.isArray(thread.pullRequests) ? thread.pullRequests.map((p) => ({ ...p, link: 'listed' })) : []),
  ];
  return lista.map((p) => ({
    number: ou(p.number),
    url: ou(p.url),
    state: ou(p.state),
    link: p.link,
  }));
}

/** Campos da thread na shell que, se mudarem entre duas leituras, invalidam a combinação. */
function marcaDaShell(t) {
  return JSON.stringify([
    t.status, t.latestRunId, ou(t.activeRunId), ou(t.activityRunStatus), ou(t.pendingRuntimeRequest?.id),
    ou(t.settledAt), ou(t.settledOverride), ou(t.unsettledAt), ou(t.pinnedAt), ou(t.archivedAt),
    ou(t.latestVisibleMessage?.id), Boolean(t.hasActionableProposedPlan),
  ]);
}

// Lifecycle que a shell e projection.thread (snapshot completo) trazem os dois. Compara só
// os campos presentes no snapshot: a shell pode vir de cache dentro de uma chamada (OAuth
// all), então esta é a checagem que ainda liga as duas leituras ao mesmo estado.
const LIFECYCLE = ['settledAt', 'settledOverride', 'unsettledAt', 'pinnedAt', 'archivedAt', 'snoozedUntil'];
// Instantes comparados por valor: as duas fontes podem formatar o mesmo instante de outro jeito.
const instante = (v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : ou(v));
function lifecycleConfere(shellThread, appThread) {
  if (!appThread) return true;
  return LIFECYCLE.every((k) => !(k in appThread) || instante(appThread[k]) === instante(shellThread[k]));
}

function incompleta(motivos) {
  return {
    contractVersion: SETTLEMENT_CONTRACT_VERSION,
    guardVersions: SETTLE_GUARD_VERSIONS,
    complete: false,
    eligibleMechanically: false,
    acceptanceRequired: true,
    observationId: null,
    blockers: motivos.map((reason) => ({ code: 'observation_incomplete', reason })),
    warnings: [],
  };
}

/**
 * Observação pura a partir de uma thread da shell e de um snapshot completo
 * `{snapshotSequence, projection}` da mesma thread. Nunca lança: entrada inconsistente
 * vira complete=false com bloqueio `observation_incomplete`.
 */
export function observarSettlement({ environmentId, thread, snapshot }) {
  const p = snapshot?.projection;
  const problemas = [];
  if (!thread) problemas.push('thread_missing_from_shell');
  if (!p || !Array.isArray(p.runs) || !Array.isArray(p.runtimeRequests)) problemas.push('snapshot_without_runs_or_requests');
  if (!Number.isInteger(snapshot?.snapshotSequence) || snapshot.snapshotSequence < 0) problemas.push('snapshot_sequence_invalid');
  if (thread && p?.thread?.id !== thread.id) problemas.push('snapshot_of_another_thread');
  if (thread && !STATUS_THREAD.has(thread.status)) problemas.push('thread_status_unknown');
  if (Array.isArray(p?.runs) && !p.runs.every((r) => textoNaoVazio(r?.id) && STATUS_RUN.has(r.status))) problemas.push('run_malformed_or_status_unknown');
  if (Array.isArray(p?.runtimeRequests) && !p.runtimeRequests.every((r) => textoNaoVazio(r?.id) && STATUS_PEDIDO.has(r.status))) {
    problemas.push('request_malformed_or_status_unknown');
  }
  if (thread?.latestRunId && Array.isArray(p?.runs) && !p.runs.some((r) => r.id === thread.latestRunId)) {
    problemas.push('latest_run_missing_from_snapshot');
  }
  if (problemas.length) return incompleta(problemas);

  const pendentesProjecao = pedidosPendentes(p);
  const estado = estadoDaThread(thread, pendentesProjecao);
  const bloqueios = [];

  // Pedidos: resumo da shell e qualquer runtimeRequest pending do snapshot, sem duplicar.
  const pedidos = new Map();
  if (thread.pendingRuntimeRequest) pedidos.set(thread.pendingRuntimeRequest.id, thread.pendingRuntimeRequest);
  for (const r of pendentesProjecao) if (!pedidos.has(r.id)) pedidos.set(r.id, r);
  for (const r of pedidos.values()) bloqueios.push({ code: 'pending_request', requestId: r.id, kind: r.kind ?? null });

  // Trabalho ativo: o run ativo da shell (precedência da 0.11.2) e qualquer run ativo do snapshot.
  const ativos = new Map();
  const daShell = runAtivoDaShell(thread);
  if (daShell) ativos.set(daShell.runId ?? '(waiting)', daShell.status);
  for (const r of p.runs) if (ATIVOS.has(r.status) && !ativos.has(r.id)) ativos.set(r.id, r.status);
  if (!ativos.size && estado.state === 'running') ativos.set(estado.runId ?? '(unknown)', estado.statusRun);
  for (const [runId, status] of ativos) bloqueios.push({ code: 'active_run', runId, status });

  // Fila: qualquer run queued, inclusive fila retida que não aparece como latestRun.
  for (const r of p.runs) {
    if (r.status === 'queued') bloqueios.push({ code: 'queued_work', runId: r.id, queueHeld: Boolean(r.queueHeld) });
  }

  // Trabalho não resolvido sem run ativo.
  if (thread.limitRecovery && !thread.limitRecovery.autoResume) {
    bloqueios.push({ code: 'unresolved_work', kind: 'usage_limit', runId: thread.limitRecovery.runId ?? null });
  }
  if (thread.hasActionableProposedPlan) bloqueios.push({ code: 'unresolved_work', kind: 'proposed_plan', runId: thread.latestRunId });
  for (const t of thread.pendingBackgroundTasks ?? []) {
    bloqueios.push({ code: 'unresolved_work', kind: 'background_task', taskId: t.taskId ?? null });
  }
  if (estado.state === 'unknown') bloqueios.push({ code: 'unresolved_work', kind: 'unknown_state', status: thread.status });

  const disponibilidade = {
    pinnedAt: 'pinnedAt' in thread,
    snoozedUntil: 'snoozedUntil' in thread,
    unsettledAt: 'unsettledAt' in thread,
    autoSettleDisabledAt: 'autoSettleDisabledAt' in thread,
    pullRequests: 'pullRequests' in thread || 'linkedPullRequest' in thread,
  };
  const links = prs(thread);
  const avisos = [];
  if (links.length) avisos.push({ code: 'linked_pr_merge_can_auto_settle' });
  else if (!disponibilidade.pullRequests) avisos.push({ code: 'linked_pr_state_unavailable' });
  if (thread.settledAt) avisos.push({ code: 'already_settled', settledOverride: ou(thread.settledOverride) });
  if (thread.settledAt && disponibilidade.pinnedAt) avisos.push({ code: 'pin_can_clear_settlement' });

  // Digest determinístico do que invalida um aceite: atividade, pedidos, mensagens (IDs e
  // timestamps, sem texto), lifecycle e PRs. Sem updatedAt nem sequence global, para não
  // invalidar o aceite por evento em outra thread ou por visita.
  const ultimaMensagem = (p.messages ?? []).at(-1);
  const material = [
    SETTLEMENT_CONTRACT_VERSION, environmentId, thread.id, thread.projectId,
    thread.latestRunId ?? null, thread.status, ou(thread.activeRunId), ou(thread.activityRunStatus),
    ordenar(p.runs, (r) => r.id).map((r) => [r.id, r.status, Boolean(r.queueHeld)]),
    ordenar(p.runtimeRequests, (r) => r.id).map((r) => [r.id, r.status]),
    ou(thread.pendingRuntimeRequest?.id),
    ultimaMensagem ? [ultimaMensagem.id, ou(ultimaMensagem.updatedAt)] : null,
    ou(thread.latestVisibleMessage?.id),
    ou(thread.settledAt), ou(thread.settledOverride), ou(thread.unsettledAt), ou(thread.pinnedAt), ou(thread.archivedAt),
    links.map((l) => [l.number, l.url, l.state, l.link]),
    Boolean(thread.hasActionableProposedPlan),
    thread.limitRecovery ? [ou(thread.limitRecovery.runId), Boolean(thread.limitRecovery.autoResume)] : null,
    (thread.pendingBackgroundTasks ?? []).map((t) => ou(t.taskId)),
  ];

  return {
    contractVersion: SETTLEMENT_CONTRACT_VERSION,
    guardVersions: SETTLE_GUARD_VERSIONS,
    guarantee: 'connector_preflight_and_observation',
    complete: true,
    observationId: `obs1_${digest(material)}`,
    snapshotSequence: snapshot.snapshotSequence ?? null,
    expectedRunId: thread.latestRunId ?? null,
    state: estado.state,
    stateSource: estado.stateSource,
    eligibleMechanically: bloqueios.length === 0,
    acceptanceRequired: true,
    settled: Boolean(thread.settledAt),
    settledAt: ou(thread.settledAt),
    settledOverride: ou(thread.settledOverride),
    unsettledAt: ou(thread.unsettledAt),
    snoozedUntil: ou(thread.snoozedUntil),
    pinnedAt: ou(thread.pinnedAt),
    autoSettleDisabledAt: ou(thread.autoSettleDisabledAt),
    linkedPullRequests: links,
    fieldAvailability: disponibilidade,
    blockers: bloqueios,
    warnings: avisos,
  };
}

/**
 * Lê shell → snapshot completo → shell e observa quando a thread não mudou na shell entre
 * as duas leituras. `lerShell()` e `lerCompleto(threadId)` são as leituras GET do cliente.
 * Falha de leitura propaga (quem chama decide se é recusa); incoerência repetida vira
 * observação incompleta.
 */
export async function lerObservacao(args) {
  return (await lerObservacaoComDados(args)).observacao;
}

/**
 * Como lerObservacao, devolvendo também a thread da shell e o snapshot que a observação
 * validou (null quando incompleta), para quem monta uma resposta a partir dos MESMOS dados.
 */
export async function lerObservacaoComDados({ environmentId, threadId, lerShell, lerCompleto, tentativas = TENTATIVAS_OBSERVACAO }) {
  const achar = (shell) => (shell?.threads ?? []).find((t) => t.id === threadId && !t.deletedAt);
  for (let i = 0; i < tentativas; i++) {
    const antes = achar(await lerShell());
    if (!antes) return { observacao: observarSettlement({ environmentId, thread: null, snapshot: null }), thread: null, snapshot: null };
    const snapshot = await lerCompleto(threadId);
    const depois = achar(await lerShell());
    if (depois && marcaDaShell(antes) === marcaDaShell(depois) && lifecycleConfere(depois, snapshot?.projection?.thread)) {
      const observacao = observarSettlement({ environmentId, thread: depois, snapshot });
      return observacao.complete ? { observacao, thread: depois, snapshot } : { observacao, thread: null, snapshot: null };
    }
  }
  return { observacao: incompleta(['thread_changed_during_observation']), thread: null, snapshot: null };
}

const RECUSA_DO_BLOQUEIO = {
  pending_request: 'settle_pending_request',
  active_run: 'settle_active_run',
  queued_work: 'settle_queued_work',
  unresolved_work: 'settle_unresolved_work',
  observation_incomplete: 'settle_observation_incomplete',
};
const ORDEM = ['observation_incomplete', 'pending_request', 'active_run', 'queued_work', 'unresolved_work'];

/**
 * Avalia o guard v1 contra uma observação. Devolve null (pode enviar) ou o código da
 * recusa. Ordem fixa: versão, aceite, completude, bloqueios objetivos e só então run e
 * observação esperados, para que trabalho ativo seja recusado mesmo com runId velho.
 */
export function avaliarGuard(guard, observacao) {
  if (!SETTLE_GUARD_VERSIONS.includes(guard.version)) return 'settle_guard_version_unsupported';
  if (guard.acceptance?.accepted !== true) return 'settle_acceptance_required';
  if (!observacao?.complete) return 'settle_observation_incomplete';
  for (const code of ORDEM) {
    if (observacao.blockers.some((b) => b.code === code)) return RECUSA_DO_BLOQUEIO[code];
  }
  if ((guard.expectedRunId ?? null) !== observacao.expectedRunId) return 'settle_run_changed';
  if (guard.expectedObservationId !== observacao.observationId) return 'settle_observation_changed';
  return null;
}

/** Códigos de recusa do guard, com a frase que os dois perfis de escrita mostram. */
export const MENSAGENS_GUARD = Object.freeze({
  settle_guard_version_unsupported: 'settleGuard.version is not supported by this connector (supported: 1); nothing was sent',
  settle_acceptance_required: 'settleGuard needs acceptance.accepted=true from whoever accepted the delivered scope; a completed run is not acceptance; nothing was sent',
  settle_observation_incomplete: 'could not observe the thread completely and coherently (snapshot, runs or requests missing, or the thread kept changing); nothing was sent. Read t3_thread with settlementContractVersion=1 again',
  settle_pending_request: 'the thread has a pending runtime request; nothing was sent. Answer or resolve it first',
  settle_active_run: 'the thread has an active run (even with no pending request); nothing was sent. Wait for it or interrupt it explicitly',
  settle_queued_work: 'the thread has queued work; nothing was sent',
  settle_unresolved_work: 'the thread has unresolved work (usage limit, proposed plan, background task or unknown state); nothing was sent',
  settle_run_changed: 'the latest run differs from settleGuard.expectedRunId; nothing was sent. Read the thread again and reassess the delivery',
  settle_observation_changed: 'the thread changed since the observation in settleGuard.expectedObservationId (new message, run, request, PR or lifecycle change); nothing was sent. Read again and reassess',
});
