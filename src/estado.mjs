// Estado de uma thread do Orchestrator V2 traduzido para o que um assistente de voz precisa dizer.
//
// Fonte: contrato V2 do T3 Code no commit do nightly instalado (8ed276c2):
// - OrchestrationV2ShellThread.status = status do último run, ou "idle" sem run
//   (apps/server/src/orchestration-v2/ProjectionStore.ts:506 e :1372);
// - OrchestrationV2RunStatus: preparing, queued, starting, running, waiting, completed,
//   interrupted, failed, cancelled, rolled_back (packages/contracts/src/orchestrationV2.ts:445);
// - pendingRuntimeRequest {id, kind, createdAt} resume o pedido que segura o run
//   (orchestrationV2.ts:1649); kind = command | file-read | file-change | mcp-elicitation |
//   permission (providerPolicy.ts:38) | dynamic_tool_call | user_input | auth_refresh
//   (orchestrationV2.ts:922);
// - o adapter grava o pedido como nó "approval_request" em "waiting" e runtimeRequest
//   "pending" (Adapters/CodexAdapterV2.ts:3545-3600).
//
// Término de run e espera por pessoa são coisas distintas: "completed" nunca vira
// intervenção, e um pedido pendente vence qualquer status de run.
//
// Fontes concorrentes na shell (ProjectionStore.threadShellFromProjection):
// - `status`/`latestRunId`: o run de maior ordinal fora de fila retida, mesmo que já
//   tenha terminado. Promover mensagem da fila a steer ou cancelar um run da fila deixa
//   esse run novo "cancelled" enquanto o run anterior continua rodando;
// - `activeRunId` (preparing, starting, running) e `activityRunStatus` (inclui waiting):
//   o run que a thread executa agora.
// Precedência do `state`: pedido pendente > run ativo > limite de uso / plano proposto >
// desfecho do último run. `stateSource` diz qual sinal decidiu; `runId`/`statusRun` são
// sempre do run que o `state` descreve, e `latestRunId`/`latestRunStatus` só aparecem,
// como informação, quando o último run é outro.

const RODANDO = new Set(['preparing', 'queued', 'starting', 'running']);
const CANCELADA = new Set(['cancelled', 'interrupted', 'rolled_back']);

const MOTIVO_DO_PEDIDO = {
  command: 'command approval',
  'file-read': 'file read approval',
  'file-change': 'file change approval',
  permission: 'permission approval',
  'mcp-elicitation': 'MCP tool asking for data',
  user_input: 'question waiting for an answer',
  dynamic_tool_call: 'tool call waiting for a response',
  auth_refresh: 'provider asking to authenticate again',
};

export function motivoDoPedido(kind) {
  return MOTIVO_DO_PEDIDO[kind] ?? `pending request of kind ${kind}`;
}

function intervencaoPorPedido(pedido) {
  return {
    state: 'needs_intervention',
    reason: motivoDoPedido(pedido.kind),
    kind: pedido.kind,
    identifier: { runtimeRequestId: pedido.id },
    since: pedido.createdAt,
  };
}

/**
 * Run que a thread executa agora segundo a shell, ou null. `status` da shell é só o do
 * último run; quando ele não é o ativo, o status do ativo vem de `activityRunStatus`.
 * Servidores sem esses campos caem no desfecho do último run.
 */
export function runAtivoDaShell(thread) {
  const { activeRunId, activityRunStatus, latestRunId, status } = thread;
  if (activeRunId) {
    if (activeRunId === latestRunId) return { runId: activeRunId, status };
    return { runId: activeRunId, status: activityRunStatus && activityRunStatus !== 'waiting' ? activityRunStatus : 'running' };
  }
  if (activityRunStatus) {
    // Run em waiting não é interrompível, então não aparece em activeRunId.
    return { runId: status === activityRunStatus ? latestRunId : null, status: activityRunStatus };
  }
  return null;
}

/**
 * Estado a partir do item da listagem (/api/orchestration/shell), sem outra chamada.
 * `pedidosPendentes` é opcional: vem do snapshot da thread quando já foi lido.
 */
export function estadoDaThread(thread, pedidosPendentes = []) {
  const ativo = runAtivoDaShell(thread);
  const status = ativo ? ativo.status : thread.status;
  const runId = ativo ? ativo.runId : (thread.latestRunId ?? null);
  const notas = [];
  const base = { statusRun: status, runId };
  if (ativo && thread.latestRunId && thread.latestRunId !== ativo.runId) {
    base.latestRunId = thread.latestRunId;
    base.latestRunStatus = thread.status;
    notas.push(`newest run ${thread.latestRunId} is ${thread.status}, but run ${ativo.runId ?? '(waiting)'} is still active; state follows the active run`);
  }
  const comNotas = (e) => (notas.length ? { ...e, note: notas.join('; ') } : e);

  if (thread.pendingRuntimeRequest) {
    return comNotas({ ...intervencaoPorPedido(thread.pendingRuntimeRequest), stateSource: 'pending_request', ...base });
  }
  if (pedidosPendentes.length > 0) {
    return comNotas({ ...intervencaoPorPedido(pedidosPendentes[0]), stateSource: 'pending_request', ...base });
  }

  const limite = thread.limitRecovery;
  if (ativo || RODANDO.has(status) || status === 'waiting') {
    if (status === 'waiting') {
      // Run em espera sem pedido no resumo: não é término nem intervenção confirmada.
      notas.push('run waiting with no visible pending request; read the thread to confirm');
    }
    return comNotas({
      state: 'running',
      stateSource: ativo ? 'active_run' : 'latest_run',
      ...base,
      ...(limite?.autoResume ? { resumeAt: limite.resetAt } : {}),
    });
  }
  if (limite && !limite.autoResume) {
    return {
      state: 'needs_intervention',
      reason: 'provider usage limit; automatic resume is off',
      kind: 'usage_limit',
      identifier: { runId: limite.runId },
      since: null,
      resetAt: limite.resetAt,
      stateSource: 'usage_limit',
      ...base,
    };
  }
  if (thread.hasActionableProposedPlan) {
    return {
      state: 'needs_intervention',
      reason: 'proposed plan waiting for a decision',
      kind: 'proposed_plan',
      identifier: { runId: thread.latestRunId },
      since: thread.latestRunCompletedAt ?? null,
      stateSource: 'proposed_plan',
      ...base,
    };
  }
  if (status === 'completed') {
    const fundo = thread.pendingBackgroundTasks ?? [];
    return {
      state: 'completed',
      stateSource: 'latest_run',
      ...base,
      ...(fundo.length ? { backgroundTasks: fundo.map((t) => ({ kind: t.kind, taskId: t.taskId, description: t.description ?? null })) } : {}),
    };
  }
  if (status === 'failed') {
    return {
      state: 'failed',
      stateSource: 'latest_run',
      ...base,
      error: thread.lastError ?? null,
      errorClass: thread.lastErrorClass ?? null,
    };
  }
  if (CANCELADA.has(status)) {
    return { state: 'cancelled', stateSource: 'latest_run', ...base };
  }
  if (status === 'idle') {
    return { state: 'no_run', stateSource: 'no_run', statusRun: status, runId: null };
  }
  return { state: 'unknown', stateSource: 'latest_run', ...base };
}

// Marcador Woke: a thread acordou de um snooze e o usuário ainda não reconheceu.
//
// Não há flag persistida: o T3 deriva o marcador no cliente a partir de campos duráveis da
// shell (snoozedUntil, snoozedAt, lastVisitedAt, settledOverride, último run, pedido
// pendente) e do relógio. Fonte: T3 Code nightly 3e6b4502 (0.0.46-nightly.20261005.2689),
// igual ao main 9bd1d800:
// - threadWokeAt / threadRaisedHandWhileSnoozed (packages/client-runtime/src/state/threadSettled.ts:103-211);
// - tradução da shell (packages/client-runtime/src/state/models.ts:173-274);
// - regra do indicador (apps/web/src/components/Sidebar.tsx:1239-1244) e watermark do
//   servidor autoritativo (apps/web/src/components/Sidebar.logic.ts:756-765).
// Prazo vencido não gera evento nem muda updatedAt: o marcador depende de `agora`.
// Não confundir com `completionWake`, política de entrega de uma delegated task ao pai.

function instante(texto) {
  return texto == null ? NaN : Date.parse(texto);
}

/** Instante em que a thread acordou do snooze, ou null se nunca dormiu ou ainda dorme. */
function acordouEm(thread, agoraMs) {
  const prazo = instante(thread.snoozedUntil);
  if (Number.isNaN(prazo)) return null;
  const pedido = thread.pendingRuntimeRequest?.kind;
  // auth_refresh não conta como aprovação nem como pergunta (models.ts:249-253).
  const pedidoAcorda = pedido != null && pedido !== 'auth_refresh';
  // Runtime da shell: activityRunStatus nunca é "failed", então só falha o último run sem
  // atividade; sem run nem provider thread não há runtime.
  const temRuntime = thread.latestRunId != null || thread.activeProviderThreadId != null;
  const falhou = temRuntime && !thread.activityRunStatus && thread.status === 'failed';
  const statusUltimo = thread.status === 'idle' ? 'completed' : thread.status;
  const terminouEm = thread.latestRunCompletedAt === undefined
    ? (statusUltimo === 'completed' || CANCELADA.has(statusUltimo) || statusUltimo === 'failed' ? thread.updatedAt : null)
    : thread.latestRunCompletedAt;
  const snoozeEm = instante(thread.snoozedAt);
  const concluiuDepois = thread.latestRunId != null && statusUltimo === 'completed' && terminouEm != null
    && instante(terminouEm) > snoozeEm;
  // Só falha nova acorda: snooze feito sobre uma falha já vista continua valendo.
  const falhaNova = falhou && (thread.snoozedAt == null || instante(thread.updatedAt) > snoozeEm);
  if (pedidoAcorda || falhaNova || concluiuDepois) {
    if (concluiuDepois) return terminouEm;
    return (temRuntime ? thread.updatedAt : null) ?? thread.snoozedAt ?? null;
  }
  return prazo <= agoraMs ? thread.snoozedUntil : null;
}

/**
 * `{woke, wokeAt}` de um item da shell. `woke` é true/false, ou null quando o servidor não
 * traz os campos (anterior ao snooze ou ao watermark de visita compartilhado; o T3 recorre
 * então à visita local do navegador, que o connector não vê). Ler não reconhece o marcador.
 */
export function marcadorWoke(thread, agora = new Date().toISOString()) {
  if (thread.snoozedUntil === undefined) return { woke: null, wokeAt: null };
  const wokeAt = acordouEm(thread, Date.parse(agora));
  const acordouMs = instante(wokeAt);
  if (Number.isNaN(acordouMs) || thread.settledOverride === 'settled') return { woke: false, wokeAt };
  if (thread.lastVisitedAt === undefined) return { woke: null, wokeAt };
  // Visita ilegível conta como nunca visitada (Sidebar.tsx:1237-1239).
  const visitaMs = instante(thread.lastVisitedAt);
  return { woke: Number.isNaN(visitaMs) || visitaMs < acordouMs, wokeAt };
}

/** Pedidos `pending` do snapshot /bounded, do mais antigo para o mais novo. */
export function pedidosPendentes(projecao) {
  return (projecao.runtimeRequests ?? [])
    .filter((r) => r.status === 'pending')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** Hint by request ID; legacy node-only items are a display fallback, not an answer contract. */
export function detalheDoPedido(projecao, pedido) {
  const itens = projecao.turnItems ?? [];
  const item = itens.find((i) => i.requestId === pedido.id)
    ?? itens.find((i) => i.requestId == null && pedido.nodeId != null && i.nodeId === pedido.nodeId);
  const texto = item?.title ?? item?.text ?? null;
  return texto ? String(texto).slice(0, 500) : null;
}

export function ultimaResposta(projecao, maxCaracteres = 1500) {
  const mensagens = projecao.messages ?? [];
  for (let i = mensagens.length - 1; i >= 0; i--) {
    const m = mensagens[i];
    if (m.role !== 'assistant' || !m.text) continue;
    const texto = m.text.length > maxCaracteres ? m.text.slice(-maxCaracteres) : m.text;
    return {
      messageId: m.id,
      runId: m.runId,
      text: texto,
      truncated: m.text.length > maxCaracteres,
      streaming: Boolean(m.streaming),
      updatedAt: m.updatedAt,
    };
  }
  return null;
}

export function resumoModelo(modelSelection) {
  if (!modelSelection) return null;
  const opcoes = Object.fromEntries((modelSelection.options ?? []).map((o) => [o.id, o.value]));
  return {
    model: modelSelection.model,
    instanceId: modelSelection.instanceId ?? null,
    effort: opcoes.reasoningEffort ?? opcoes.effort ?? null,
  };
}
