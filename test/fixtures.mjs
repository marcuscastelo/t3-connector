// Fixtures fiéis ao contrato V2 (packages/contracts/src/orchestrationV2.ts no commit 8ed276c2):
// OrchestrationV2ThreadShell, OrchestrationV2RuntimeRequest e mensagens do /bounded.
// Campos ausentes aqui são opcionais ou irrelevantes para o estado.
// Snooze, visita e override vêm como o nightly 3e6b4502 emite (sempre presentes, null sem
// valor; ProjectionStore.ts:1418-1427); servidor antigo se simula apagando a chave.

export const PROJETO_OK = 'proj-ok';
export const PROJETO_FORA = 'proj-fora';

export function thread(campos = {}) {
  return {
    id: 'thread-1',
    projectId: PROJETO_OK,
    title: 'Thread de teste',
    providerInstanceId: 'codex',
    modelSelection: { instanceId: 'codex', model: 'gpt-6.1-sol', options: [{ id: 'reasoningEffort', value: 'high' }] },
    runtimeMode: 'full-access',
    interactionMode: 'default',
    branch: null,
    worktreePath: null,
    latestRunId: 'run-1',
    latestRunCompletedAt: null,
    activeRunId: null,
    activityRunStatus: null,
    status: 'completed',
    lastError: null,
    lastErrorClass: null,
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    limitRecovery: null,
    createdAt: '2026-10-03T10:00:00.000Z',
    updatedAt: '2026-10-03T10:05:00.000Z',
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...campos,
  };
}

export function pedido(campos = {}) {
  return {
    id: 'req-1',
    nodeId: 'node-approval-1',
    providerTurnId: 'turn-1',
    nativeRequestRef: { driver: 'codex', nativeId: 'n-1', strength: 'strong' },
    kind: 'command',
    status: 'pending',
    responseCapability: { type: 'live', providerSessionId: 'ps-1' },
    createdAt: '2026-10-03T10:04:00.000Z',
    resolvedAt: null,
    ...campos,
  };
}

export function projecao({ pedidos = [], mensagens = [], turnItems = [], runs = [] } = {}) {
  return {
    thread: {},
    runs,
    runtimeRequests: pedidos,
    turnItems,
    providerSessions: [{ id: 'ps-1', status: 'ready', cwd: '/repo/ok', model: 'gpt-6.1-sol' }],
    messages: mensagens,
  };
}

export function mensagem(campos = {}) {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    runId: 'run-1',
    nodeId: 'node-1',
    role: 'assistant',
    text: 'Pronto.',
    attachments: [],
    streaming: false,
    createdAt: '2026-10-03T10:05:00.000Z',
    updatedAt: '2026-10-03T10:05:00.000Z',
    ...campos,
  };
}
