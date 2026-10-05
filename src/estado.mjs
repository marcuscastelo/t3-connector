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
