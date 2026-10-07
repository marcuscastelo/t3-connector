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
// Beyond these, `act` runs every action the connector knows (adapters.mjs ALL_ACTIONS: T3
// commands, project administration, native-tool writes and operator-only wrappers) and `query`
// every read (native-tool reads and the MCP reads of servidor.mjs), with the same validation and
// the same code as the MCP paths; `actions()` lists both. ops is stateless: there is no journal.
// The idempotency of `act` is the commandId (and messageId/threadId/targetThreadId) derived from
// (namespace, environmentId, action, operationId): repeating an operation makes T3 replay the
// receipt it committed instead of applying it again. Native writes that T3 accepts without a
// commandId (see `idempotent: false` in actions()) do repeat their effect.
//
// Reads (list, thread, read, timeline, projects, query, providers) need a token with
// orchestration:read; send, create, settle, snooze and act also need orchestration:operate.
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
import { z } from 'zod';
import { campoConfig, expandir, sshConfig } from './config.mjs';
import { Cancelada, criarCliente, ErroT3, validarUrl } from './t3.mjs';
import { criarTransporteSsh, criarTransporteUrl } from './transporte.mjs';
import { lerTokenPrivado } from './escrita/conexao.mjs';
import { projectReceipt, StagingRpcTransport } from './escrita/transport-staging.mjs';
import { problemasModelSelection, validarModelSelection } from './escrita/model-selection.mjs';
import { ALL_ACTIONS, describeAction, parseAction } from './escrita/adapters.mjs';
import { guardProjectDelete, isProjectAction, lerOcupacao, lockProject, PROJECT_ACTIONS } from './escrita/project-admin.mjs';
import { NATIVE_READS, NATIVE_WRITES, NativeRpcError, NativeToolError, OPS_NATIVE_READS, OPS_NATIVE_WRITE_ACTIONS } from './escrita/native.mjs';
import { criarEscopoOperador, ForaDoEscopo } from './ambientes.mjs';
import { resumoModelo } from './estado.mjs';
import { aguardarThread } from './espera.mjs';
import { buscarThreads } from './busca-threads.mjs';
import { lerThreadsEmLote } from './leitura-lote.mjs';
import { snapshotPlanoControle } from './plano-controle.mjs';
import { resumirPedidosRuntime } from './pedidos-runtime.mjs';
import { CursorInvalido } from './paginacao.mjs';
import { EntradaInvalida } from './varredura.mjs';
import { assinar, chamar } from './ws.mjs';
import {
  executarListagem, formasLeitura, LISTAGEM_ATENCAO, LISTAGEM_PROJETOS, LISTAGEM_THREADS, lerThreadDetalhada, listagemProviders, mensagensDaThread, resumoDaThread,
} from './servidor.mjs';

export const OPS_CONFIG = '~/.config/t3-connector/ops.json';
// Reads need orchestration:read; anything sent over the socket also needs orchestration:operate,
// so a read-only pairing still lists, reads and walks the timeline.
export const READ_SCOPE = 'orchestration:read';
export const OPERATE_SCOPE = 'orchestration:operate';
export const ACTIVE_STATUSES = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
export const DELIVERIES = Object.freeze(['queue_after_active', 'start_immediately']);
const RUNTIME_MODES = ['approval-required', 'auto-accept-edits', 'auto', 'full-access'];
// Ceiling of query('wait'): the MCP t3_aguardar_thread keeps 5 s (a voice turn); a CLI caller
// can block longer on the same event-driven wait (one WebSocket subscription, no polling).
export const OPS_WAIT_MAX_MS = 300000;
// T3 accepts a commandId for these native writes, so a repeated operation is replayed, not redone.
const NATIVE_IDEMPOTENT = new Set(['t3_project_update', 'schedule_task', 't3_thread_configure']);
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
    // Plain HTTP beyond loopback only when the entry says so, for a network that encrypts by
    // itself (for example a tailnet); the read client still refuses it otherwise.
    if (e.insecureHttp !== undefined && typeof e.insecureHttp !== 'boolean') fail(`${alias}: insecureHttp must be true or false`);
    if (e.url && !(e.insecureHttp && new URL(e.url).protocol === 'http:')) validarUrl(e.url);
    if (e.ssh && !e.ssh.host) fail(`${alias}: ssh.host required`);
    if (!e.tokenFile) fail(`${alias}: missing tokenFile`);
    const aliases = e.aliases ?? [];
    if (!Array.isArray(aliases) || aliases.some((a) => typeof a !== 'string' || !/^[a-z0-9-]+$/.test(a))) fail(`${alias}: aliases must be a list of names`);
    envs.push({ alias, aliases, environmentId: e.environmentId ?? null, url: e.url ?? null, insecureHttp: Boolean(e.insecureHttp), ssh: sshConfig(e.ssh, fail, `${alias}: `), tokenFile: expandir(e.tokenFile) });
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

// Reads exposed by query(): the MCP reads of servidor.mjs by a stable name (same shapes, the
// environment is always this one), then the native-tool reads by their tool name.
const FORMAS = formasLeitura('this ops environment');
const shape = (name, overrides = {}) => z.object({ ...FORMAS[name], ...overrides }).strict();
const READS = {
  thread: { mcp: 't3_thread', schema: shape('t3_thread'), description: 'Detailed state of a thread (MCP t3_thread): canonical state, model with effort, runtimeMode, pendingRequests with content and nextAction, activeRun, latestRun, providerSession, latestResponse and history. Finds archived threads too.' },
  pending_requests: { schema: z.object({ threadId: z.string().min(1), requestId: z.string().min(1).optional() }).strict(), description: 'Pending runtime requests of a thread with full public content and nextAction (the pendingRequests of t3_thread): every kind, approvals included, unlike the native t3_pending_request_list (user_input only). With requestId, that one request (native t3_pending_request_read).' },
  messages: { mcp: 't3_mensagens', schema: shape('t3_mensagens'), description: 'Latest user and assistant messages of the recent window of a thread (MCP t3_mensagens).' },
  search: { mcp: 't3_buscar_threads', schema: shape('t3_buscar_threads'), description: 'Find threads by title or ID, archived included (MCP t3_buscar_threads); exactly one of search or threadId.' },
  threads: { mcp: 't3_threads', schema: shape('t3_threads'), description: 'Threads with canonical state, woke marker, filters (projectId, state, woke, search) and pagination (MCP t3_threads).' },
  projects: { mcp: 't3_projetos', schema: shape('t3_projetos'), description: 'Projects with running and needs-intervention counts, search and pagination (MCP t3_projetos).' },
  providers: { mcp: 't3_providers', schema: shape('t3_providers'), description: 'Provider instances summarized as MCP t3_providers (includeModels with instanceId for models); providers() returns the raw catalog.' },
  attention: { mcp: 't3_atencao', schema: shape('t3_atencao'), description: 'Threads needing intervention or failed and not settled (MCP t3_atencao).' },
  control_plane: { mcp: 't3_control_plane', schema: shape('t3_control_plane'), description: 'Running, needsIntervention and ready threads in one shell read (MCP t3_control_plane).' },
  wait: { mcp: 't3_aguardar_thread', schema: shape('t3_aguardar_thread', { environment: z.string().min(1).optional(), timeoutMs: z.number().int().min(1).max(OPS_WAIT_MAX_MS) }), description: `Event-driven wait for the run of a thread to end or ask for intervention (MCP t3_aguardar_thread), timeoutMs up to ${OPS_WAIT_MAX_MS} ms here (5000 in MCP); reaching it returns timedOut=true.` },
  read_batch: { mcp: 't3_thread_read_batch', schema: shape('t3_thread_read_batch'), description: 'Up to 20 threads in one call, each with the t3_thread detail, failures per item (MCP t3_thread_read_batch); items need only threadId here.' },
};
const NATIVE_QUERIES = { ...NATIVE_READS, ...OPS_NATIVE_READS };
export const QUERY_NAMES = Object.freeze([...Object.keys(READS), ...Object.keys(NATIVE_QUERIES)]);

// Native T3 MCP tools without an ops action or read, with the reason (what covers them, if anything).
export const OPS_OMITTED = Object.freeze({
  'preview_* (status, open, navigate, resize, set_appearance, snapshot, click, type, press, scroll, evaluate, wait_for, recording_start, recording_stop)': 'browser automation runs through the PreviewAutomationBroker of a connected host renderer; T3 exposes no external invoke RPC for it, only host-side connect/respond. t3_preview_list and t3_preview_close are offered',
  'device_list, device_open, device_close, device_screenshot': 'bound to simulators and helpers on the T3 host and to the thread panel; screenshot has no unary RPC. Not a thin wrapper',
  't3_attachment_prepare_upload, t3_attachment_discard, t3_thread_send_attachments': 'needs the exact bytes uploaded to a signed URL on the T3 origin and claim handling on uncertain results; a client path is not an attachment. Candidate for a future op, not a thin wrapper',
  t3_thread_read: 'the native timeline view (positions, textOffset, acknowledgement) is a server-side projection; read, timeline and query thread/messages cover the conversation',
  list_thread_pull_requests: 'PR entries and stack chains come from a server-side helper; the links are in the thread projection',
  t3_worktree_handoff: 'multi-step (vcs.createWorktree, metadata update, continuation, setup) with rollback, defined for the calling thread; thread.metadata.update is one step of it',
  'delegate_task, task_status, task_cancel': 'composed over the calling thread (inheritance, wait, completion acknowledgement); delegated_task.request, wake-policy, completion-delivery.acknowledge/dispose and run.interrupt are offered as the building blocks',
  'thread.conditional-send': 'needs the write journal (manifest and step states across calls); ops is stateless. Use run state from query thread/wait, then act thread.model-selection.set and thread.send',
  orchestrator_capabilities: 'caller inheritance and features do not apply to an operator; providers() and query providers give the catalog',
  t3_thread_update: 'covered by thread.metadata.update (rename, regenerate) and thread.pull-request.link/unlink',
  'link_pull_request, unlink_pull_request, watch_pull_request, unwatch_pull_request': 'covered by thread.pull-request.link/unlink/watch with explicit host, repository and number (no URL resolution)',
  't3_thread_launch, create_threads': 'covered by thread.launch and create (one thread per call, explicit model; no caller inheritance)',
});

const actionKind = (a) => (PROJECT_ACTIONS.includes(a) ? 'project' : NATIVE_WRITES[a] || OPS_NATIVE_WRITE_ACTIONS.includes(a) ? 'native-write' : 'command');

/** Catalog of what act() and query() accept, built from the tables that define them. */
export function opsActions() {
  return [
    ...ALL_ACTIONS.map((action) => {
      const kind = actionKind(action);
      return { action, kind, description: describeAction(action), idempotent: kind !== 'native-write' || NATIVE_IDEMPOTENT.has(action) };
    }),
    ...QUERY_NAMES.map((action) => NATIVE_QUERIES[action]
      ? { action, kind: 'native-read', description: NATIVE_QUERIES[action].description, idempotent: true }
      : { action, kind: 'read', description: READS[action].description, idempotent: true }),
  ];
}

const SAFE_CODE = /^[a-z][a-z0-9_]{2,63}$/;
/** Any error from the shared MCP/write code as an OpsError (code, message, details). */
export function asOpsError(e) {
  if (e instanceof OpsError) return e;
  if (e instanceof NativeToolError) return new OpsError(e.native.code, e.native.message, { native: e.native, sent: false });
  if (e instanceof NativeRpcError) return new OpsError('t3_refused', `${e.native.code}: ${e.native.message}`, { native: e.native });
  if (e?.name === 'ZodError' || Array.isArray(e?.issues)) return new OpsError('input_invalid', (e.issues ?? []).map((i) => `${(i.path ?? []).join('.') || 'input'}: ${i.message}`).join('; ') || 'invalid input', { issues: e.issues });
  if (e instanceof ForaDoEscopo) return new OpsError(/^thread /.test(e.message) ? 'thread_not_found' : /^project /.test(e.message) ? 'project_not_found' : 'not_found', e.message);
  if (e instanceof EntradaInvalida || e instanceof CursorInvalido) return new OpsError('input_invalid', e.message);
  if (e instanceof Cancelada) return new OpsError('cancelled', e.message);
  if (e instanceof ErroT3) {
    const code = e.codigo === 'prazo' ? 'timeout' : e.codigo === 'indisponivel' ? 'environment_unavailable' : e.codigo === 'environment_divergente' ? 'environment_mismatch' : e.status ? `http_${e.status}` : 't3_error';
    return new OpsError(code, e.message);
  }
  if (SAFE_CODE.test(e?.message ?? '')) return new OpsError(e.message, e.message);
  return new OpsError('failed', e?.message ?? String(e));
}

const threadSummary = (t, projects) => ({
  threadId: t.id, title: t.title, projectId: t.projectId, project: projects.get(t.projectId) ?? null,
  status: t.status, createdBy: t.createdBy, creationSource: t.creationSource ?? null,
  parentThreadId: t.lineage?.parentThreadId ?? null, settledAt: t.settledAt ?? null, snoozedUntil: t.snoozedUntil ?? null,
  archivedAt: t.archivedAt ?? null, pendingRequest: t.pendingRuntimeRequest?.kind ?? null, updatedAt: t.updatedAt ?? null,
  modelSelection: t.modelSelection ?? null, effort: resumoModelo(t.modelSelection)?.effort ?? null, runtimeMode: t.runtimeMode ?? null,
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
    const client = criarCliente({ url: base, token: readToken(environment.tokenFile), timeoutMs: 20000, allowInsecureHttp: environment.insecureHttp });
    const desc = await client.ambiente();
    if (desc.orchestrationProtocolVersion !== 2) throw new OpsError('protocol_unsupported', `T3 server with protocol ${desc.orchestrationProtocolVersion}; 2 is required`);
    if (environment.environmentId && desc.environmentId !== environment.environmentId) {
      throw new OpsError('environment_mismatch', `endpoint of ${environment.alias} answered as ${desc.environmentId}; expected ${environment.environmentId}`);
    }
    const scopes = (await client.sessao()).scopes ?? [];
    if (!scopes.includes(READ_SCOPE)) throw new OpsError('token_scope_missing', `token of ${environment.alias} lacks ${READ_SCOPE}`);
    session = { client, base, environmentId: desc.environmentId, label: desc.label, version: desc.serverVersion ?? null, scopes };
    return session;
  }

  async function requireOperate() {
    const s = await open();
    if (!s.scopes.includes(OPERATE_SCOPE)) throw new OpsError('token_scope_missing', `token of ${environment.alias} lacks ${OPERATE_SCOPE} (read-only pairing)`);
    return s;
  }

  // Read RPCs (server.getConfig, archived shell, settings, search…) need orchestration:read only.
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
    const current = new StagingRpcTransport({ socket: ws, allowLoopback: true, allowInsecureWs: environment.insecureHttp, timeoutMs: rpcTimeoutMs, onFailure: () => { if (rpc === current) rpc = null; } });
    rpc = current;
    return current;
  }

  // A typed T3 refusal comes back as NativeRpcError; anything else on the socket is uncertain,
  // except a refusal raised before the frame was sent.
  async function invoke(method, payload, { write = true } = {}) {
    if (write) await requireOperate();
    const transport = await socket();
    try {
      return await transport.invoke(method, payload, { nativeErrors: true });
    } catch (e) {
      if (e.native) throw new OpsError('t3_refused', `${e.native.code}: ${e.native.message}`, { native: e.native });
      if (['rpc_unavailable', 'control_socket_closed', 'too_many_dispatches'].includes(e.message)) throw new OpsError('not_sent', `${method}: ${e.message}; nothing was sent`);
      if (!write) throw new OpsError('environment_unavailable', `${method}: ${e.message}`);
      throw new OpsError('uncertain', `${method}: ${e.message}; the effect may or may not have happened, read before repeating`);
    }
  }
  const read = (method, payload = {}) => invoke(method, payload, { write: false });

  /** Archived threads (WS orchestration.getArchivedShellSnapshot; the HTTP shell has active ones). */
  async function archivedThreads() {
    return (await read('orchestration.getArchivedShellSnapshot', {})).threads ?? [];
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
    if (!s.threads.has(threadId)) for (const a of await archivedThreads().catch(() => [])) s.threads.set(a.id, a);
    const t = s.threads.get(threadId);
    if (!t || t.deletedAt) throw new OpsError('thread_not_found', `${threadId}: not found in ${environment.alias}`);
    return { s, t };
  }

  const dispatch = (command) => invoke('orchestration.dispatchCommand', command);

  // Full thread count of a project: HTTP shell (active) + archived snapshot at the same sequence.
  async function occupancy(projectId) {
    const { client } = await open();
    try {
      return await lerOcupacao({ projectId, readActive: () => client.shell(), readArchived: () => read('orchestration.getArchivedShellSnapshot', {}) });
    } catch { throw new OpsError('project_count_incomplete', 'could not count the project threads (active and archived); nothing was sent'); }
  }
  // A delete can leave threads another client created meanwhile: report them (never throws).
  async function afterDelete(projectId) {
    let count;
    try { count = await occupancy(projectId); } catch { return { postCheck: 'unavailable' }; }
    if (!count?.complete) return { postCheck: 'incomplete' };
    return count.total > 0 ? { postCheck: 'live_threads_remain', liveThreadsAfterDelete: count.total } : { postCheck: 'clean', liveThreadsAfterDelete: 0 };
  }

  // The MCP read code over this one environment, with the operator's scope (every project).
  async function registry() {
    const s = await open();
    const r = { alias: environment.alias, environmentId: s.environmentId, escopo: criarEscopoOperador(environment.alias), ssh: environment.ssh, projetosPermitidos: [] };
    const info = { nome: s.label, versao: s.version };
    const mine = (k) => k === undefined || k === environment.alias || k === s.environmentId || environment.aliases.includes(k);
    return {
      r,
      registros: [r],
      resolver: (k) => { if (mine(k)) return r; throw new ForaDoEscopo(`environment "${k}" is not ${environment.alias}; ops reads only its own environment`); },
      identidade: () => ({ alias: environment.alias, environmentId: s.environmentId }),
      conectar: async () => ({ cliente: s.client, info }),
      usar: async (_r, fn) => fn(s.client, info),
      falhou() {},
    };
  }

  /** HTTP shell, with the archived threads added when `threadId` is not among the active ones. */
  async function shellFor(threadId) {
    const raw = await (await open()).client.shell();
    if ((raw.threads ?? []).some((t) => t.id === threadId) || (raw.archivedThreads ?? []).some((t) => t.id === threadId)) return raw;
    return { ...raw, archivedThreads: [...(raw.archivedThreads ?? []), ...await archivedThreads().catch(() => [])] };
  }

  // Same reads as the native handler, through this environment's client and RPCs.
  const native = {
    rpc: (method, payload) => read(method, payload),
    thread: async (id) => (await open()).client.threadCompleto(id),
    projects: async () => (await open()).client.projetos(),
    environment: async () => (await open()).client.ambiente(),
  };

  const opsChamar = (o) => chamar({ ...o, WebSocketImpl });
  const opsAssinar = (o) => assinar({ ...o, WebSocketImpl });

  return {
    environment,

    async identity() {
      const s = await open();
      return { alias: environment.alias, environmentId: s.environmentId, label: s.label };
    },

    /**
     * Threads that are neither settled, archived nor deleted. `settled: true` lists the settled
     * ones instead (as the native t3_thread_list), `archived: true` the archived ones (read from
     * the archived shell snapshot); both together list settled or archived.
     */
    async list({ settled = false, archived = false } = {}) {
      const s = await shell();
      if (archived) for (const a of await archivedThreads()) if (!s.threads.has(a.id)) s.threads.set(a.id, a);
      const keep = (t) => {
        if (t.deletedAt) return false;
        if (!settled && !archived) return !t.settledAt && !t.archivedAt;
        return (settled && Boolean(t.settledAt) && !t.archivedAt) || (archived && Boolean(t.archivedAt));
      };
      return [...s.threads.values()].filter(keep).map((t) => threadSummary(t, s.projects));
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
      const config = await read('server.getConfig', {});
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
      await requireOperate();
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
     * `namespace` prefixes the derived commandId and brief messageId (see deriveId). T3 records
     * createdBy "user" for a launch through the external API; `creationSource` (default "mcp")
     * marks where it came from.
     */
    async create({ project, title, instanceId, model, effort, options = [], runtimeMode = 'full-access', workspace = { type: 'root' }, text, clientRequestId, namespace = 't3-connector-ops', creationSource = 'mcp' }) {
      if (!clientRequestId) throw new OpsError('client_request_id_required', 'clientRequestId required (idempotency key)');
      if (!title?.trim()) throw new OpsError('title_required', 'title required');
      if (!instanceId || !model) throw new OpsError('model_required', 'instanceId and model required');
      if (!RUNTIME_MODES.includes(runtimeMode)) throw new OpsError('runtime_mode_invalid', `runtimeMode must be one of ${RUNTIME_MODES.join(', ')}`);
      const { environmentId } = await requireOperate();
      const threadId = deriveUuid('t3-connector-ops:create', environmentId, clientRequestId);
      const before = await shell();
      const existing = before.threads.get(threadId);
      if (existing && !existing.deletedAt) return { created: false, ...threadSummary(existing, before.projects) };
      const p = findProject(before.raw.projects ?? [], project);
      const modelSelection = buildModelSelection(await this.providers(), { instanceId, model, effort, options });
      await invoke('orchestration.launchThread', {
        commandId: deriveId(namespace, 'launch', environmentId, clientRequestId), threadId, projectId: p.id, title, modelSelection,
        workspaceStrategy: workspace, runtimeMode, interactionMode: 'default', creationSource,
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

    /** Everything act() and query() accept: [{action, kind, description, idempotent}]. */
    actions() {
      return opsActions();
    },

    /**
     * Any connector action (ALL_ACTIONS) with the operator's token. Validation is the MCP one
     * (parseAction: same zod schemas and errors; modelSelection against server.getConfig; the
     * project-delete guard on a fresh active+archived count). Ids are derived from (namespace,
     * environmentId, action, operationId): the same operation repeated is replayed by T3, not
     * applied again. A typed T3 refusal is OpsError t3_refused (details.native); a lost transport
     * after the send is `uncertain` (read before repeating; repeating the same operationId is safe
     * where T3 accepts a commandId). Returns {action, operationId, commandId, ids?, result}.
     */
    async act(action, input = {}, { operationId, namespace = 't3-connector-ops' } = {}) {
      if (!ALL_ACTIONS.includes(action)) throw new OpsError('action_unknown', `unknown action: ${action}`, { known: ALL_ACTIONS });
      if (action === 'thread.send') operationId ??= input?.clientRequestId;
      if (typeof operationId !== 'string' || !operationId.trim() || operationId.length > 1024) throw new OpsError('operation_id_required', 'operationId required (idempotency key, 1-1024 characters)');
      let parsed;
      try { parsed = parseAction(action, input); } catch (e) { throw asOpsError(e); }
      const { spec, input: data } = parsed;
      if (action === 'thread.send' && data.clientRequestId !== operationId) throw new OpsError('request_id_mismatch', 'thread.send: clientRequestId must equal operationId');
      const { environmentId } = await requireOperate();
      const derive = (...extra) => deriveUuid(namespace, environmentId, action, operationId, ...extra);
      const commandId = derive();
      const ids = {};
      // Serialized with this process's other project-scoped writes (the Dispatcher's key).
      const release = data.projectId && (isProjectAction(action) || action === 'thread.launch') ? await lockProject(JSON.stringify([environmentId, [data.projectId]])) : null;
      try {
        if (data.modelSelection) await validarModelSelection({ providers: () => this.providers() }, data.modelSelection);
        if (isProjectAction(action)) guardProjectDelete(action, data, await occupancy(data.projectId));
        let method = spec.method, payload;
        if (spec.native) ({ method, payload } = await spec.build({ input: data, native, commandId }));
        else {
          payload = { ...spec.encode(data), commandId };
          if (action === 'thread.send') payload.messageId = ids.messageId = commandId;
          if (action === 'thread.launch') {
            payload.threadId = ids.threadId = derive('thread');
            if (payload.initialMessage) payload.initialMessage = { ...payload.initialMessage, messageId: ids.messageId = derive('message') };
          }
          if (action === 'thread.fork') payload.targetThreadId = ids.targetThreadId = derive('thread');
        }
        const raw = await invoke(method, payload, { write: true });
        let result;
        if (spec.native) {
          try { result = spec.result ? await spec.result({ raw, method, payload, input: data, native }) : raw; } catch { result = { raw, resultUnavailable: true }; }
        } else result = projectReceipt(raw) ?? ('threadId' in raw ? { threadId: raw.threadId, resumed: raw.resumed } : { sequence: raw.sequence });
        if (isProjectAction(action)) result = { ...result, ...await afterDelete(data.projectId) };
        return { action, operationId, commandId: payload.commandId ?? null, ...(Object.keys(ids).length ? { ids } : {}), result };
      } catch (e) {
        throw asOpsError(e);
      } finally { release?.(); }
    },

    /**
     * Any read by name (QUERY_NAMES): the MCP reads of servidor.mjs (thread, pending_requests,
     * messages, search, threads, projects, providers, attention, control_plane, wait, read_batch)
     * and the native-tool reads by their tool name. The result is what the MCP tool returns.
     */
    async query(name, input = {}) {
      try {
        if (NATIVE_QUERIES[name]) {
          return await NATIVE_QUERIES[name].run({ input: NATIVE_QUERIES[name].schema.parse(input ?? {}), native, authorize: async () => {} });
        }
        const def = READS[name];
        if (!def) throw new OpsError('query_unknown', `unknown query: ${name}`, { known: QUERY_NAMES });
        const amb = await registry();
        const { r } = amb;
        const environmentId = amb.identidade().environmentId;
        const own = { ...(input ?? {}) };
        if (name === 'read_batch' && Array.isArray(own.items)) own.items = own.items.map((i) => (i && typeof i === 'object' && i.environment === undefined ? { ...i, environment: environment.alias } : i));
        if ('environment' in def.schema.shape) own.environment ??= environment.alias;
        const args = def.schema.parse(own);
        amb.resolver(args.environment);
        const env = amb.identidade();
        const client = (await open()).client;
        switch (name) {
          case 'thread': return { environment: env, ...await lerThreadDetalhada({ ...args, r, cliente: client, shell: await shellFor(args.threadId) }) };
          case 'messages': return { environment: env, ...await mensagensDaThread({ ...args, r, cliente: client, shell: await shellFor(args.threadId) }) };
          case 'pending_requests': {
            const thread = r.escopo.exigirThread(await shellFor(args.threadId), args.threadId);
            const pending = resumirPedidosRuntime((await client.thread(args.threadId)).projection ?? {}, thread);
            if (args.requestId === undefined) return { environment: env, threadId: args.threadId, total: pending.length, pendingRequests: pending };
            const request = pending.find((p) => p.requestId === args.requestId);
            if (!request) throw new OpsError('request_not_found', `no pending request ${args.requestId} in thread ${args.threadId}`, { pending: pending.map((p) => p.requestId) });
            return { environment: env, threadId: args.threadId, request };
          }
          case 'search': return await buscarThreads(amb, args, { resumir: (t, p) => resumoDaThread(t, p) });
          case 'threads': return await executarListagem(amb, LISTAGEM_THREADS, args);
          case 'projects': return await executarListagem(amb, LISTAGEM_PROJETOS, args);
          case 'attention': return await executarListagem(amb, LISTAGEM_ATENCAO, args);
          case 'providers': return await executarListagem(amb, listagemProviders({ chamarImpl: opsChamar }), args);
          case 'control_plane': return await snapshotPlanoControle(amb, args, { resumir: resumoDaThread });
          case 'wait': return await aguardarThread(amb, args, { tetoMs: OPS_WAIT_MAX_MS, assinarImpl: opsAssinar });
          case 'read_batch': {
            const { maxCharacters: maxCaracteres = 1500 } = args;
            return await lerThreadsEmLote(amb, args, { ler: ({ r: rr, cliente, shell: sh, threadId, signal }) => lerThreadDetalhada({ r: rr, cliente, shell: sh, threadId, signal, maxCharacters: maxCaracteres }) });
          }
          default: throw new OpsError('query_unknown', `unknown query: ${name}`, { known: QUERY_NAMES, environmentId });
        }
      } catch (e) {
        throw asOpsError(e);
      }
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
