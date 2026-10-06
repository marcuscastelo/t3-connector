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

const objeto = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const texto = (x) => typeof x === 'string' && x.trim().length > 0;
const idDe = (x) => x?.nativeItemRef?.nativeId ?? x?.nativeTaskRef?.nativeId ?? x?.id;

/** Lista de problemas (vazia = bem formada). `campos` ausentes são aceitos; presentes, validados. */
export function problemasDaProjecao(p) {
  if (!objeto(p)) return ['projection_missing'];
  const problemas = [];
  const lista = (nome, validar) => {
    const v = p[nome];
    if (v === undefined) return;
    if (!Array.isArray(v)) { problemas.push(`${nome}_not_a_list`); return; }
    const ids = new Set();
    for (const x of v) {
      const motivo = objeto(x) ? validar(x) : 'not_an_object';
      if (motivo) { problemas.push(`${nome}_${motivo}`); return; }
      const id = idDe(x);
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
    if (pt.pendingBackgroundTasks === undefined || pt.pendingBackgroundTasks === null) return null;
    if (!Array.isArray(pt.pendingBackgroundTasks)) return 'roster_not_a_list';
    return pt.pendingBackgroundTasks.every((t) => objeto(t) && texto(t.taskId)) ? null : 'roster_task_invalid';
  });
  if (p.turnItems !== undefined && !Array.isArray(p.turnItems)) problemas.push('turnItems_not_a_list');
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
