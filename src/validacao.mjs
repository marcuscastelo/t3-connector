// Fronteira de validação da projeção de uma thread contra o contrato V2 (reference/
// packages_contracts_src_orchestrationV2.ts, commit 8ed276c2). Toda decisão (ociosidade,
// continuação, settle, despacho, espera) deriva de `execution`; se a projeção que a sustenta
// não é bem formada, `derivarExecucao` acrescenta o bloqueio canônico
// `execution_evidence_invalid` e nada é provado a partir dela. Uma regra num lugar só, em vez
// de cada consumidor descartar em silêncio o que não reconhece (revisões R1–R5).

const RUN = new Set(['preparing', 'queued', 'starting', 'running', 'waiting', 'completed', 'interrupted', 'failed', 'cancelled', 'rolled_back']);
const PEDIDO = new Set(['pending', 'resolved', 'expired', 'cancelled']);
const TRABALHO = new Set(['idle', 'pending', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted']);
const PLANO_KIND = new Set(['proposed_plan', 'todo_list']);
const PLANO_STATUS = new Set(['draft', 'active', 'completed', 'superseded']);
const STATUS_THREAD = new Set(['idle', ...RUN]);
// Os 26 tipos de OrchestrationV2TurnItem (orchestrationV2.ts:1246-1444). Item de tipo
// desconhecido pode ser trabalho que o conector não sabe ler; nunca vira "nada em curso".
const TIPO_ITEM = new Set(['approval_request', 'assistant_message', 'checkpoint', 'command_execution', 'compaction', 'dynamic_tool', 'error', 'file_change', 'file_search', 'fork', 'handoff', 'node', 'notification', 'proposed_plan', 'provider_thread', 'reasoning', 'run', 'run_interrupt_request', 'run_interrupt_result', 'subagent', 'system_notice', 'thread_created', 'todo_list', 'user_input_request', 'user_message', 'web_search']);
// Coleções de que a ociosidade depende: o contrato as exige (OrchestrationV2ThreadProjection),
// e a ausência de uma delas não prova ausência de run, pedido ou trabalho (revisão R6, P1).
const OBRIGATORIAS = ['runs', 'runtimeRequests', 'turnItems', 'subagents', 'plans'];

const objeto = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const texto = (x) => typeof x === 'string' && x.trim().length > 0;
const idDe = (x) => x?.nativeItemRef?.nativeId ?? x?.nativeTaskRef?.nativeId ?? x?.id;

/** Lista de problemas (vazia = bem formada). Fora de `OBRIGATORIAS`, coleção ausente é aceita; presente, validada. */
export function problemasDaProjecao(p) {
  if (!objeto(p)) return ['projection_missing'];
  const problemas = [];
  const lista = (nome, validar, chave = idDe) => {
    const v = p[nome];
    if (v === undefined) { if (OBRIGATORIAS.includes(nome)) problemas.push(`${nome}_missing`); return; }
    if (!Array.isArray(v)) { problemas.push(`${nome}_not_a_list`); return; }
    const ids = new Set();
    for (const x of v) {
      const motivo = objeto(x) ? validar(x) : 'not_an_object';
      if (motivo) { problemas.push(`${nome}_${motivo}`); return; }
      const id = chave(x);
      if (ids.has(id)) { problemas.push(`${nome}_duplicate_id`); return; }
      ids.add(id);
    }
  };
  lista('runs', (r) => (!texto(r.id) ? 'id_invalid' : !RUN.has(r.status) ? 'status_unknown' : r.ordinal !== undefined && !(Number.isInteger(r.ordinal) && r.ordinal > 0) ? 'ordinal_invalid' : null));
  lista('runtimeRequests', (q) => (!texto(q.id) ? 'id_invalid' : !PEDIDO.has(q.status) ? 'status_unknown' : null));
  lista('subagents', (s) => (!texto(idDe(s)) ? 'id_invalid' : !TRABALHO.has(s.status) ? 'status_unknown' : null));
  lista('plans', (x) => (!texto(x.id) ? 'id_invalid' : !PLANO_KIND.has(x.kind) ? 'kind_unknown' : !PLANO_STATUS.has(x.status) ? 'status_unknown' : null));
  lista('providerThreads', (pt) => {
    if (!texto(pt.id)) return 'id_invalid';
    // Opcional (omitido = vazio, orchestrationV2.ts:812), nunca null.
    if (pt.pendingBackgroundTasks === undefined) return null;
    if (!Array.isArray(pt.pendingBackgroundTasks)) return 'roster_not_a_list';
    return pt.pendingBackgroundTasks.every((t) => objeto(t) && texto(t.taskId)) ? null : 'roster_task_invalid';
  });
  lista('turnItems', (i) => (!texto(i.id) ? 'id_invalid' : !TIPO_ITEM.has(i.type) ? 'type_unknown' : !TRABALHO.has(i.status) ? 'status_unknown' : null), (i) => i.id);
  if (p.messages !== undefined && !Array.isArray(p.messages)) problemas.push('messages_not_a_list');
  // Binding do provider: com roster presente, o provider thread ativo tem de estar nele; a
  // coleção sem ele não cobre o trabalho do provider vinculado (revisão R5, P1).
  const ativo = p.thread?.activeProviderThreadId;
  if (ativo != null) {
    if (!texto(ativo)) problemas.push('active_provider_thread_invalid');
    else if (Array.isArray(p.providerThreads) && !p.providerThreads.some((pt) => pt?.id === ativo)) problemas.push('active_provider_thread_missing');
  }
  return problemas;
}

const objetoOuNulo = (x) => x === null || objeto(x);

/**
 * Linha da shell do alvo (OrchestrationV2ThreadShell, orchestrationV2.ts:1663-1720) nos campos
 * que decidem bloqueios. Os obrigatórios do contrato têm de estar presentes: a ausência de
 * `hasActionableProposedPlan`, `pendingRuntimeRequest` ou `activeRunId` não prova "nada"
 * (revisão R7, P1); o roster é opcional mas nunca null.
 */
export function problemasDaLinha(thread) {
  if (!objeto(thread)) return ['shell_row_invalid'];
  const problemas = [];
  if (!STATUS_THREAD.has(thread.status)) problemas.push('thread_status_unknown');
  const pedido = thread.pendingRuntimeRequest;
  if (!(pedido === null || (objeto(pedido) && texto(pedido.id)))) problemas.push('shell_pending_request_invalid');
  if (thread.limitRecovery !== undefined && !objetoOuNulo(thread.limitRecovery)) problemas.push('shell_limit_recovery_invalid');
  const roster = thread.pendingBackgroundTasks;
  if (roster !== undefined && !(Array.isArray(roster) && roster.every((t) => objeto(t) && texto(t.taskId)))) problemas.push('shell_background_roster_invalid');
  if (typeof thread.hasActionableProposedPlan !== 'boolean') problemas.push('shell_plan_flag_invalid');
  if (!(thread.activeRunId === null || texto(thread.activeRunId))) problemas.push('shell_active_run_invalid');
  return problemas;
}

/**
 * A leitura que sustenta uma derivação: a projeção é do alvo, a sequência do snapshot é a do
 * contrato (NonNegativeInt) e a linha da shell, se houver, é do alvo e está no contrato. Em
 * `derivarExecucao`, para que nenhum consumidor (espera, fallback, settlement, t3_thread)
 * dependa de lembrar cada conferência (revisão R7, P1).
 */
export function problemasDaLeitura({ projecao, shellThread, threadId, fonte = {} }) {
  const problemas = [];
  if (threadId !== undefined && projecao?.thread?.id !== threadId) problemas.push('snapshot_of_another_thread');
  if ('threadSequence' in fonte && !(Number.isInteger(fonte.threadSequence) && fonte.threadSequence >= 0)) problemas.push('snapshot_sequence_invalid');
  if (shellThread) {
    if (threadId !== undefined && shellThread.id !== threadId) problemas.push('shell_row_of_another_thread');
    problemas.push(...problemasDaLinha(shellThread));
  }
  return problemas;
}
