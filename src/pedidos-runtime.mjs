import { z } from 'zod';
import { detalheDoPedido, motivoDoPedido, pedidosPendentes } from './estado.mjs';

// Public V2 turn-item fields only; never spread provider payloads or native refs.
const texto = z.string().refine(value => value.trim().length > 0);
const pergunta = z.object({
  id: texto, header: texto, question: texto,
  options: z.array(z.object({ label: texto, description: texto, value: z.string().optional() })),
  multiSelect: z.boolean().optional(), allowCustomAnswer: z.boolean().optional(), required: z.boolean().optional(),
});
const perguntas = z.object({
  questions: z.array(pergunta).min(1), responseMode: z.literal('message').optional(),
});
const APROVACOES = new Set(['command', 'file-read', 'file-change', 'permission', 'mcp-elicitation']);
const aprovacao = z.object({
  prompt: texto, appName: z.string().optional(),
  options: z.array(z.object({
    decision: z.enum(['accept', 'acceptForSession', 'acceptAlways', 'decline', 'cancel']),
    label: texto, warning: texto.optional(),
  })).optional(),
});
const capacidade = z.discriminatedUnion('type', [
  z.object({ type: z.literal('live') }),
  z.object({ type: z.literal('message') }),
  z.object({ type: z.literal('not_resumable'), reason: z.string() }),
]);

export function resumirPedidoRuntime(projecao, pedido, threadId) {
  // Several requests may share a node. A node/title match cannot identify a question.
  const tipoItem = pedido.kind === 'user_input' ? 'user_input_request' : 'approval_request';
  const item = (projecao.turnItems ?? []).find(i => i.requestId === pedido.id && i.type === tipoItem);
  let conteudo = null;
  let indisponibilidade = 'request_detail_not_in_snapshot';
  if (pedido.kind !== 'user_input' && !APROVACOES.has(pedido.kind)) {
    indisponibilidade = 'unsupported_request_kind';
  } else if (item) {
    const schema = pedido.kind === 'user_input' ? perguntas : aprovacao;
    const parsed = schema.safeParse(item);
    if (parsed.success && (pedido.kind === 'user_input' || item.requestKind === pedido.kind)) {
      conteudo = { type: pedido.kind === 'user_input' ? 'user_input' : 'approval', ...parsed.data };
    } else {
      indisponibilidade = 'request_detail_incomplete_or_invalid';
    }
  }
  const response = capacidade.safeParse(pedido.responseCapability);
  const responseCapability = response.success ? response.data : null;
  const action = conteudo?.type === 'user_input' ? 'runtime-request.answer' : 'runtime-request.approve';
  const bloqueio = !conteudo ? indisponibilidade
    : !responseCapability ? 'response_capability_unavailable'
    : responseCapability.type === 'not_resumable' ? 'request_not_resumable' : null;
  const proximaAcao = bloqueio
    ? { type: 'inspect_in_t3', reason: bloqueio }
    : {
      type: 'respond_runtime_request', action,
      tool: `t3_escrever_${action.replaceAll('.', '_').replaceAll('-', '_')}`,
      input: { ...(threadId ? { threadId } : {}), requestId: pedido.id },
      responseField: conteudo.type === 'user_input' ? 'answers' : 'decision',
      requiresUserDecision: true,
    };
  return {
    runtimeRequestId: pedido.id, requestId: pedido.id,
    kind: pedido.kind, reason: motivoDoPedido(pedido.kind),
    nodeId: pedido.nodeId ?? null, since: pedido.createdAt,
    detail: detalheDoPedido(projecao, pedido),
    responseCapability,
    content: conteudo, contentAvailable: conteudo !== null,
    unavailableReason: conteudo ? null : indisponibilidade,
    threadSendAnswersRequest: false,
    nextAction: proximaAcao,
  };
}

export function resumirPedidosRuntime(projecao, thread) {
  const pendentes = pedidosPendentes(projecao);
  const resumo = thread.pendingRuntimeRequest;
  // The bounded projection can omit the request entirely. Keep the shell ID visible,
  // except when the newer projection explicitly says it has already been resolved.
  if (resumo && !(projecao.runtimeRequests ?? []).some(p => p.id === resumo.id)) {
    pendentes.push(resumo);
  }
  return pendentes.map(p => resumirPedidoRuntime(projecao, p, thread.id));
}
