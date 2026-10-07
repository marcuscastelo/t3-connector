// Operator core: list, read, send, create, settle and snooze threads in any configured T3
// environment, with the operator's own paired token and no passkey lease.
//
// This is the non-interactive path for local automation on a machine that already holds an
// orchestration:operate token (CLI `t3-connector-ops`, or `import` from scripts). The MCP
// write plugin keeps its lease: a remote client never reaches this module.
//
// Every mutation carries a commandId derived from the caller's request id, so repeating a
// call does not repeat its effect, and is confirmed by reading the server afterwards.
//
// Config (T3_CONNECTOR_OPS_CONFIG, default ~/.config/t3-connector/ops.json), or the same
// object as JSON in T3_CONNECTOR_OPS_ENVIRONMENTS:
// {
//   "environments": {
//     "mac": { "url": "https://polaris.example.ts.net", "tokenFile": "~/…/tokens/mac",
//              "aliases": ["polaris"], "environmentId": "…" (optional; checked when present) },
//     "remote": { "ssh": { "host": "remote", "remotePort": 3773 }, "tokenFile": "…" }
//   }
// }

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { campoConfig, expandir, sshConfig } from './config.mjs';
import { criarCliente, validarUrl } from './t3.mjs';
import { criarTransporteSsh, criarTransporteUrl } from './transporte.mjs';
import { lerTokenPrivado } from './escrita/conexao.mjs';
import { StagingRpcTransport } from './escrita/transport-staging.mjs';
import { problemasModelSelection } from './escrita/model-selection.mjs';

export const OPS_CONFIG = '~/.config/t3-connector/ops.json';
export const OPS_SCOPES = Object.freeze(['orchestration:read', 'orchestration:operate']);
export const ACTIVE_STATUSES = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
export const DELIVERIES = Object.freeze(['queue_after_active', 'start_immediately']);
const RUNTIME_MODES = ['approval-required', 'auto-accept-edits', 'auto', 'full-access'];
// Option ids that carry reasoning effort, per provider driver (server.getConfig optionDescriptors).
const EFFORT_OPTIONS = ['effort', 'reasoningEffort'];

export class OpsError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}

/** Stable id for one request: the same parts give the same id. */
export const deriveId = (namespace, ...parts) => `${namespace}:${createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32)}`;

/** Stable UUID-shaped id (thread ids must look like the ones T3 creates). */
export function deriveUuid(...parts) {
  const h = createHash('sha256').update(parts.join('\n')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function validateOpsConfig(raw) {
  const fail = (m) => { throw new OpsError('config_invalid', `ops config: ${m}`); };
  const list = campoConfig(raw, 'environments', 'ambientes', fail);
  if (!list || typeof list !== 'object') fail('missing "environments" object');
  const envs = [];
  for (const [alias, e] of Object.entries(list)) {
    if (!/^[a-z0-9-]+$/.test(alias)) fail(`alias "${alias}" invalid (use a-z, 0-9, -)`);
    if (Boolean(e.url) === Boolean(e.ssh)) fail(`${alias}: give exactly one of "url" or "ssh"`);
    if (e.url) validarUrl(e.url);
    if (e.ssh && !e.ssh.host) fail(`${alias}: ssh.host required`);
    if (!e.tokenFile) fail(`${alias}: missing tokenFile`);
    const aliases = e.aliases ?? [];
    if (!Array.isArray(aliases) || aliases.some((a) => typeof a !== 'string' || !/^[a-z0-9-]+$/.test(a))) fail(`${alias}: aliases must be a list of names`);
    envs.push({ alias, aliases, environmentId: e.environmentId ?? null, url: e.url ?? null, ssh: sshConfig(e.ssh, fail, `${alias}: `), tokenFile: expandir(e.tokenFile) });
  }
  if (!envs.length) fail('no environment');
  const names = envs.flatMap((e) => [e.alias, ...e.aliases]);
  if (new Set(names).size !== names.length) fail('alias repeated');
  return { environments: envs };
}

export async function loadOpsConfig({ file = process.env.T3_CONNECTOR_OPS_CONFIG ?? OPS_CONFIG, inline = process.env.T3_CONNECTOR_OPS_ENVIRONMENTS } = {}) {
  if (inline) return validateOpsConfig(JSON.parse(inline));
  const path = expandir(file);
  let text;
  try { text = await readFile(path, 'utf8'); } catch { throw new OpsError('config_missing', `ops config missing at ${path}`); }
  return { ...validateOpsConfig(JSON.parse(text)), file: path };
}

/** Alias, extra alias or environmentId. Unknown names fail listing the valid ones. */
export function resolveEnvironment(environments, name) {
  const e = environments.find((x) => x.alias === name || x.aliases.includes(name) || (x.environmentId && x.environmentId === name));
  if (!e) throw new OpsError('environment_unknown', `unknown environment: ${name}`, { known: environments.map((x) => ({ alias: x.alias, aliases: x.aliases })) });
  return e;
}

/** Why a thread cannot be settled or snoozed now; null when it can. */
export function refusal(thread) {
  if (!thread || thread.deletedAt) return 'not_found';
  if (ACTIVE_STATUSES.has(thread.status)) return `status_${thread.status}`;
  if (thread.pendingRuntimeRequest) return `pending_request_${thread.pendingRuntimeRequest.kind}`;
  return null;
}

/** Project by exact id, exact workspace root, or title (case-insensitive); ambiguity fails. */
export function findProject(projects, ref) {
  const live = projects.filter((p) => !p.deletedAt);
  const describe = (p) => ({ projectId: p.id, title: p.title, workspaceRoot: p.workspaceRoot ?? null });
  for (const match of [(p) => p.id === ref, (p) => p.workspaceRoot === ref, (p) => p.title?.toLowerCase() === String(ref).toLowerCase()]) {
    const found = live.filter(match);
    if (found.length === 1) return found[0];
    if (found.length > 1) throw new OpsError('project_ambiguous', `"${ref}" matches ${found.length} projects; use the projectId or the workspace root`, { candidates: found.map(describe) });
  }
  throw new OpsError('project_not_found', `no project "${ref}" in this environment`, { projects: live.map(describe) });
}

/**
 * Model selection from the environment catalog: the instance, the model and the effort must
 * be offered there. `effort` maps to the model's reasoning option (effort or reasoningEffort).
 */
export function buildModelSelection(providers, { instanceId, model, effort, options = [] }) {
  const selection = { instanceId, model, options: [...options] };
  if (effort !== undefined) {
    const descriptors = providers.find((p) => p?.instanceId === instanceId)?.models?.find((m) => m?.slug === model)?.capabilities?.optionDescriptors ?? [];
    const d = descriptors.find((x) => EFFORT_OPTIONS.includes(x?.id));
    if (!d && problemasModelSelection(providers, { instanceId, model }).length === 0) {
      throw new OpsError('effort_unsupported', `model ${model} of ${instanceId} declares no effort option`);
    }
    if (d) {
      if (selection.options.some((o) => o.id === d.id)) throw new OpsError('effort_repeated', `effort given twice (--effort and option ${d.id})`);
      selection.options.push({ id: d.id, value: effort });
    }
  }
  const problems = problemasModelSelection(providers, selection);
  if (problems.length) throw new OpsError(problems[0].code, problems.map((p) => p.message).join(' '), { problems });
  if (!selection.options.length) delete selection.options;
  return selection;
}

const threadSummary = (t, projects) => ({
  threadId: t.id, title: t.title, projectId: t.projectId, project: projects.get(t.projectId) ?? null,
  status: t.status, createdBy: t.createdBy, creationSource: t.creationSource ?? null,
  parentThreadId: t.lineage?.parentThreadId ?? null, settledAt: t.settledAt ?? null, snoozedUntil: t.snoozedUntil ?? null,
  archivedAt: t.archivedAt ?? null, pendingRequest: t.pendingRuntimeRequest?.kind ?? null, updatedAt: t.updatedAt ?? null,
  modelSelection: t.modelSelection ?? null, runtimeMode: t.runtimeMode ?? null,
});

export function createOps(environment, {
  transport = environment.ssh ? criarTransporteSsh(environment.ssh) : criarTransporteUrl(environment.url),
  readToken = lerTokenPrivado,
  WebSocketImpl = globalThis.WebSocket,
  rpcTimeoutMs = 60000,
} = {}) {
  let session = null; // {client, base, environmentId}
  let rpc = null;

  async function open() {
    if (session) return session;
    const base = await transport.baseUrl({ signal: AbortSignal.timeout(20000) });
    const client = criarCliente({ url: base, token: readToken(environment.tokenFile), timeoutMs: 20000 });
    const desc = await client.ambiente();
    if (desc.orchestrationProtocolVersion !== 2) throw new OpsError('protocol_unsupported', `T3 server with protocol ${desc.orchestrationProtocolVersion}; 2 is required`);
    if (environment.environmentId && desc.environmentId !== environment.environmentId) {
      throw new OpsError('environment_mismatch', `endpoint of ${environment.alias} answered as ${desc.environmentId}; expected ${environment.environmentId}`);
    }
    const scopes = (await client.sessao()).scopes ?? [];
    const missing = OPS_SCOPES.filter((s) => !scopes.includes(s));
    if (missing.length) throw new OpsError('token_scope_missing', `token of ${environment.alias} lacks ${missing.join(', ')}`);
    session = { client, base, environmentId: desc.environmentId, label: desc.label };
    return session;
  }

  async function socket() {
    if (rpc?.available) return rpc;
    const { client, base } = await open();
    const ticket = await client.ticketWs();
    const url = new URL('/ws', base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('orchestrationProtocol', '2');
    url.searchParams.set('wsTicket', ticket);
    const ws = new WebSocketImpl(url.toString());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new OpsError('environment_unavailable', 'WebSocket did not open')); }, 15000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new OpsError('environment_unavailable', 'WebSocket refused')); }, { once: true });
    });
    const current = new StagingRpcTransport({ socket: ws, allowLoopback: true, timeoutMs: rpcTimeoutMs, onFailure: () => { if (rpc === current) rpc = null; } });
    rpc = current;
    return current;
  }

  // A typed T3 refusal comes back as NativeRpcError; anything else on the socket is uncertain.
  async function invoke(method, payload) {
    try {
      return await (await socket()).invoke(method, payload, { nativeErrors: true });
    } catch (e) {
      if (e.native) throw new OpsError('t3_refused', `${e.native.code}: ${e.native.message}`, { native: e.native });
      throw new OpsError('uncertain', `${method}: ${e.message}; the effect may or may not have happened, read before repeating`);
    }
  }

  async function shell() {
    const s = await (await open()).client.shell();
    return {
      raw: s,
      threads: new Map([...(s.archivedThreads ?? []), ...(s.threads ?? [])].map((t) => [t.id, t])),
      projects: new Map((s.projects ?? []).map((p) => [p.id, p.title])),
    };
  }

  async function threadOrFail(threadId) {
    const s = await shell();
    const t = s.threads.get(threadId);
    if (!t || t.deletedAt) throw new OpsError('thread_not_found', `${threadId}: not found in ${environment.alias}`);
    return { s, t };
  }

  const dispatch = (command) => invoke('orchestration.dispatchCommand', command);

  return {
    environment,

    async identity() {
      const s = await open();
      return { alias: environment.alias, environmentId: s.environmentId, label: s.label };
    },

    /** Threads that are neither settled, archived nor deleted. */
    async list() {
      const s = await shell();
      return [...s.threads.values()].filter((t) => !t.settledAt && !t.archivedAt && !t.deletedAt).map((t) => threadSummary(t, s.projects));
    },

    async thread(threadId) {
      const { s, t } = await threadOrFail(threadId);
      return threadSummary(t, s.projects);
    },

    /**
     * State and conversation messages (user and assistant, no tool output). `position` is the
     * order in the thread, 1 = first. `since` keeps positions after it; `last` keeps the tail.
     */
    async read(threadId, { since, last } = {}) {
      const { s, t } = await threadOrFail(threadId);
      const { projection } = await (await open()).client.threadCompleto(threadId);
      const all = (projection?.messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant').map((m, i) => ({
        position: i + 1, messageId: m.id, role: m.role, createdBy: m.createdBy ?? null, creationSource: m.creationSource ?? null,
        text: m.text ?? '', createdAt: m.createdAt ?? null, streaming: Boolean(m.streaming), attachments: m.attachments?.length ?? 0,
      }));
      let messages = all.filter((m) => m.position > (since ?? 0));
      if (last !== undefined) messages = messages.slice(-last);
      return { thread: threadSummary(t, s.projects), total: all.length, messages };
    },

    /**
     * Timeline messages (user_message/assistant_message with author and origin), oldest first.
     * Walks history pages until every id in `messageIds` is loaded, or until items older than
     * `notBefore` (epoch ms) appear.
     */
    async timeline(threadId, { messageIds = [], notBefore = 0 } = {}) {
      await threadOrFail(threadId);
      const { client } = await open();
      const item = (i) => ({ messageId: i.messageId, type: i.type, createdBy: i.createdBy ?? null, creationSource: i.creationSource ?? null,
        text: i.text ?? '', at: i.startedAt ?? i.updatedAt ?? null, ordinal: i.ordinal });
      const recent = await client.thread(threadId);
      const items = (recent.projection?.turnItems ?? []).filter((i) => i.messageId).map(item);
      let cursor = recent.hasMoreHistory ? recent.historyCursor : null;
      const enough = () => messageIds.length > 0 && messageIds.every((id) => items.some((m) => m.messageId === id));
      while (cursor && !enough() && !items.some((m) => Date.parse(m.at) < notBefore)) {
        const page = await client.historico(threadId, cursor);
        items.push(...page.items.map((p) => p.item).filter((i) => i?.messageId).map(item));
        cursor = page.hasMoreHistory ? page.nextCursor : null;
      }
      return items.sort((a, b) => a.ordinal - b.ordinal);
    },

    async projects() {
      const s = await shell();
      return (s.raw.projects ?? []).filter((p) => !p.deletedAt).map((p) => ({ projectId: p.id, title: p.title, workspaceRoot: p.workspaceRoot ?? null }));
    },

    /** Provider catalog of this environment (server.getConfig), the source create validates against. */
    async providers() {
      const config = await invoke('server.getConfig', {});
      const { environmentId } = await open();
      if (config?.environment?.environmentId && config.environment.environmentId !== environmentId) throw new OpsError('environment_mismatch', 'server.getConfig answered for another environment');
      if (!Array.isArray(config?.providers)) throw new OpsError('providers_unavailable', 'server.getConfig returned no providers');
      return config.providers;
    },

    /**
     * Message into a thread. `messageId` is the idempotency key (use deriveId); repeating the
     * call with it does not duplicate the message. Confirmed by the projection, or by an active
     * run that keeps a queued message out of the timeline until it ends.
     */
    async send(threadId, { text, messageId, delivery = 'queue_after_active', createdBy = 'agent', creationSource = 'mcp' }) {
      if (!text?.trim()) throw new OpsError('text_empty', 'empty text');
      if (!messageId) throw new OpsError('message_id_required', 'messageId required (idempotency key)');
      if (!DELIVERIES.includes(delivery)) throw new OpsError('delivery_invalid', `delivery must be one of ${DELIVERIES.join(', ')}`);
      const { t } = await threadOrFail(threadId);
      if (t.archivedAt) throw new OpsError('thread_archived', `${threadId}: archived`);
      await dispatch({ type: 'message.dispatch', commandId: messageId, messageId, threadId, text, attachments: [], createdBy, creationSource, dispatchMode: { type: delivery } });
      const bounded = await (await open()).client.thread(threadId);
      const delivered = (bounded.projection?.messages ?? []).some((m) => m.id === messageId)
        || (bounded.projection?.turnItems ?? []).some((i) => i.messageId === messageId);
      const queued = !delivered && ACTIVE_STATUSES.has((await shell()).threads.get(threadId)?.status);
      if (!delivered && !queued) throw new OpsError('not_confirmed', `${threadId}: message ${messageId} not visible after dispatch`);
      return { threadId, messageId, state: delivered ? 'delivered' : 'queued' };
    },

    /**
     * New thread in a project (id, workspace root or title), with model and effort checked
     * against this environment's catalog and the brief as first message. `clientRequestId` makes
     * it idempotent: the thread id derives from it, and an existing thread is returned as is.
     * `namespace` prefixes the derived commandId and brief messageId (see deriveId).
     */
    async create({ project, title, instanceId, model, effort, options = [], runtimeMode = 'full-access', workspace = { type: 'root' }, text, clientRequestId, namespace = 't3-connector-ops' }) {
      if (!clientRequestId) throw new OpsError('client_request_id_required', 'clientRequestId required (idempotency key)');
      if (!title?.trim()) throw new OpsError('title_required', 'title required');
      if (!instanceId || !model) throw new OpsError('model_required', 'instanceId and model required');
      if (!RUNTIME_MODES.includes(runtimeMode)) throw new OpsError('runtime_mode_invalid', `runtimeMode must be one of ${RUNTIME_MODES.join(', ')}`);
      const { environmentId } = await open();
      const threadId = deriveUuid('t3-connector-ops:create', environmentId, clientRequestId);
      const before = await shell();
      const existing = before.threads.get(threadId);
      if (existing && !existing.deletedAt) return { created: false, ...threadSummary(existing, before.projects) };
      const p = findProject(before.raw.projects ?? [], project);
      const modelSelection = buildModelSelection(await this.providers(), { instanceId, model, effort, options });
      await invoke('orchestration.launchThread', {
        commandId: deriveId(namespace, 'launch', environmentId, clientRequestId), threadId, projectId: p.id, title, modelSelection,
        workspaceStrategy: workspace, runtimeMode, interactionMode: 'default',
        ...(text?.trim() ? { initialMessage: { messageId: deriveId(namespace, 'brief', environmentId, clientRequestId), text, attachments: [] } } : {}),
      });
      const after = await shell();
      const t = after.threads.get(threadId);
      if (!t) throw new OpsError('not_confirmed', `thread ${threadId} not in the shell after launch`);
      return { created: true, ...threadSummary(t, after.projects) };
    },

    /** Settle each thread that is idle without pending requests; others are refused, not touched. */
    async settle(threadIds, { namespace = 't3-connector-ops' } = {}) {
      return this.mutate(threadIds, (threadId) => ({ type: 'thread.settle', commandId: deriveId(namespace, 'settle', threadId), threadId }), (t) => Boolean(t?.settledAt));
    },

    /** Snooze until `until` (Date); same refusals as settle. */
    async snooze(threadId, until, { namespace = 't3-connector-ops' } = {}) {
      const iso = until.toISOString();
      return (await this.mutate([threadId], (id) => ({ type: 'thread.snooze', commandId: deriveId(namespace, 'snooze', id, iso), threadId: id, snoozedUntil: iso }),
        (t) => Boolean(t?.snoozedUntil) && Date.parse(t.snoozedUntil) === until.getTime()))[0];
    },

    async mutate(threadIds, command, confirmed) {
      const before = await shell();
      const results = [];
      for (const threadId of threadIds) {
        const why = refusal(before.threads.get(threadId));
        if (why) { results.push({ threadId, ok: false, error: 'refused', reason: why }); continue; }
        try { await dispatch(command(threadId)); results.push({ threadId, ok: null }); }
        catch (e) { results.push({ threadId, ok: false, error: e.code ?? 'failed', reason: e.message }); }
      }
      const after = results.some((r) => r.ok === null) ? await shell() : null;
      for (const r of results.filter((x) => x.ok === null)) {
        const t = after.threads.get(r.threadId);
        Object.assign(r, confirmed(t) ? { ok: true, thread: threadSummary(t, after.projects) } : { ok: false, error: 'not_confirmed', reason: 'state unchanged after dispatch' });
      }
      return results;
    },

    close() {
      if (rpc) { try { rpc.close(); } catch {} }
      rpc = null;
      session = null;
      transport.fechar();
    },
  };
}
