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
// Trabalho de fundo: vem do snapshot de execução (src/execucao.mjs) derivado do MESMO
// snapshot completo, fonte canônica de trabalho em curso. O roster da shell só aparece com o
// último run assentado; a projeção traz roster do provider, turn items e subagents sem esse
// gate. Bloqueia o que segura a thread (`holdsThread`); comando em segundo plano não segura.
//
// Limites: é observação do connector, não compare-and-set no T3. Entre a última leitura e
// o comando ainda há janela para outro cliente, e o backend pode liquidar ou reabrir a
// thread depois (merge de PR vinculado, pin, atividade nova).

import { createHash } from 'node:crypto';
import { estadoDaThread, pedidosPendentes, runAtivoDaShell } from './estado.mjs';
import { compararShell, derivarExecucao, seguraAThread } from './execucao.mjs';

export const SETTLEMENT_CONTRACT_VERSION = 1;
// v2: bloqueios projetados de `execution.continuation.blockers` (mesmos códigos), fundo
// desconhecido bloqueia, observationId `obs2_` cobre binding, resposta e fundo. v1 inalterada.
export const SETTLEMENT_CONTRACT_VERSIONS = Object.freeze([1, 2]);
export const SETTLE_GUARD_VERSIONS = Object.freeze([1, 2]);
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

/**
 * Campos da thread na shell que, se mudarem entre duas leituras, invalidam a combinação:
 * versão da thread (updatedAt), binding (projeto, worktree, branch), atividade, lifecycle,
 * mensagem visível (ID e atualização), plano e roster.
 */
function marcaDaShell(t) {
  return JSON.stringify([
    instante(t.updatedAt), ou(t.projectId), ou(t.worktreePath), ou(t.branch),
    t.status, t.latestRunId, ou(t.activeRunId), ou(t.activityRunStatus), ou(t.pendingRuntimeRequest?.id),
    ou(t.settledAt), ou(t.settledOverride), ou(t.unsettledAt), ou(t.pinnedAt), ou(t.archivedAt),
    ou(t.latestVisibleMessage?.id), instante(t.latestVisibleMessage?.updatedAt), Boolean(t.hasActionableProposedPlan),
    (t.pendingBackgroundTasks ?? []).map((x) => ou(x.taskId)),
  ]);
}

// Lifecycle que a shell e projection.thread (snapshot completo) trazem os dois. Compara só
// os campos presentes no snapshot: a shell pode vir de cache dentro de uma chamada (OAuth
// all), então esta é a checagem que ainda liga as duas leituras ao mesmo estado.
const LIFECYCLE = ['settledAt', 'settledOverride', 'unsettledAt', 'pinnedAt', 'archivedAt', 'snoozedUntil', 'projectId', 'worktreePath', 'branch'];
// Instantes comparados por valor: as duas fontes podem formatar o mesmo instante de outro jeito.
const instante = (v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : ou(v));
function lifecycleConfere(shellThread, appThread) {
  if (!appThread) return true;
  return LIFECYCLE.every((k) => !(k in appThread) || instante(appThread[k]) === instante(shellThread[k]));
}

function incompleta(motivos, version = SETTLEMENT_CONTRACT_VERSION) {
  return {
    contractVersion: version,
    guardVersions: SETTLE_GUARD_VERSIONS,
    complete: false,
    eligibleMechanically: false,
    acceptanceRequired: true,
    observationId: null,
    blockers: motivos.map((reason) => ({ code: 'observation_incomplete', reason })),
    warnings: [],
  };
}

/** Bloqueios v1 (contrato publicado): códigos settle (pending_request, active_run, queued_work,
 * unresolved_work); fundo de `execution` com o roster da shell por cima. */
function bloqueiosV1({ execution, thread, p, pendentesProjecao, estado }) {
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
  // Fundo: `execution` (projeção completa, sem o gate da shell) e, por cima, o roster da
  // shell. A shell pode estar atrás da projeção, então só acrescenta bloqueio, nunca remove.
  const fundo = new Map();
  for (const t of execution.background.pending) if (t.holdsThread) fundo.set(t.taskId, t);
  for (const t of thread.pendingBackgroundTasks ?? []) {
    const kind = t.kind ?? 'background_task';
    if (seguraAThread(kind) && !fundo.has(t.taskId ?? null)) fundo.set(t.taskId ?? null, { taskId: t.taskId ?? null, kind, source: 'shell_roster' });
  }
  for (const t of fundo.values()) {
    bloqueios.push({ code: 'unresolved_work', kind: 'background_task', taskId: t.taskId, backgroundKind: t.kind, source: t.source });
  }
  if (estado.state === 'unknown') bloqueios.push({ code: 'unresolved_work', kind: 'unknown_state', status: thread.status });
  return bloqueios;
}

/**
 * Bloqueios v2: os códigos canônicos de `execution.continuation.blockers` (active_run,
 * queued_runs, pending_request, proposed_plan, usage_limit, usage_limit_auto_resume,
 * background_work_active, background_work_unknown), com os IDs que execution traz. A shell só
 * acrescenta (pedido, run ativo, plano, roster que ela vê e a projeção não), nunca remove.
 * Código que este contrato não conhece vira observation_incomplete: nada fica elegível.
 */
function bloqueiosV2({ execution, thread, estado }) {
  const bloqueios = [];
  const ja = new Set();
  const add = (b, chave) => { if (chave && ja.has(chave)) return; if (chave) ja.add(chave); bloqueios.push(b); };
  for (const code of execution.continuation.blockers) {
    if (code === 'active_run') add({ code, runId: execution.runs.active?.runId ?? null, status: execution.runs.active?.status ?? null }, `run:${execution.runs.active?.runId}`);
    else if (code === 'queued_runs') for (const r of execution.runs.queued) add({ code, runId: r.runId, queueHeld: Boolean(r.queueHeld) });
    else if (code === 'pending_request') for (const q of execution.pendingRequests) add({ code, requestId: q.requestId, kind: q.kind ?? null }, `req:${q.requestId}`);
    else if (code === 'proposed_plan') add({ code }, 'plan');
    else if (code === 'usage_limit' || code === 'usage_limit_auto_resume') add({ code, runId: thread.limitRecovery?.runId ?? null });
    else if (code === 'background_work_active') {
      for (const t of execution.background.pending) if (t.holdsThread) add({ code, taskId: t.taskId, backgroundKind: t.kind, source: t.source }, `bg:${t.taskId}`);
    } else if (code === 'background_work_unknown') add({ code, knowledge: execution.background.knowledge });
    else add({ code: 'observation_incomplete', reason: 'execution_blocker_unsupported', blocker: code });
  }
  if (thread.pendingRuntimeRequest) add({ code: 'pending_request', requestId: thread.pendingRuntimeRequest.id, kind: thread.pendingRuntimeRequest.kind ?? null, source: 'shell' }, `req:${thread.pendingRuntimeRequest.id}`);
  const daShell = runAtivoDaShell(thread);
  if (daShell) add({ code: 'active_run', runId: daShell.runId ?? null, status: daShell.status, source: 'shell' }, `run:${daShell.runId}`);
  if (thread.hasActionableProposedPlan) add({ code: 'proposed_plan', source: 'shell' }, 'plan');
  for (const t of thread.pendingBackgroundTasks ?? []) {
    const kind = t.kind ?? 'background_task';
    if (seguraAThread(kind)) add({ code: 'background_work_active', taskId: t.taskId ?? null, backgroundKind: kind, source: 'shell_roster' }, `bg:${t.taskId ?? null}`);
  }
  if (estado.state === 'running' && !bloqueios.some((b) => b.code === 'active_run')) add({ code: 'active_run', runId: estado.runId ?? null, status: estado.statusRun ?? null, source: 'shell_state' });
  if (estado.state === 'unknown') add({ code: 'observation_incomplete', reason: 'unknown_state', status: thread.status });
  return bloqueios;
}

/** Snapshot de execução de um snapshot completo validado (histórico inteiro, uma transação). */
export function execucaoDoSnapshot({ thread, snapshot, attempts = 1 }) {
  return derivarExecucao({
    projecao: snapshot.projection,
    shellThread: thread,
    fonte: { kind: 'thread_full_snapshot', threadSequence: snapshot.snapshotSequence ?? null, historyComplete: true, attempts },
  });
}

/**
 * Observação pura a partir de uma thread da shell e de um snapshot completo
 * `{snapshotSequence, projection}` da mesma thread. Nunca lança: entrada inconsistente
 * vira complete=false com bloqueio `observation_incomplete`.
 */
export function observarSettlement(args) {
  return observar(args).observacao;
}

/** Observação e o snapshot de execução que decidiu seus bloqueios de fundo (null se incompleta). */
function observar({ environmentId, thread, snapshot, attempts = 1, version = SETTLEMENT_CONTRACT_VERSION }) {
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
  if (problemas.length) return { observacao: incompleta(problemas, version), execucao: null };
  const execution = execucaoDoSnapshot({ thread, snapshot, attempts });

  const pendentesProjecao = pedidosPendentes(p);
  const estado = estadoDaThread(thread, pendentesProjecao);
  const bloqueios = version === 2
    ? bloqueiosV2({ execution, thread, estado })
    : bloqueiosV1({ execution, thread, p, pendentesProjecao, estado });

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
  // v1: sem roster no servidor a ausência de trabalho de fundo não é provada; não bloqueia (mesma
  // regra do preflight de thread.send), mas fica dito. Na v2 é o bloqueio background_work_unknown.
  if (version === 1 && execution.background.knowledge !== 'complete') avisos.push({ code: 'background_work_unknown', knowledge: execution.background.knowledge });

  // Digest determinístico do que invalida um aceite: atividade, pedidos, mensagens (IDs e
  // timestamps, sem texto), lifecycle e PRs. Sem updatedAt nem sequence global, para não
  // invalidar o aceite por evento em outra thread ou por visita.
  const ultimaMensagem = (p.messages ?? []).at(-1);
  const material = [
    version, environmentId, thread.id, thread.projectId,
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
    [...new Set([...execution.background.pending.map((t) => t.taskId), ...(thread.pendingBackgroundTasks ?? []).map((t) => ou(t.taskId))])].map(String).sort(),
  ];
  if (version === 2) {
    // v2 também invalida o aceite quando muda o workspace, a resposta revisada (texto editado sem
    // messageId novo), o tipo ou a fonte do trabalho de fundo, o que terminou sem ser absorvido,
    // os planos da projeção e os próprios bloqueios. Sem texto cru: só o digest.
    const resposta = [...(p.messages ?? [])].reverse().find((m) => m.role === 'assistant' && m.text);
    material.push(
      [ou(thread.worktreePath), ou(thread.branch)],
      resposta ? [resposta.id, ou(resposta.runId), ou(resposta.updatedAt), digest(resposta.text)] : null,
      ordenar(execution.background.pending, (t) => t.taskId).map((t) => [t.taskId, t.kind, t.holdsThread, t.source]),
      ordenar(execution.background.endedSinceLatestRun, (t) => t.taskId).map((t) => [t.taskId, ou(t.outcome)]),
      Array.isArray(p.plans) ? ordenar(p.plans, (x) => x.id).map((x) => [ou(x.id), ou(x.kind), ou(x.status)]) : null,
      bloqueios.map((b) => JSON.stringify(b)),
    );
  }

  const observacao = {
    contractVersion: version,
    guardVersions: SETTLE_GUARD_VERSIONS,
    guarantee: 'connector_preflight_and_observation',
    complete: true,
    observationId: `obs${version}_${digest(material)}`,
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
  return { observacao, execucao: execution };
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
export async function lerObservacaoComDados({ environmentId, threadId, lerShell, lerCompleto, tentativas = TENTATIVAS_OBSERVACAO, version = SETTLEMENT_CONTRACT_VERSION }) {
  const achar = (shell) => (shell?.threads ?? []).find((t) => t.id === threadId && !t.deletedAt);
  // `ultimoSnapshot`: o último snapshot completo lido, mesmo sem observação coerente; só serve a
  // quem precisa de uma projeção (uma transação) e declara a falta da shell.
  let ultimoSnapshot = null;
  for (let i = 0; i < tentativas; i++) {
    const antes = achar(await lerShell());
    if (!antes) return { observacao: observarSettlement({ environmentId, thread: null, snapshot: null, version }), thread: null, snapshot: null, execucao: null, ultimoSnapshot, tentativas: i + 1 };
    const snapshot = await lerCompleto(threadId);
    ultimoSnapshot = snapshot;
    const depois = achar(await lerShell());
    // Coerência exigida, não só observada: a shell igual nas duas leituras, o lifecycle e o
    // binding do snapshot iguais aos da shell, e a shell descrevendo a MESMA versão da projeção
    // (updatedAt, último run, run ativo, pedido pendente). Shell atrasada repete; nunca vira
    // observação completa (revisão 334a1840, P1).
    if (depois && marcaDaShell(antes) === marcaDaShell(depois) && lifecycleConfere(depois, snapshot?.projection?.thread)
        && snapshot?.projection && compararShell(depois, snapshot.projection).motivos.length === 0) {
      const { observacao, execucao } = observar({ environmentId, thread: depois, snapshot, attempts: i + 1, version });
      return observacao.complete
        ? { observacao, thread: depois, snapshot, execucao, ultimoSnapshot, tentativas: i + 1 }
        : { observacao, thread: null, snapshot: null, execucao: null, ultimoSnapshot, tentativas: i + 1 };
    }
  }
  return { observacao: incompleta(['thread_changed_during_observation'], version), thread: null, snapshot: null, execucao: null, ultimoSnapshot, tentativas };
}

/**
 * Aquisição compartilhada de `execution` para quem decide uma escrita (preflight de send, guard):
 * a mesma observação shell → completo → shell do settlement, de onde saem limite de uso, plano e
 * roster da shell. Se a thread não para de mudar (ou some da shell), cai para a projeção completa
 * mais recente, sem shell: `coherence.status` diz `projection_only` e limite/plano que só a shell
 * traz ficam de fora. Falha de leitura propaga.
 */
export async function lerExecucaoDaThread(args) {
  const lido = await lerObservacaoComDados(args);
  if (lido.execucao) return { execucao: lido.execucao, lido };
  const snapshot = lido.ultimoSnapshot ?? (await args.lerCompleto(args.threadId));
  if (!snapshot?.projection) throw new Error('execution_snapshot_unavailable');
  const execucao = derivarExecucao({
    projecao: snapshot.projection,
    fonte: { kind: 'thread_full_snapshot', threadSequence: snapshot.snapshotSequence ?? null, historyComplete: true, attempts: lido.tentativas },
  });
  return { execucao, lido };
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
// v2: código canônico de execution → recusa settle (mesmos códigos públicos da v1). Fundo
// desconhecido e código que o contrato não conhece são observação incompleta.
const RECUSA_V2 = {
  observation_incomplete: 'settle_observation_incomplete',
  background_work_unknown: 'settle_observation_incomplete',
  pending_request: 'settle_pending_request',
  active_run: 'settle_active_run',
  queued_runs: 'settle_queued_work',
  proposed_plan: 'settle_unresolved_work',
  usage_limit: 'settle_unresolved_work',
  usage_limit_auto_resume: 'settle_unresolved_work',
  background_work_active: 'settle_unresolved_work',
};
const ORDEM_V2 = ['settle_observation_incomplete', 'settle_pending_request', 'settle_active_run', 'settle_queued_work', 'settle_unresolved_work'];

export function avaliarGuard(guard, observacao) {
  if (!SETTLE_GUARD_VERSIONS.includes(guard.version)) return 'settle_guard_version_unsupported';
  if (guard.acceptance?.accepted !== true) return 'settle_acceptance_required';
  // O guard é avaliado contra uma observação da MESMA versão; obs1 num guard v2 nunca confere.
  if (!observacao?.complete || observacao.contractVersion !== guard.version) return 'settle_observation_incomplete';
  if (guard.version === 2) {
    const recusas = new Set(observacao.blockers.map((b) => RECUSA_V2[b.code] ?? 'settle_observation_incomplete'));
    const primeira = ORDEM_V2.find((c) => recusas.has(c));
    if (primeira) return primeira;
  } else {
    for (const code of ORDEM) {
      if (observacao.blockers.some((b) => b.code === code)) return RECUSA_DO_BLOQUEIO[code];
    }
  }
  if ((guard.expectedRunId ?? null) !== observacao.expectedRunId) return 'settle_run_changed';
  if (guard.expectedObservationId !== observacao.observationId) return 'settle_observation_changed';
  return null;
}

/** Códigos de recusa do guard, com a frase que os dois perfis de escrita mostram. */
export const MENSAGENS_GUARD = Object.freeze({
  settle_guard_version_unsupported: 'settleGuard.version is not supported by this connector (supported: 1); nothing was sent',
  settle_acceptance_required: 'settleGuard needs acceptance.accepted=true from whoever accepted the delivered scope; a completed run is not acceptance; nothing was sent',
  settle_observation_incomplete: 'could not observe the thread completely and coherently (snapshot, runs or requests missing, or the thread kept changing); nothing was sent. Read t3_thread again with the settlementContractVersion of your guard',
  settle_pending_request: 'the thread has a pending runtime request; nothing was sent. Answer or resolve it first',
  settle_active_run: 'the thread has an active run (even with no pending request); nothing was sent. Wait for it or interrupt it explicitly',
  settle_queued_work: 'the thread has queued work; nothing was sent',
  settle_unresolved_work: 'the thread has unresolved work (usage limit, proposed plan, background task or unknown state); nothing was sent',
  settle_run_changed: 'the latest run differs from settleGuard.expectedRunId; nothing was sent. Read the thread again and reassess the delivery',
  settle_observation_changed: 'the thread changed since the observation in settleGuard.expectedObservationId (new message, run, request, PR or lifecycle change); nothing was sent. Read again and reassess',
});
