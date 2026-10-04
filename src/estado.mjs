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
  command: 'aprovação de comando',
  'file-read': 'aprovação de leitura de arquivo',
  'file-change': 'aprovação de alteração de arquivo',
  permission: 'aprovação de permissão',
  'mcp-elicitation': 'ferramenta MCP pedindo dados',
  user_input: 'pergunta aguardando resposta',
  dynamic_tool_call: 'chamada de ferramenta aguardando resposta',
  auth_refresh: 'provider pedindo nova autenticação',
};

export function motivoDoPedido(kind) {
  return MOTIVO_DO_PEDIDO[kind] ?? `pedido pendente do tipo ${kind}`;
}

function intervencaoPorPedido(pedido) {
  return {
    estado: 'precisa_intervencao',
    motivo: motivoDoPedido(pedido.kind),
    tipo: pedido.kind,
    identificador: { runtimeRequestId: pedido.id },
    desde: pedido.createdAt,
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
      estado: 'precisa_intervencao',
      motivo: 'limite de uso do provider; retomada automática desligada',
      tipo: 'usage_limit',
      identificador: { runId: limite.runId },
      desde: null,
      liberaEm: limite.resetAt,
      statusRun: status,
      runId,
    };
  }

  if (RODANDO.has(status)) {
    return { estado: 'rodando', statusRun: status, runId, ...(limite?.autoResume ? { retomaEm: limite.resetAt } : {}) };
  }
  if (status === 'waiting') {
    // Run em espera sem pedido no resumo: não é término nem intervenção confirmada.
    return {
      estado: 'rodando',
      statusRun: status,
      runId,
      observacao: 'run em espera sem pedido pendente visível; consultar a thread para confirmar',
    };
  }
  if (thread.hasActionableProposedPlan) {
    return {
      estado: 'precisa_intervencao',
      motivo: 'plano proposto aguardando decisão',
      tipo: 'proposed_plan',
      identificador: { runId: thread.latestRunId },
      desde: thread.latestRunCompletedAt ?? null,
      statusRun: status,
      runId,
    };
  }
  if (status === 'completed') {
    const fundo = thread.pendingBackgroundTasks ?? [];
    return {
      estado: 'concluida',
      statusRun: status,
      runId,
      ...(fundo.length ? { tarefasEmSegundoPlano: fundo.map((t) => ({ kind: t.kind, taskId: t.taskId, descricao: t.description ?? null })) } : {}),
    };
  }
  if (status === 'failed') {
    return {
      estado: 'falhou',
      statusRun: status,
      runId,
      erro: thread.lastError ?? null,
      classeErro: thread.lastErrorClass ?? null,
    };
  }
  if (CANCELADA.has(status)) {
    return { estado: 'cancelada', statusRun: status, runId };
  }
  if (status === 'idle') {
    return { estado: 'sem_execucao', statusRun: status, runId: null };
  }
  return { estado: 'desconhecido', statusRun: status, runId };
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
      texto,
      truncada: m.text.length > maxCaracteres,
      emAndamento: Boolean(m.streaming),
      atualizadaEm: m.updatedAt,
    };
  }
  return null;
}

export function resumoModelo(modelSelection) {
  if (!modelSelection) return null;
  const opcoes = Object.fromEntries((modelSelection.options ?? []).map((o) => [o.id, o.value]));
  return {
    modelo: modelSelection.model,
    instancia: modelSelection.instanceId ?? null,
    esforco: opcoes.reasoningEffort ?? opcoes.effort ?? null,
  };
}
