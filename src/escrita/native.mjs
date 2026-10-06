import { z } from 'zod';
import { itemUnico } from '../linhas.mjs';

// Thin wrappers over native T3 MCP tools (T3 8ed276c2, apps/server/src/mcp/toolkits/**), reached
// remotely over the public RPCs the same services use. Native names, arguments and result shapes
// are kept; T3 validates the semantics and its typed errors are returned as they come (NativeRpcError).
// Remote differences, documented per tool:
// - the native "calling thread/project" becomes an explicit `threadId` or `projectId` argument;
// - native caller guards (live full-access/default thread) become the OAuth consent;
// - writes go through the connector's journal (operationId); where T3 accepts a commandId, it is
//   derived from the operation, so a replayed operation reuses it.
// The inventory behind this list: _entregas/t3-connector-oauth-e2e/INVENTARIO-MCP-NATIVO.md.

/** A refusal with a native OrchestratorMcpFailure code, decided before anything is sent. */
export class NativeToolError extends Error {
  constructor(code, message) { super(code); this.native = { code, message }; }
}
/** A typed failure answered by T3 (Effect RPC Exit Failure with a tagged error). */
export class NativeRpcError extends Error {
  constructor(tag, message, fields = {}) { super('t3_error'); this.native = { code: tag, message, ...fields }; }
}

// Projeto pelo ID no catálogo nativo: linhas repetidas e divergentes não são escolhidas pela
// ordem (o cwd de vcs e o workspace sairiam da primeira); viram erro (revisão R6, P1).
function projetoUnico(projects, projectId, vivo = false) {
  const { item, conflito } = itemUnico(projects, (p) => p.id === projectId);
  if (conflito) throw new NativeToolError('project_conflict', 'The project has conflicting rows in T3.');
  return item && (!vivo || item.deletedAt === null) ? item : undefined;
}

const str = z.string().trim().min(1);
const id = str.max(1024);
const model = z.object({ instanceId: str, model: str, options: z.array(z.object({ id: str, value: z.union([z.string(), z.boolean()]) }).strict()).optional() }).strict();
const script = z.object({ id: str, name: str, command: str, icon: z.enum(['play', 'test', 'lint', 'configure', 'build', 'debug']), runOnWorktreeCreate: z.boolean(), async: z.boolean().optional(), previewUrl: str.optional(), autoOpenPreview: z.boolean().optional() }).strict();
const intervalSchedule = z.object({ type: z.literal('interval'), everyMs: z.number().int().min(60000) }).strict();
const fixedSchedule = z.object({ type: z.literal('fixed_time'), timeOfDay: z.string().regex(/^([01]?\d|2[0-3]):([0-5]\d)$/), weekdays: z.array(z.number().int().min(0).max(6)).optional() }).strict();
// The native tool also accepts the schedule as JSON text (compatibility); decoded the same way.
const schedule = z.preprocess(v => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } }, z.discriminatedUnion('type', [intervalSchedule, fixedSchedule]));
const threadContext = id.describe('Remote stand-in for the native calling thread: the thread whose context this call uses (same environment).');
const projectContext = id.describe('Remote stand-in for the native calling project (same environment).');

// ---- results ------------------------------------------------------------------------------------
export function preferences(settings) {
  const { defaultThreadEnvMode, newWorktreesStartFromOrigin, enableProviderUpdateChecks, backgroundActivity, sourceControlWritingStyle } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return { defaultThreadEnvMode, newWorktreesStartFromOrigin, enableProviderUpdateChecks, backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: { ...sourceControlWritingStyle, customInstructions: characters.slice(0, 4000).join(''), truncated: characters.length > 4000 } };
}
export const scheduledTaskSummary = task => ({ scheduledTaskId: task.id, title: task.title, prompt: task.prompt, enabled: task.enabled, projectId: task.projectId, boundThreadId: task.threadId, schedule: task.schedule, nextRunAt: task.nextRunAt, lastRunStatus: task.lastRunStatus });
export const scheduledTaskWorkspaceStrategy = bound => bound ? { type: 'root' } : { type: 'worktree', baseRef: 'main', startFromOrigin: true };
// QueuedRunOrder.ts queuedRunsInDeliveryOrder and thread/handlers.ts queueEntry.
export function queuedRunsInDeliveryOrder(projection) {
  const automatic = new Set(projection.messages.filter(m => m.delegatedCompletion !== undefined).map(m => m.id));
  return projection.runs.filter(r => r.status === 'queued').toSorted((l, r) =>
    (Number(automatic.has(r.userMessageId)) - Number(automatic.has(l.userMessageId))) || ((l.queuePosition ?? l.ordinal) - (r.queuePosition ?? r.ordinal)) || (l.ordinal - r.ordinal));
}
export function queueEntry(projection, runId, limit) {
  const run = projection.runs.find(r => r.id === runId && r.status === 'queued');
  const message = projection.messages.find(m => m.id === run?.userMessageId);
  if (run === undefined || message === undefined) return undefined;
  const characters = Array.from(message.text);
  return { queuedRunId: run.id, text: characters.slice(0, limit).join(''), truncated: characters.length > limit };
}
const onlyProvided = (input, keys) => Object.fromEntries(keys.filter(k => input[k] !== undefined).map(k => [k, input[k]]));

async function scopedTask(native, projectId, scheduledTaskId, notFound) {
  const { tasks } = await native.rpc('scheduledTasks.list', {});
  const task = tasks.find(t => t.id === scheduledTaskId && t.projectId === projectId);
  if (!task) throw notFound();
  return task;
}
const taskNotFound = () => new NativeToolError('task_not_found', 'The scheduled task was not found in the calling project.');

// ---- writes (Dispatcher specs) -------------------------------------------------------------------
// envScoped: no project target (project create/clone, environment preferences).
export const NATIVE_WRITES = {
  t3_project_create: {
    envScoped: true,
    description: 'Register a project directory through the existing project service, or omit workspaceRoot to start a new project from its title in the app\'s projects folder (Git repository with a README and first commit; commitError says why a commit failed, the project exists either way). Paths are on the T3 host of the chosen environment.',
    schema: z.object({ title: str, workspaceRoot: str.optional(), createWorkspaceRootIfMissing: z.boolean().optional(), defaultModelSelection: model.nullable().optional(), scripts: z.array(script).optional() }).strict(),
    async build({ input, commandId }) {
      if (input.workspaceRoot === undefined) {
        if (input.scripts !== undefined || input.createWorkspaceRootIfMissing !== undefined || input.defaultModelSelection !== undefined)
          throw new NativeToolError('invalid_request', 'A project started from its title takes only a title; set scripts or defaultModelSelection afterwards with t3_project_update.');
        return { method: 'projects.createNew', payload: { name: input.title } };
      }
      return { method: 'projects.mutate', payload: { type: 'project.create', commandId, projectId: commandId, ...input } };
    },
    async result({ raw, method, native }) {
      if (method !== 'projects.createNew') return raw;
      const project = projetoUnico((await native.projects()).projects, raw.projectId);
      if (!project) throw new Error('project_lookup_failed');
      return { ...project, ...(raw.commitError === undefined ? {} : { commitError: raw.commitError }) };
    },
  },
  t3_project_update: {
    description: 'Update a project through the existing project service. Omitted fields are preserved; null clears nullable fields.',
    schema: z.object({ projectId: id, title: str.optional(), workspaceRoot: str.optional(), defaultModelSelection: model.nullable().optional(), autoPull: z.boolean().optional(), projectIcon: z.object({}).passthrough().nullable().optional(), faviconPath: str.max(1024).nullable().optional(), defaultThreadEnvMode: z.enum(['local', 'worktree']).nullable().optional(), scripts: z.array(script).optional() }).strict(),
    async build({ input, commandId }) { return { method: 'projects.mutate', payload: { type: 'project.update', commandId, ...input } }; },
  },
  t3_project_clone: {
    envScoped: true,
    description: 'Clone a repository to destinationPath on the T3 host of the chosen environment through the existing source-control service. Does not register a project.',
    schema: z.object({ provider: z.enum(['github', 'gitlab', 'forgejo', 'azure-devops', 'bitbucket', 'unknown']).optional(), repository: str.optional(), remoteUrl: str.optional(), destinationPath: str, protocol: z.enum(['auto', 'ssh', 'https']).optional() }).strict(),
    async build({ input }) { return { method: 'sourceControl.cloneRepository', payload: input }; },
  },
  t3_environment_preferences_update: {
    envScoped: true,
    description: 'Update selected environment-wide preferences through normal settings persistence and notifications. Omitted fields are preserved; empty customInstructions clears them.',
    schema: z.object({ defaultThreadEnvMode: z.enum(['local', 'worktree']).optional(), newWorktreesStartFromOrigin: z.boolean().optional(), enableProviderUpdateChecks: z.boolean().optional(), backgroundActivity: z.object({ profile: z.enum(['balanced', 'performance', 'battery-saver']) }).strict().optional(), sourceControlWritingStyle: z.object({ mode: z.enum(['repo_conventions', 'conventional_commits', 'custom']).optional(), followChangeRequestTemplates: z.boolean().optional(), customInstructions: z.string().optional() }).strict().optional() }).strict(),
    async build({ input }) { return { method: 'server.updateSettings', payload: { patch: onlyProvided(input, ['defaultThreadEnvMode', 'newWorktreesStartFromOrigin', 'enableProviderUpdateChecks', 'backgroundActivity', 'sourceControlWritingStyle']) } }; },
    async result({ raw }) { return preferences(raw); },
  },
  schedule_task: {
    refs: ['threadId'],
    description: 'Create a scheduled task in the project of threadId (the native calling thread) through the existing scheduler. It inherits that thread\'s model and modes. bindToCurrentThread (default true) posts runs into threadId; false launches a fresh worktree from main per run. fixed_time is the T3 server\'s local wall clock.',
    schema: z.object({ threadId: threadContext, prompt: str.max(120000), schedule, title: str.max(512).optional(), enabled: z.boolean().optional(), bindToCurrentThread: z.boolean().optional(), clientRequestId: str.max(256).optional() }).strict(),
    async build({ input, native, commandId }) {
      const { projection: { thread } } = await native.thread(input.threadId);
      const bound = input.bindToCurrentThread ?? true;
      const derived = input.prompt.split('\n')[0]?.trim() ?? '';
      return { method: 'scheduledTasks.upsert', payload: {
        title: input.title ?? (derived.length > 0 ? derived.slice(0, 80) : 'Scheduled task'), prompt: input.prompt, enabled: input.enabled ?? true, schedule: input.schedule,
        projectId: thread.projectId, threadId: bound ? thread.id : null, workspaceStrategy: scheduledTaskWorkspaceStrategy(bound),
        modelSelection: thread.modelSelection, runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode, createdBy: 'agent', creationSource: 'mcp', commandId } };
    },
    async result({ raw }) { return scheduledTaskSummary(raw.task); },
  },
  update_scheduled_task: {
    description: 'Update a scheduled task of projectId (the native calling project): read, merge the provided fields, and save through the existing scheduler. bindToCurrentThread true binds it to threadId; false unbinds it (fresh worktree from main per run).',
    schema: z.object({ projectId: projectContext, scheduledTaskId: id, prompt: str.max(120000).optional(), title: str.max(512).optional(), schedule: schedule.optional(), enabled: z.boolean().optional(), bindToCurrentThread: z.boolean().optional(), threadId: threadContext.optional() }).strict(),
    async build({ input, native }) {
      if (input.bindToCurrentThread === true && !input.threadId) throw new NativeToolError('invalid_request', 'bindToCurrentThread true needs threadId (the thread to bind).');
      const existing = await scopedTask(native, input.projectId, input.scheduledTaskId, taskNotFound);
      if (input.bindToCurrentThread === true) {
        const { projection: { thread } } = await native.thread(input.threadId);
        if (thread.projectId !== existing.projectId) throw new NativeToolError('invalid_request', 'threadId belongs to another project.');
      }
      return { method: 'scheduledTasks.upsert', payload: {
        id: existing.id, title: input.title ?? existing.title, prompt: input.prompt ?? existing.prompt, enabled: input.enabled ?? existing.enabled, schedule: input.schedule ?? existing.schedule,
        projectId: existing.projectId,
        threadId: input.bindToCurrentThread === undefined ? existing.threadId : input.bindToCurrentThread ? input.threadId : null,
        workspaceStrategy: input.bindToCurrentThread === undefined ? existing.workspaceStrategy : scheduledTaskWorkspaceStrategy(input.bindToCurrentThread),
        modelSelection: existing.modelSelection, runtimeMode: existing.runtimeMode, interactionMode: existing.interactionMode, createdBy: existing.createdBy, creationSource: existing.creationSource } };
    },
    async result({ raw }) { return scheduledTaskSummary(raw.task); },
  },
  delete_scheduled_task: {
    description: 'Delete a scheduled task of projectId (the native calling project) through the existing scheduler.',
    schema: z.object({ projectId: projectContext, scheduledTaskId: id }).strict(),
    async build({ input, native }) { const existing = await scopedTask(native, input.projectId, input.scheduledTaskId, taskNotFound); return { method: 'scheduledTasks.delete', payload: { id: existing.id } }; },
    async result({ payload }) { return { scheduledTaskId: payload.id, deleted: true }; },
  },
  run_scheduled_task_now: {
    description: 'Run a scheduled task of projectId (the native calling project) now through the existing scheduler. Each call is a new manual run; completion means dispatch/bookkeeping completed, not that the provider turn finished.',
    schema: z.object({ projectId: projectContext, taskId: id }).strict(),
    async build({ input, native }) { await scopedTask(native, input.projectId, input.taskId, () => new NativeToolError('invalid_request', 'The task was not found in the calling project.')); return { method: 'scheduledTasks.runNow', payload: { id: input.taskId } }; },
    async result({ raw: { task } }) { return { taskId: task.id, threadId: task.threadId, lastRunStatus: task.lastRunStatus, runCount: task.runCount, nextRunAt: task.nextRunAt }; },
  },
};
export const NATIVE_WRITE_ACTIONS = Object.freeze(Object.keys(NATIVE_WRITES));
export const ENV_SCOPED = new Set(NATIVE_WRITE_ACTIONS.filter(a => NATIVE_WRITES[a].envScoped));

// ---- reads ----------------------------------------------------------------------------------------
// `authorize` receives the project IDs a read touches; it refuses projects outside the live grant.
const projection = async (native, authorize, threadId) => {
  const { projection: p } = await native.thread(threadId);
  await authorize([p.thread.projectId]);
  return p;
};
export const NATIVE_READS = {
  t3_environment_read: {
    description: "Read this server's identity and selected environment preferences. Writing instructions are limited to 4,000 characters.",
    schema: z.object({}).strict(),
    async run({ native }) {
      const [d, settings] = await Promise.all([native.environment(), native.rpc('server.getSettings', {})]);
      return { environmentId: d.environmentId, label: d.label, serverVersion: d.serverVersion, platform: d.platform, preferences: preferences(settings) };
    },
  },
  t3_project_read: {
    description: 'Read one registered project by ID (full Project).',
    schema: z.object({ projectId: id }).strict(),
    async run({ input, native, authorize }) {
      const project = projetoUnico((await native.projects()).projects, input.projectId, true);
      if (!project) throw new NativeToolError('invalid_request', 'The project was not found.');
      await authorize([project.id]);
      return project;
    },
  },
  t3_thread_configuration: {
    description: 'Read the model selection, runtime mode and interaction mode of threadId.',
    schema: z.object({ threadId: id }).strict(),
    async run({ input, native, authorize }) { const { thread } = await projection(native, authorize, input.threadId); return { threadId: thread.id, modelSelection: thread.modelSelection, runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode }; },
  },
  t3_thread_transfers: {
    description: 'List the context transfers of threadId.',
    schema: z.object({ threadId: id }).strict(),
    async run({ input, native, authorize }) { const p = await projection(native, authorize, input.threadId); return { transfers: p.contextTransfers.map(({ id, sourceThreadId, targetThreadId, status }) => ({ id, sourceThreadId, targetThreadId, status })) }; },
  },
  t3_queue_list: {
    description: 'List queued messages of threadId in delivery order, with text up to 1000 characters.',
    schema: z.object({ threadId: id, cursor: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    async run({ input, native, authorize }) {
      const p = await projection(native, authorize, input.threadId);
      const runs = queuedRunsInDeliveryOrder(p), cursor = input.cursor ?? 0, end = cursor + (input.limit ?? 20);
      return { items: runs.slice(cursor, end).flatMap(r => { const e = queueEntry(p, r.id, 1000); return e === undefined ? [] : [e]; }), nextCursor: end < runs.length ? end : null };
    },
  },
  t3_queue_read: {
    description: 'Read one queued message of threadId, with text up to 16000 characters.',
    schema: z.object({ threadId: id, queuedRunId: id }).strict(),
    async run({ input, native, authorize }) {
      const entry = queueEntry(await projection(native, authorize, input.threadId), input.queuedRunId, 16000);
      if (!entry) throw new NativeToolError('invalid_request', 'The queued message was not found.');
      return entry;
    },
  },
  t3_thread_search: {
    description: "Search active thread titles and content with the app's existing bounded search. With projectId, returns only that project's matches from the global top matches, so it may return fewer than limit. No pagination or exhaustive-result guarantee.",
    schema: z.object({ query: z.string().trim().min(2).max(200), limit: z.number().int().min(1).max(50).optional(), projectId: id.optional() }).strict(),
    async run({ input, native, authorize }) {
      const result = await native.rpc('orchestration.searchThreads', { query: input.query, ...(input.limit === undefined ? {} : { limit: input.limit }) });
      const matches = input.projectId === undefined ? result.matches : result.matches.filter(m => m.projectId === input.projectId);
      await authorize([...new Set(matches.map(m => m.projectId))]);
      return { matches };
    },
  },
  t3_worktree_status: {
    description: 'Report whether threadId is attached to a worktree, its branch, the project workspace root, and the environment default for starting new worktrees from origin.',
    schema: z.object({ threadId: id }).strict(),
    async run({ input, native, authorize }) {
      const { thread } = await projection(native, authorize, input.threadId);
      const [projects, settings] = await Promise.all([native.projects(), native.rpc('server.getSettings', {})]);
      const project = projetoUnico(projects.projects, thread.projectId);
      if (!project) throw new NativeToolError('project_not_found', 'The project was not found.');
      return { attached: thread.worktreePath !== null, worktreePath: thread.worktreePath, branch: thread.branch, projectWorkspaceRoot: project.workspaceRoot, defaultStartFromOrigin: settings.newWorktreesStartFromOrigin };
    },
  },
  t3_worktree_list: {
    description: "List branches/refs (with their worktree paths) of threadId's checkout: its worktree if attached, else the project root.",
    schema: z.object({ threadId: id, query: z.string().trim().min(1).max(256).optional(), cursor: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional(), refKind: z.enum(['all', 'local', 'remote']).optional(), includeMatchingRemoteRefs: z.boolean().optional() }).strict(),
    async run({ input, native, authorize }) {
      const { thread } = await projection(native, authorize, input.threadId);
      const project = projetoUnico((await native.projects()).projects, thread.projectId, true);
      if (!project) throw new NativeToolError('invalid_request', 'The project was not found.');
      const { threadId, ...rest } = input;
      return native.rpc('vcs.listRefs', { ...rest, cwd: thread.worktreePath ?? project.workspaceRoot });
    },
  },
  list_scheduled_tasks: {
    description: 'List the scheduled tasks of projectId (the native calling project).',
    schema: z.object({ projectId: projectContext }).strict(),
    async run({ input, native, authorize }) {
      await authorize([input.projectId]);
      const { tasks } = await native.rpc('scheduledTasks.list', {});
      return { tasks: tasks.filter(t => t.projectId === input.projectId).map(scheduledTaskSummary) };
    },
  },
};
export const NATIVE_READ_TOOLS = Object.freeze(Object.keys(NATIVE_READS));

// Native tools consciously not wrapped, with the reason (see the inventory for the full table).
export const NATIVE_OMITTED = Object.freeze({
  t3_attachment_prepare_upload: 'the bytes go to the T3 server origin, which a remote MCP client cannot reach through the connector',
  t3_attachment_discard: 'only meaningful with t3_attachment_prepare_upload',
  t3_thread_send_attachments: 'needs uploaded attachments (see t3_attachment_prepare_upload)',
  t3_thread_read: 'the timeline view, positions and textOffset are server-side projections; a remote copy would be a reimplementation, not a thin wrapper',
  list_thread_pull_requests: 'the PR entries and chains are computed by a server-side helper; not a thin wrapper',
  t3_thread_update: 'rename/regenerate are covered by thread.metadata.update; the legacy linkedPullRequest branch returns a result WS cannot provide atomically',
  t3_thread_launch: 'covered by t3_escrever_thread_launch (scratch and caller modes are not offered remotely)',
  t3_project_delete: 'covered by the opt-in project administration (t3_escrever_project_delete[_force])',
});
