// Control-plane/BFS v1 (docs/design/control-plane-v1.md): operações semânticas versionadas
// por `controlPlaneContractVersion`. Este módulo só coordena leituras e projeta contratos;
// trabalho em curso vem de execution (src/execucao.mjs), filas do workset, aceite do
// settlement e escrita do Dispatcher/journal. Nenhum estado próprio de thread.

export const CONTROL_PLANE_CONTRACT_VERSION = 1;

export const REVISAO_MAX_ITENS = 20;

/**
 * Pacote de revisão (control-plane v1, §6.2) de UMA observação validada: run esperado do
 * settlement, resposta atribuída a esse run no MESMO snapshot, workspace, PRs, filhas vistas em
 * execution e refs de evidência. Fatos, não aceite: `verification.status` é sempre
 * `caller_required`. Pura.
 */
export function montarRevisao({ environmentId, thread, projecao, settlement, execution, maxCaracteres }) {
  if (!thread || !settlement?.complete) {
    return { complete: false, observationId: null, reasons: [{ code: 'observation_incomplete', source: 'settlement' }], verification: { status: 'caller_required' } };
  }
  const reasons = [];
  const runId = settlement.expectedRunId;
  const run = (projecao.runs ?? []).find((x) => x.id === runId) ?? null;
  const mensagens = projecao.messages ?? [];
  let doRun = null;
  for (let i = mensagens.length - 1; i >= 0; i--) {
    const m = mensagens[i];
    if (m.role === 'assistant' && m.text && runId && m.runId === runId) { doRun = m; break; }
  }
  let response = null;
  let olderResponse = null;
  if (doRun) {
    const truncated = doRun.text.length > maxCaracteres;
    response = {
      messageId: doRun.id, runId: doRun.runId,
      relation: execution?.runs?.latestExecuted?.runId === doRun.runId ? 'latest_executed_run' : 'expected_run',
      createdAt: doRun.createdAt ?? null, updatedAt: doRun.updatedAt ?? null,
      streaming: Boolean(doRun.streaming), text: truncated ? doRun.text.slice(0, maxCaracteres) : doRun.text, truncated,
    };
    if (truncated) reasons.push({ code: 'review_response_truncated', source: 'connector' });
    if (response.streaming) reasons.push({ code: 'review_response_streaming', source: 'snapshot' });
  } else {
    reasons.push({ code: 'review_response_missing_or_stale', source: 'snapshot' });
    if (execution?.latestResponse) olderResponse = { ...execution.latestResponse, informational: true };
  }
  if (!run && runId) reasons.push({ code: 'review_run_missing', source: 'snapshot' });
  const filhas = [];
  for (const [estado, lista] of [['pending', execution?.background?.pending ?? []], ['ended', execution?.background?.endedSinceLatestRun ?? []]]) {
    for (const t of lista) if (t.childThreadId) filhas.push({ environmentId, threadId: t.childThreadId, taskId: t.taskId, state: estado, source: 'execution.background' });
  }
  const evidencia = [
    ...(doRun ? [{ kind: 'assistant_message', ref: { environmentId, threadId: thread.id, messageId: doRun.id }, runId: doRun.runId }] : []),
    ...(settlement.linkedPullRequests ?? []).map((p) => ({ kind: 'pull_request', ref: { url: p.url, number: p.number, state: p.state } })),
    ...filhas.map((f) => ({ kind: 'related_thread', ref: { environmentId: f.environmentId, threadId: f.threadId } })),
  ];
  const corte = (l) => ({ itens: l.slice(0, REVISAO_MAX_ITENS), truncado: l.length > REVISAO_MAX_ITENS });
  const rel = corte(filhas);
  const ev = corte(evidencia);
  return {
    complete: Boolean(doRun) && !response.truncated && !response.streaming && Boolean(run || !runId),
    observationId: settlement.observationId,
    run: run ? { runId: run.id, ordinal: run.ordinal ?? null, status: run.status } : null,
    response,
    ...(olderResponse ? { olderResponse } : {}),
    workspace: { projectId: thread.projectId, worktreePath: thread.worktreePath ?? null, branch: thread.branch ?? null, source: 'snapshot_metadata' },
    linkedPullRequests: settlement.linkedPullRequests ?? [],
    pullRequestsAvailable: settlement.fieldAvailability?.pullRequests ?? false,
    relatedThreads: rel.itens,
    ...(rel.truncado ? { relatedThreadsTruncated: true } : {}),
    availableEvidence: ev.itens,
    ...(ev.truncado ? { availableEvidenceTruncated: true } : {}),
    blockers: settlement.blockers,
    verification: { status: 'caller_required' },
    reasons,
  };
}
