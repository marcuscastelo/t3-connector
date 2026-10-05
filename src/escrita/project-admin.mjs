import { z } from 'zod';

// Project administration over the native T3 project service (commit 8ed276c2):
// - WS `projects.mutate` with ProjectMutation `project.delete` {commandId, projectId, force?}
//   (packages/contracts/src/project.ts:192-213, rpc.ts:1154), scope orchestration:operate
//   (auth/RpcAuthorization.ts:36). It returns the Project, with deletedAt set.
// - ProjectService.deleteChildThreads (project/ProjectService.ts:454-487) refuses a project with
//   live threads (active or archived) unless force=true; with force it deletes each child thread
//   durably, then soft-deletes the project. The workspace directory on disk is not removed.
//
// Thread occupancy needs two reads: HTTP /api/orchestration/shell carries only active threads
// (orchestration-v2/http.ts:98, location "active"), and WS orchestration.getArchivedShellSnapshot
// carries the archived ones in `threads` (ws.ts:1847). Both carry snapshotSequence; a count is
// complete only when both reads observed the same sequence.
//
// Known backend limit, not fixable here: deleteChildThreads reads its snapshot outside the project
// lock, and thread.create (orchestration-v2/Orchestrator.ts:2028) neither checks the project nor
// takes that lock. A thread created by another client between that read and the project commit
// stays live, linked to a deleted project. The connector serializes its own project-scoped writes
// and checks for live threads after the delete, but it cannot exclude other clients.

export const PROJECT_ACTIONS = Object.freeze(['project.delete', 'project.delete-force']);
export const isProjectAction = action => PROJECT_ACTIONS.includes(action);

const id = z.string().trim().min(1).max(1024);
export const PROJECT_SCHEMAS = Object.freeze({
  'project.delete': z.object({ projectId: id }).strict(),
  'project.delete-force': z.object({
    projectId: id,
    force: z.literal(true, { error: 'force must be the literal true' }),
    confirmProjectId: id.describe('Repeat the exact projectId to confirm which project is deleted with its threads.'),
    expectedThreadCount: z.number().int().min(1).describe('Total from t3_contar_threads_projeto right before this call; the delete is refused if the live count differs.'),
  }).strict(),
});

// Statuses of a run that is still doing or waiting for work (OrchestrationV2RunStatus).
const BUSY = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);

/** Pure count over an active shell snapshot and an archived shell snapshot. */
export function contarOcupacao(active, archived, projectId) {
  const sequence = active?.snapshotSequence;
  if (!Number.isInteger(sequence) || sequence !== archived?.snapshotSequence || !Array.isArray(active?.threads) || !Array.isArray(archived?.threads)) {
    return { projectId, complete: false, total: null };
  }
  const seen = new Map();
  for (const [where, list] of [['active', active.threads], ['active', active.archivedThreads ?? []], ['archived', archived.threads]]) {
    for (const t of list) {
      if (t?.projectId !== projectId || t.deletedAt) continue;
      const kind = t.archivedAt ? 'archived' : where;
      if (!seen.has(t.id)) seen.set(t.id, { kind, t });
      else if (kind === 'archived') seen.get(t.id).kind = 'archived';
    }
  }
  const rows = [...seen.values()];
  return {
    projectId, complete: true, sequence,
    total: rows.length,
    active: rows.filter(r => r.kind === 'active').length,
    archived: rows.filter(r => r.kind === 'archived').length,
    withoutRun: rows.filter(r => !r.t.latestRunId).length,
    busy: rows.filter(r => BUSY.has(r.t.status) || r.t.pendingRuntimeRequest).length,
  };
}

/** Reads both snapshots until they agree on the sequence; otherwise reports an incomplete count. */
export async function lerOcupacao({ readActive, readArchived, projectId, attempts = 3 }) {
  for (let i = 0; i < attempts; i++) {
    const [active, archived] = await Promise.all([readActive(), readArchived()]);
    const count = contarOcupacao(active, archived, projectId);
    if (count.complete) return count;
  }
  return { projectId, complete: false, total: null };
}

/** Refusals before sending, from a fresh count. Never escalates a refusal into force. */
export function guardProjectDelete(action, input, count) {
  if (!count?.complete) throw new Error('project_count_incomplete');
  if (action === 'project.delete') {
    if (count.total !== 0) throw new Error('project_not_empty');
    return;
  }
  if (input.confirmProjectId !== input.projectId) throw new Error('project_confirmation_mismatch');
  if (count.total !== input.expectedThreadCount) throw new Error('project_count_changed');
  if (count.busy > 0) throw new Error('project_has_active_work');
}

// In-process serialization of this connector's own project-scoped writes (delete, launch, fork),
// keyed by environment and project. It does not cover other T3 clients.
const locks = new Map();
export async function lockProject(key) {
  const previous = locks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise(r => { release = r; });
  const tail = previous.then(() => current);
  locks.set(key, tail);
  await previous;
  return () => { release(); if (locks.get(key) === tail) locks.delete(key); };
}
