// Snapshot de execução de uma thread: o que ela está fazendo de fato, derivado de UMA
// projeção do T3 (uma transação do backend), com runs, pedidos, resposta, sessão do
// provider e trabalho em segundo plano correlacionados por ID. Ver
// docs/execution-snapshot.md.
//
// Por que existe: `state` vem da shell, que resume o último run. Um run terminado não diz
// se o provider ainda tem trabalho em segundo plano (Claude background Bash/Monitor,
// subagent, comando Codex), e a última resposta assistant pode ser de um run antigo. Ler
// esses sinais separados levou um orquestrador a achar que um observador já encerrado
// ainda rodava, depois que a thread travou, e a abrir uma continuação duplicada.
//
// Fontes (contrato V2, commit 8ed276c2 do T3 Code):
// - /bounded e o snapshot de orchestration.subscribeThread trazem os arrays de controle
//   completos (runs, runtimeRequests, providerThreads, subagents, providerSessions) e só
//   uma janela recente de messages/turnItems (threadHistoryPaging.ts:414-531);
// - providerThreads[].pendingBackgroundTasks é o roster de trabalho do provider que pode
//   sobreviver ao turn (orchestrationV2.ts:747-812); kinds: subagent, command, monitor,
//   background_task;
// - a shell publica pendingBackgroundTasks só com o último run assentado e nenhum run
//   ativo (packages/shared/src/orchestrationV2PendingBackgroundWork.ts:211-235): lista
//   vazia na shell durante um run não quer dizer "sem trabalho em segundo plano";
// - comando em segundo plano não segura a thread (servidor de dev pode rodar horas);
//   subagent, monitor e trabalho sem nome seguram (mesmo arquivo, :62-85);
// - toda mudança da thread avança projection.updatedAt (ProjectionStore.ts:625-636):
//   shell.updatedAt igual ao da projeção = mesma versão da thread.
//
// Tudo aqui é puro: não faz I/O, não lê journal, não envia nada.

import { msIso, nsIso } from './instante.mjs';
import { problemasDaLeitura, problemasDaProjecao } from './validacao.mjs';

export const EXECUTION_CONTRACT_VERSION = 1;

const TERMINAIS = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back']);
const ATIVIDADE = new Set(['preparing', 'starting', 'running', 'waiting']);
// Statuses em que o backend deixa o roster aparecer na shell (gate de UI pós-turn).
const ASSENTADO_PARA_FUNDO = new Set(['cancelled', 'completed', 'failed', 'interrupted', 'waiting']);
const TRABALHO_ATIVO = new Set(['pending', 'running', 'waiting']);
// Status de turn item e de subagent no contrato V2 (OrchestrationV2TurnItemStatus, Subagent.status).
const STATUS_TRABALHO = new Set(['idle', 'pending', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted']);
const identidadeValida = (x) => {
  const nativo = x?.nativeItemRef?.nativeId ?? x?.nativeTaskRef?.nativeId;
  return (typeof nativo === 'string' && nativo.length > 0) || (typeof x?.id === 'string' && x.id.length > 0);
};
const TIPOS_DE_FUNDO = new Set(['command_execution', 'dynamic_tool', 'subagent']);
const DESFECHOS = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const ENTREGA_PENDENTE = new Set(['pending', 'claimed']);

// Instante estrito: data impossível ou formato solto é null, nunca uma versão comprovada.
const ms = (iso) => msIso(iso);
const depoisDe = (a, b) => ms(a) !== null && ms(b) !== null && ms(a) > ms(b);
const maiorOrdinal = (runs) => runs.reduce((m, r) => (!m || r.ordinal > m.ordinal ? r : m), null);

/** Kind que segura a thread: tudo menos `command` (mesma regra do backend). */
export const seguraAThread = (kind) => kind !== 'command';

function refRun(run) {
  if (!run) return null;
  return {
    runId: run.id,
    ordinal: run.ordinal ?? null,
    status: run.status,
    requestedAt: run.requestedAt ?? null,
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    ...(run.queueHeld ? { queueHeld: true } : {}),
  };
}

/** Runs relevantes da projeção, com a regra da shell para o último run. */
export function runsDaProjecao(projecao, shellThread = null) {
  const runs = projecao.runs ?? [];
  const porId = new Map(runs.map((r) => [r.id, r]));
  // Último run como a shell escolhe (latestUnheldRun); a shell pode apresentar como último
  // um run barrado por limite de uso, então o ID dela vence quando a projeção o conhece.
  const naoRetidos = runs.filter((r) => !(r.status === 'queued' && r.queueHeld === true));
  const ultimo = (shellThread?.latestRunId && porId.get(shellThread.latestRunId)) || maiorOrdinal(naoRetidos);
  const ativo = maiorOrdinal(runs.filter((r) => ATIVIDADE.has(r.status)));
  const executado = maiorOrdinal(runs.filter((r) => r.startedAt || ATIVIDADE.has(r.status) || (TERMINAIS.has(r.status) && r.status !== 'cancelled')));
  const fila = runs.filter((r) => r.status === 'queued').sort((a, b) => a.ordinal - b.ordinal);
  return { ultimo, ativo, executado, fila, porId };
}

function idNativo(item) {
  const nativo = item?.nativeItemRef?.nativeId ?? item?.nativeTaskRef?.nativeId;
  return typeof nativo === 'string' && nativo.length > 0 ? nativo : String(item.id);
}

function kindDoItem(item) {
  if (item.type === 'subagent') return 'subagent';
  if (item.type === 'command_execution') return 'command';
  return 'background_task';
}

function descricao(texto) {
  return typeof texto === 'string' && texto.trim() ? texto.trim().slice(0, 200) : null;
}

/**
 * Trabalho em segundo plano conhecido pela projeção, sem o gate de UI da shell.
 *
 * - roster do provider thread ativo: sempre é segundo plano;
 * - turn items (command_execution, dynamic_tool, subagent) e subagents ativos: só contam
 *   quando não pertencem a um run ativo (dentro do run são o próprio turn);
 * - roster da shell: entra só quando a shell é da mesma versão da projeção, e cobre os
 *   turn items fora da janela do /bounded.
 *
 * `knowledge`: complete (roster presente e histórico de turn items coberto), partial
 * (roster presente, itens antigos fora da janela) ou unknown (servidor sem roster).
 */
export function trabalhoEmSegundoPlano(projecao, { historicoCompleto, shellThread = null, shellNaMesmaVersao = false, runs = runsDaProjecao(projecao, shellThread) } = {}) {
  const pendentes = new Map();
  const temRoster = Array.isArray(projecao.providerThreads);
  const providerAtivo = projecao.thread?.activeProviderThreadId ?? shellThread?.activeProviderThreadId ?? null;
  const runsAtivos = new Set((projecao.runs ?? []).filter((r) => ATIVIDADE.has(r.status)).map((r) => r.id));
  const rolledBack = new Set((projecao.runs ?? []).filter((r) => r.status === 'rolled_back').map((r) => r.id));
  const doTurnAtivo = (runId) => runId != null && runsAtivos.has(runId);
  const descartado = (runId) => runId != null && rolledBack.has(runId);
  // Mesma tarefa em várias fontes (roster, turn item, subagent): nenhuma evidência que segura a
  // thread é descartada por ter chegado depois; a entrada fica com o kind/fonte que segura e
  // registra as outras fontes (revisão aacaf76, P1).
  // Evidência de fundo malformada (tarefa sem identidade, status fora do contrato, roster que
  // não é lista) não é descartada em silêncio: o conhecimento vira `unknown` e nada prova
  // ausência de trabalho (revisão c357eae, P1).
  let malformado = false;
  const adicionar = (taskId, dados) => {
    if (!taskId) { malformado = true; return; }
    const novo = { taskId, ...dados, holdsThread: seguraAThread(dados.kind) };
    const atual = pendentes.get(taskId);
    if (!atual) { pendentes.set(taskId, novo); return; }
    const base = novo.holdsThread && !atual.holdsThread ? novo : atual;
    const outra = base === novo ? atual : novo;
    const fontes = [...new Set([...(atual.alsoSeenIn ?? []), outra.source])].filter((f) => f !== base.source);
    pendentes.set(taskId, { ...base, ...(fontes.length ? { alsoSeenIn: fontes } : {}) });
  };

  if (temRoster) {
    const threadsDoProvider = providerAtivo ? projecao.providerThreads.filter((t) => t.id === providerAtivo) : projecao.providerThreads;
    for (const pt of threadsDoProvider) {
      if (!pt || typeof pt !== 'object' || (pt.pendingBackgroundTasks != null && !Array.isArray(pt.pendingBackgroundTasks))) { malformado = true; continue; }
      for (const t of pt.pendingBackgroundTasks ?? []) {
        if (!t || typeof t.taskId !== 'string' || !t.taskId.trim()) { malformado = true; continue; }
        adicionar(t.taskId, {
          kind: t.kind ?? 'background_task',
          description: descricao(t.description),
          source: 'provider_roster',
          providerThreadId: pt.id,
          runId: null,
          startedAt: null,
          ...(t.childThreadId ? { childThreadId: t.childThreadId } : {}),
        });
      }
    }
  }
  for (const item of projecao.turnItems ?? []) {
    if (!item || !TIPOS_DE_FUNDO.has(item.type)) continue;
    if (!STATUS_TRABALHO.has(item.status) || !identidadeValida(item)) { malformado = true; continue; }
    if (!TRABALHO_ATIVO.has(item.status)) continue;
    if (doTurnAtivo(item.runId) || descartado(item.runId)) continue;
    // Ferramenta dinâmica persistente (monitor do Grok) fica fora, como no backend.
    if (item.type === 'dynamic_tool' && item.input && typeof item.input === 'object' && item.input.persistent === true) continue;
    if (item.runId == null && runsAtivos.size > 0) continue;
    adicionar(idNativo(item), {
      kind: kindDoItem(item),
      description: descricao(item.title ?? item.toolName ?? item.prompt ?? (typeof item.input === 'string' ? item.input : null)),
      source: 'turn_item',
      runId: item.runId ?? null,
      startedAt: item.startedAt ?? null,
      ...(item.childThreadId ? { childThreadId: item.childThreadId } : {}),
    });
  }
  for (const s of projecao.subagents ?? []) {
    if (!s || !STATUS_TRABALHO.has(s.status) || !identidadeValida(s)) { malformado = true; continue; }
    if (!TRABALHO_ATIVO.has(s.status) || doTurnAtivo(s.runId) || descartado(s.runId)) continue;
    if (s.runId == null && runsAtivos.size > 0) continue;
    adicionar(idNativo(s), {
      kind: 'subagent',
      description: descricao(s.title ?? s.prompt),
      source: 'subagent',
      runId: s.runId ?? null,
      startedAt: s.startedAt ?? null,
      ...(s.childThreadId ? { childThreadId: s.childThreadId } : {}),
    });
  }
  // O roster da shell é derivado da projeção completa, mas só com o gate aberto.
  const gateAberto = shellNaMesmaVersao && shellThread && !shellThread.activeRunId && ASSENTADO_PARA_FUNDO.has(shellThread.status);
  if (gateAberto) {
    for (const t of shellThread.pendingBackgroundTasks ?? []) {
      adicionar(t.taskId, { kind: t.kind ?? 'background_task', description: descricao(t.description), source: 'shell_roster', runId: null, startedAt: null });
    }
  }

  const knowledge = !temRoster || malformado ? 'unknown' : historicoCompleto || gateAberto ? 'complete' : 'partial';
  const lista = [...pendentes.values()];
  return {
    knowledge,
    pending: lista,
    endedSinceLatestRun: encerradosDepoisDoRun(projecao, runs.executado),
    _ativo: lista.length > 0 ? true : knowledge === 'complete' ? false : null,
    _segura: lista.some((t) => t.holdsThread) ? true : knowledge === 'complete' ? false : null,
  };
}

/**
 * Trabalho em segundo plano que terminou depois do último run executado terminar: nenhum
 * turn do modelo começou desde então, então o resultado ainda não foi absorvido. Fontes
 * com fim registrado: turn items e subagents com completedAt, notificações (turn item ou
 * mensagem) e entregas de tarefa delegada ainda pendentes. O roster do Claude só diz o
 * que está pendente; a saída de uma task dele não tem hora (ver t3_aguardar_thread com
 * until=execution_idle, que observa a transição).
 */
function encerradosDepoisDoRun(projecao, executado) {
  const ref = executado && TERMINAIS.has(executado.status) ? executado.completedAt : null;
  const vistos = new Map();
  const add = (chave, dados) => { if (!vistos.has(chave)) vistos.set(chave, dados); };
  if (ref || !executado) {
    for (const item of projecao.turnItems ?? []) {
      if (TIPOS_DE_FUNDO.has(item.type) && DESFECHOS.has(item.status) && (!executado || depoisDe(item.completedAt, ref))) {
        add(idNativo(item), { taskId: idNativo(item), kind: kindDoItem(item), source: 'turn_item', outcome: item.status, endedAt: item.completedAt, runId: item.runId ?? null });
      } else if (item.type === 'notification' && DESFECHOS.has(item.outcome) && (!executado || depoisDe(item.updatedAt ?? item.completedAt, ref))) {
        const taskId = item.source?.taskIds?.[0] ?? item.source?.childThreadId ?? `notification:${item.id}`;
        add(taskId, { taskId, kind: kindDaNotificacao(item.source), source: 'notification', outcome: item.outcome, endedAt: item.updatedAt ?? item.completedAt ?? null, runId: item.runId ?? null });
      }
    }
    for (const m of projecao.messages ?? []) {
      const n = m.notification;
      if (n && DESFECHOS.has(n.outcome) && (!executado || depoisDe(m.createdAt, ref))) {
        const taskId = n.source?.taskIds?.[0] ?? n.source?.childThreadId ?? `notification:${m.id}`;
        add(taskId, { taskId, kind: kindDaNotificacao(n.source), source: 'notification', outcome: n.outcome, endedAt: m.createdAt, runId: m.runId ?? null });
      }
    }
    for (const s of projecao.subagents ?? []) {
      if (DESFECHOS.has(s.status) && (!executado || depoisDe(s.completedAt, ref))) {
        add(idNativo(s), { taskId: idNativo(s), kind: 'subagent', source: 'subagent', outcome: s.status, endedAt: s.completedAt ?? null, runId: s.runId ?? null });
      }
    }
  }
  // Entrega de tarefa delegada ainda não observada por run nenhum: não depende de hora.
  for (const s of projecao.subagents ?? []) {
    if (DESFECHOS.has(s.status) && ENTREGA_PENDENTE.has(s.completionDelivery?.state)) {
      add(idNativo(s), { taskId: idNativo(s), kind: 'subagent', source: 'delegated_completion', outcome: s.status, endedAt: s.completedAt ?? null, runId: s.runId ?? null });
    }
  }
  return [...vistos.values()];
}

function kindDaNotificacao(source) {
  const k = source?.kind;
  if (k === 'delegated_task' || k === 'subagent') return 'subagent';
  if (k === 'command' || k === 'background_command') return 'command';
  if (k === 'monitor') return 'monitor';
  return 'background_task';
}

/** Falha do run a partir do turn item de erro desse run (o run em si não tem `error`). */
function falhaDoRun(projecao, run, shellThread, shellConcorda) {
  if (!run || run.status !== 'failed') return null;
  const erros = (projecao.turnItems ?? []).filter((i) => i.type === 'error' && i.runId === run.id && i.failure);
  const f = erros.at(-1)?.failure;
  if (f) return { runId: run.id, class: f.class ?? null, code: f.code ?? null, message: f.message ?? null, source: 'turn_item' };
  if (shellConcorda && shellThread?.latestRunId === run.id && (shellThread.lastError || shellThread.lastErrorClass)) {
    return { runId: run.id, class: shellThread.lastErrorClass ?? null, code: null, message: shellThread.lastError ?? null, source: 'shell' };
  }
  return { runId: run.id, class: null, code: null, message: null, source: 'unavailable' };
}

function sessaoDoProvider(projecao, providerInstanceId) {
  const s = (projecao.providerSessions ?? [])
    .filter((x) => !providerInstanceId || x.providerInstanceId === undefined || x.providerInstanceId === providerInstanceId)
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0];
  if (!s) return null;
  return { id: s.id ?? null, status: s.status, model: s.model ?? null, updatedAt: s.updatedAt ?? null, lastError: s.lastError ?? null, informational: true };
}

/** Metadados da última resposta assistant e sua relação com os runs (sem o texto). */
function relacaoDaResposta(projecao, runs) {
  const mensagens = projecao.messages ?? [];
  let ultima = null;
  for (let i = mensagens.length - 1; i >= 0; i--) {
    if (mensagens[i].role === 'assistant' && mensagens[i].text) { ultima = mensagens[i]; break; }
  }
  const executado = runs.executado;
  const doExecutado = executado ? mensagens.some((m) => m.role === 'assistant' && m.text && m.runId === executado.id) : false;
  if (!ultima) return { latestResponse: null, doExecutado };
  const run = ultima.runId ? runs.porId.get(ultima.runId) : null;
  let relation;
  if (!ultima.runId) relation = 'unattributed';
  else if (executado && ultima.runId === executado.id) relation = 'latest_executed_run';
  else if (run && executado && run.ordinal < executado.ordinal) relation = 'older_run';
  else relation = 'unknown_run';
  return {
    latestResponse: {
      messageId: ultima.id,
      runId: ultima.runId ?? null,
      runOrdinal: run?.ordinal ?? null,
      createdAt: ultima.createdAt ?? null,
      updatedAt: ultima.updatedAt ?? null,
      streaming: Boolean(ultima.streaming),
      relation,
    },
    doExecutado,
  };
}

/**
 * Compara a shell com a projeção da mesma thread. A projeção é uma transação só; a shell
 * foi lida antes dela. Diferença aqui não invalida a projeção: diz que os campos do topo
 * da resposta (derivados da shell) podem estar atrás.
 */
export function compararShell(shellThread, projecao) {
  const motivos = [];
  if (!shellThread) return { mesmaVersao: false, motivos: [{ code: 'shell_unavailable' }] };
  const runs = projecao.runs ?? [];
  const porId = new Map(runs.map((r) => [r.id, r]));
  const atualizadaEm = projecao.updatedAt ?? projecao.thread?.updatedAt ?? null;
  // Mesma versão só com prova positiva: os dois instantes presentes, válidos e iguais. Ausente ou
  // inválido não "confere" (dois inválidos virariam null === null), é versão não comprovada.
  // Igualdade exata (nanossegundos, BigInt): instantes distintos nunca comparam iguais.
  const msShell = nsIso(shellThread.updatedAt);
  const msProjecao = nsIso(atualizadaEm);
  const mesmaVersao = msShell !== null && msProjecao !== null && msShell === msProjecao;
  if (msShell === null || msProjecao === null) {
    motivos.push({ code: 'thread_version_unproven', shellUpdatedAt: shellThread.updatedAt ?? null, projectionUpdatedAt: atualizadaEm });
  } else if (!mesmaVersao) {
    motivos.push({ code: 'thread_version_differs', shellUpdatedAt: shellThread.updatedAt, projectionUpdatedAt: atualizadaEm });
  }
  if (shellThread.latestRunId) {
    const r = porId.get(shellThread.latestRunId);
    if (!r) motivos.push({ code: 'latest_run_missing', runId: shellThread.latestRunId });
    else if (r.status !== shellThread.status) motivos.push({ code: 'latest_run_status_differs', runId: r.id, shellStatus: shellThread.status, projectionStatus: r.status });
  }
  // Run mais novo que já executou e que a shell não conhece. Runs novos só na fila ou
  // cancelados antes de começar não contam: a shell pode apresentar como último o run
  // barrado por limite de uso (usageLimitRunPresentedAsLatest).
  const doShell = shellThread.latestRunId ? porId.get(shellThread.latestRunId) : null;
  const maisNovo = maiorOrdinal(runs.filter((r) => r.startedAt || ATIVIDADE.has(r.status)));
  if (maisNovo && maisNovo.id !== shellThread.latestRunId && (!doShell || maisNovo.ordinal > doShell.ordinal)) {
    motivos.push({ code: 'newer_run_not_in_shell', runId: maisNovo.id, shellLatestRunId: shellThread.latestRunId ?? null });
  }
  const interrompivel = runs.filter((r) => r.status === 'preparing' || r.status === 'starting' || r.status === 'running');
  const ativoDaProjecao = maiorOrdinal(interrompivel)?.id ?? null;
  if ((shellThread.activeRunId ?? null) !== ativoDaProjecao) {
    motivos.push({ code: 'active_run_differs', shellActiveRunId: shellThread.activeRunId ?? null, projectionActiveRunId: ativoDaProjecao });
  }
  const pendentes = (projecao.runtimeRequests ?? []).filter((q) => q.status === 'pending').map((q) => q.id);
  const pedidoShell = shellThread.pendingRuntimeRequest?.id ?? null;
  if (pedidoShell ? !pendentes.includes(pedidoShell) : pendentes.length > 0) {
    motivos.push({ code: 'pending_request_differs', shellRequestId: pedidoShell, projectionPendingRequestIds: pendentes });
  }
  return { mesmaVersao, motivos };
}

/**
 * Snapshot de execução. Entrada: a projeção (uma transação), a linha da shell da mesma
 * thread (para limite de uso, plano e roster de cobertura) e metadados da leitura.
 *
 * @param projecao projection do /bounded, do snapshot completo ou da subscription
 * @param shellThread linha da shell ou null
 * @param threadId o alvo: a projeção e a linha da shell têm de ser dele
 * @param fonte {kind, threadSequence, historyComplete, attempts, observedAt}
 */
export function derivarExecucao({ projecao, shellThread = null, threadId, fonte = {}, limitRecovery = shellThread?.limitRecovery ?? null, evidenciaInvalida = [] }) {
  const problemas = [...new Set([...problemasDaProjecao(projecao), ...problemasDaLeitura({ projecao, shellThread, threadId, fonte }), ...evidenciaInvalida])];
  if (!projecao || typeof projecao !== 'object') projecao = {};
  const comparacao = shellThread ? compararShell(shellThread, projecao) : null;
  const shellConcorda = Boolean(comparacao && comparacao.motivos.length === 0);
  const runs = runsDaProjecao(projecao, shellThread);
  const historicoCompleto = Boolean(fonte.historyComplete);
  const fundo = trabalhoEmSegundoPlano(projecao, { historicoCompleto, shellThread, shellNaMesmaVersao: Boolean(comparacao?.mesmaVersao), runs });
  const { latestResponse, doExecutado } = relacaoDaResposta(projecao, runs);
  const pendentes = (projecao.runtimeRequests ?? [])
    .filter((q) => q.status === 'pending')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map((q) => ({ requestId: q.id, kind: q.kind, createdAt: q.createdAt ?? null }));
  // Qualquer das duas fontes basta para bloquear: a shell pode sinalizar um plano que a
  // projeção não traz como artefato, e nenhuma das duas sozinha prova a ausência da outra.
  const planoAtivo = (Array.isArray(projecao.plans) && projecao.plans.some((p) => p.kind === 'proposed_plan' && p.status === 'active'))
    || shellThread?.hasActionableProposedPlan === true;
  const limite = limitRecovery;

  const ativo = runs.ativo;
  const executado = runs.executado;
  const foregroundActive = Boolean(ativo);
  const runTerminal = Boolean(executado && TERMINAIS.has(executado.status) && !ativo);
  const queuedWork = runs.fila.length > 0;
  const pendingIntervention = pendentes.length > 0 || planoAtivo || Boolean(limite && !limite.autoResume);
  const encerradoSemAbsorver = fundo.endedSinceLatestRun.length > 0 && !foregroundActive && !queuedWork;
  const respostaVelha = latestResponse ? latestResponse.relation !== 'latest_executed_run' : null;
  const runSemResposta = runTerminal ? !doExecutado : null;

  const blockers = [];
  if (foregroundActive) blockers.push('active_run');
  if (queuedWork) blockers.push('queued_runs');
  if (pendentes.length > 0) blockers.push('pending_request');
  if (planoAtivo) blockers.push('proposed_plan');
  if (limite) blockers.push(limite.autoResume ? 'usage_limit_auto_resume' : 'usage_limit');
  if (fundo._segura === true) blockers.push('background_work_active');
  if (fundo._segura === null) blockers.push('background_work_unknown');
  // Projeção fora do contrato (ou linhas da shell em conflito): nada é provado a partir dela.
  if (problemas.length) blockers.push('execution_evidence_invalid');

  const reasons = [];
  if (encerradoSemAbsorver) reasons.push('background_work_ended_after_latest_run');
  if (runSemResposta) reasons.push('latest_run_without_assistant_response');
  if (runTerminal && executado.status === 'failed') reasons.push('latest_run_failed');

  const idle = blockers.length === 0;
  return {
    contractVersion: EXECUTION_CONTRACT_VERSION,
    observedAt: fonte.observedAt ?? new Date().toISOString(),
    source: {
      kind: fonte.kind ?? 'thread_snapshot',
      threadSequence: fonte.threadSequence ?? null,
      projectionUpdatedAt: projecao.updatedAt ?? projecao.thread?.updatedAt ?? null,
      shellUpdatedAt: shellThread?.updatedAt ?? null,
      history: historicoCompleto ? 'complete' : 'window',
    },
    evidence: problemas.length ? { valid: false, problems: problemas } : { valid: true },
    coherence: {
      status: !shellThread ? 'projection_only' : shellConcorda ? 'coherent' : 'shell_lagging',
      attempts: fonte.attempts ?? 1,
      reasons: comparacao?.motivos ?? [],
    },
    runs: {
      latest: refRun(runs.ultimo),
      active: refRun(ativo),
      latestExecuted: refRun(executado),
      queued: runs.fila.map(refRun),
    },
    latestRunFailure: falhaDoRun(projecao, executado, shellThread, shellConcorda),
    latestResponse,
    pendingRequests: pendentes,
    providerSession: sessaoDoProvider(projecao, projecao.thread?.providerInstanceId ?? shellThread?.providerInstanceId),
    background: { knowledge: fundo.knowledge, pending: fundo.pending, endedSinceLatestRun: fundo.endedSinceLatestRun },
    signals: {
      runTerminal,
      foregroundActive,
      queuedWork,
      pendingIntervention,
      backgroundWorkActive: fundo._ativo,
      backgroundWorkHoldsThread: fundo._segura,
      backgroundWorkEndedUnconsumed: encerradoSemAbsorver,
      responseStale: respostaVelha,
      latestRunHasNoAssistantResponse: runSemResposta,
      operationallyIdle: idle,
    },
    continuation: {
      canStartNow: idle,
      blockers,
      reasons,
      recommended: idle && reasons.length > 0,
      target: 'same_thread',
    },
  };
}

// Eventos de orchestration.subscribeThread que trocam uma entidade inteira por ID.
const COLECAO_DO_EVENTO = {
  'run.created': 'runs',
  'run.updated': 'runs',
  'runtime-request.updated': 'runtimeRequests',
  'message.updated': 'messages',
  'turn-item.updated': 'turnItems',
  'subagent.updated': 'subagents',
  'provider-thread.updated': 'providerThreads',
  'provider-session.attached': 'providerSessions',
  'provider-session.updated': 'providerSessions',
  'plan.updated': 'plans',
};

/**
 * Aplica um lote da subscription numa cópia de trabalho da projeção, em ordem de
 * sequence; eventos repetidos (sequence já vista) são ignorados. Devolve a sequence mais
 * alta aplicada. Eventos de tipo desconhecido só avançam a versão.
 */
export function aplicarItens(estado, itens) {
  for (const item of itens) {
    if (item.kind === 'snapshot') {
      estado.projecao = structuredClone(item.projection ?? {});
      estado.sequencia = item.snapshotSequence ?? estado.sequencia ?? null;
      // Sem hasMoreHistory o snapshot é a projeção completa (orchestrationV2.ts:3002-3010).
      estado.historicoCompleto = item.hasMoreHistory !== true;
      continue;
    }
    if (item.kind !== 'event' || !estado.projecao) continue;
    const seq = item.sequence ?? item.event?.sequence ?? null;
    if (seq !== null && estado.sequencia !== null && seq <= estado.sequencia) continue;
    const { type, payload, occurredAt } = item.event ?? {};
    const colecao = COLECAO_DO_EVENTO[type];
    if (colecao && payload?.id) {
      const lista = (estado.projecao[colecao] ??= []);
      const i = lista.findIndex((x) => x.id === payload.id);
      if (i >= 0) lista[i] = payload; else lista.push(payload);
    } else if (type?.startsWith('thread.') && payload?.id && type !== 'thread.deleted') {
      estado.projecao.thread = { ...estado.projecao.thread, ...payload };
    }
    if (occurredAt) estado.projecao.updatedAt = occurredAt;
    if (seq !== null) estado.sequencia = seq;
  }
  return estado;
}
