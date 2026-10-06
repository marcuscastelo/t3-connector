import { z } from 'zod';
import { createHash } from 'node:crypto';

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
// and checks for live threads after the delete, but it cannot exclude other clients. Likewise a
// thread created by another client after the connector's last read and before T3's own read is
// deleted by a force cascade although no count included it. See docs/oauth-session.md.

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
    expectedThreadsDigest: z.string().regex(/^[0-9a-f]{64}$/, 'expectedThreadsDigest must be the threadsDigest from t3_contar_threads_projeto').describe('threadsDigest from the same t3_contar_threads_projeto call; the delete is refused if the set of threads changed, even with the same total.'),
  }).strict(),
});

// Shell thread statuses (OrchestrationV2ShellThreadStatus) with no work in progress. Every other
// status (preparing, queued, starting, running, waiting, or one this connector does not know) is
// busy, as is an active run or a pending request: an unknown state never lets force cancel work.
const IDLE = new Set(['idle', 'completed', 'interrupted', 'failed', 'cancelled', 'rolled_back']);
const busy = t => !IDLE.has(t.status) || Boolean(t.activeRunId) || Boolean(t.activityRunStatus) || Boolean(t.pendingRuntimeRequest);

// Every row must carry what the count reads; one malformed row makes the whole count incomplete
// (a row that cannot be attributed could belong to the project).
const nullableString = v => v === null || v === undefined || typeof v === 'string';
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const validRow = t => isObject(t) && typeof t.id === 'string' && t.id !== '' && typeof t.projectId === 'string' && t.projectId !== ''
  && typeof t.status === 'string' && t.status !== '' && nullableString(t.latestRunId) && nullableString(t.activeRunId) && nullableString(t.activityRunStatus)
  && nullableString(t.archivedAt) && nullableString(t.deletedAt)
  && (t.pendingRuntimeRequest === null || t.pendingRuntimeRequest === undefined || isObject(t.pendingRuntimeRequest));
const validProject = p => isObject(p) && typeof p.id === 'string' && p.id !== '' && nullableString(p.deletedAt);

/** Digest of the exact set of live thread IDs: binds a force delete to the threads that were counted. */
export const threadsDigest = ids => createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex');

/**
 * Pure count over an active shell snapshot (with its projects) and an archived shell snapshot.
 * Fails closed: any malformed or inconsistent part makes it incomplete, never a zero.
 */
export function contarOcupacao(active, archived, projectId) {
  const sequence = active?.snapshotSequence;
  const incomplete = { projectId, complete: false, total: null };
  if (!Number.isInteger(sequence) || sequence < 0 || sequence !== archived?.snapshotSequence || !Array.isArray(active?.threads) || !Array.isArray(archived?.threads)) return incomplete;
  if (active.archivedThreads !== undefined && !Array.isArray(active.archivedThreads)) return incomplete;
  // The project itself is read from the same snapshot as its threads: the guard never deletes a
  // project the count did not see live.
  if (!Array.isArray(active.projects) || !active.projects.every(validProject)) return incomplete;
  if (![...active.threads, ...(active.archivedThreads ?? []), ...archived.threads].every(validRow)) return incomplete;
  const seen = new Map();
  for (const [where, list] of [['active', active.threads], ['active', active.archivedThreads ?? []], ['archived', archived.threads]]) {
    for (const t of list) {
      const prior = seen.get(t.id);
      // The same thread in two projects across the two reads cannot be attributed.
      if (prior && prior.t.projectId !== t.projectId) return incomplete;
      const kind = t.archivedAt ? 'archived' : where;
      // Live if any read shows it live; busy if any read shows it busy.
      if (!prior) seen.set(t.id, { kind, t, busy: busy(t), deleted: Boolean(t.deletedAt) });
      else { if (kind === 'archived') prior.kind = 'archived'; prior.busy ||= busy(t); prior.deleted &&= Boolean(t.deletedAt); }
    }
  }
  const rows = [...seen.values()].filter(r => r.t.projectId === projectId && !r.deleted);
  return {
    projectId, complete: true, sequence,
    projectLive: active.projects.some(p => p.id === projectId && !p.deletedAt),
    total: rows.length,
    active: rows.filter(r => r.kind === 'active').length,
    archived: rows.filter(r => r.kind === 'archived').length,
    withoutRun: rows.filter(r => !r.t.latestRunId).length,
    busy: rows.filter(r => r.busy).length,
    threadsDigest: threadsDigest(rows.map(r => r.t.id)),
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
  if (count.projectLive !== true) throw new Error('project_gone');
  if (action === 'project.delete') {
    if (count.total !== 0) throw new Error('project_not_empty');
    return;
  }
  if (input.confirmProjectId !== input.projectId) throw new Error('project_confirmation_mismatch');
  if (count.total !== input.expectedThreadCount) throw new Error('project_count_changed');
  if (count.threadsDigest !== input.expectedThreadsDigest) throw new Error('project_threads_changed');
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
