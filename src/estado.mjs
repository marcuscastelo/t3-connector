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
 * Estado a partir do item da listagem (/api/orchestration/shell), sem outra chamada.
 * `pedidosPendentes` é opcional: vem do snapshot da thread quando já foi lido.
 */
export function estadoDaThread(thread, pedidosPendentes = []) {
  const status = thread.status;
  const runId = thread.activeRunId ?? thread.latestRunId ?? null;

  if (thread.pendingRuntimeRequest) {
    return { ...intervencaoPorPedido(thread.pendingRuntimeRequest), statusRun: status, runId };
  }
  if (pedidosPendentes.length > 0) {
    return { ...intervencaoPorPedido(pedidosPendentes[0]), statusRun: status, runId };
  }

  const limite = thread.limitRecovery;
  if (limite && !limite.autoResume && !RODANDO.has(status)) {
    return {
      state: 'needs_intervention',
      reason: 'provider usage limit; automatic resume is off',
      kind: 'usage_limit',
      identifier: { runId: limite.runId },
      since: null,
      resetAt: limite.resetAt,
      statusRun: status,
      runId,
    };
  }

  if (RODANDO.has(status)) {
    return { state: 'running', statusRun: status, runId, ...(limite?.autoResume ? { resumeAt: limite.resetAt } : {}) };
  }
  if (status === 'waiting') {
    // Run em espera sem pedido no resumo: não é término nem intervenção confirmada.
    return {
      state: 'running',
      statusRun: status,
      runId,
      note: 'run waiting with no visible pending request; read the thread to confirm',
    };
  }
  if (thread.hasActionableProposedPlan) {
    return {
      state: 'needs_intervention',
      reason: 'proposed plan waiting for a decision',
      kind: 'proposed_plan',
      identifier: { runId: thread.latestRunId },
      since: thread.latestRunCompletedAt ?? null,
      statusRun: status,
      runId,
    };
  }
  if (status === 'completed') {
    const fundo = thread.pendingBackgroundTasks ?? [];
    return {
      state: 'completed',
      statusRun: status,
      runId,
      ...(fundo.length ? { backgroundTasks: fundo.map((t) => ({ kind: t.kind, taskId: t.taskId, description: t.description ?? null })) } : {}),
    };
  }
  if (status === 'failed') {
    return {
      state: 'failed',
      statusRun: status,
      runId,
      error: thread.lastError ?? null,
      errorClass: thread.lastErrorClass ?? null,
    };
  }
  if (CANCELADA.has(status)) {
    return { state: 'cancelled', statusRun: status, runId };
  }
  if (status === 'idle') {
    return { state: 'no_run', statusRun: status, runId: null };
  }
  return { state: 'unknown', statusRun: status, runId };
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
