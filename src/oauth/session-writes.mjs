import { z } from 'zod';
import { Dispatcher, ACTIONS, schemaForAction, parseAction, chaveOperacao, SEND_DESCRIPTION, SETTLE_DESCRIPTION } from '../escrita/adapters.mjs';
import { MENSAGENS_GUARD } from '../settlement.mjs';
import { fontesEscrita, preflightDespacho } from '../despacho.mjs';
import { grantDoAmbiente } from '../escrita/gate.mjs';
import { grantFromInventory, escopoDosGrants } from '../escrita/scope.mjs';
import { identidadeSessaoOAuth, exigirIdentidade } from '../escrita/identidade.mjs';
import { resolverAmbiente } from '../escrita/config.mjs';
import { consentAll, consented } from './project-policy.mjs';
import { redact } from './http.mjs';
import { PROJECT_ACTIONS, isProjectAction } from '../escrita/project-admin.mjs';
import { NATIVE_WRITES, NATIVE_WRITE_ACTIONS, NATIVE_READS, ENV_SCOPED } from '../escrita/native.mjs';
import { admitirLote, executarLote, itemDoJournal, INBOX_ACTIONS, LoteInvalido, MAX_ITENS, PRAZO_LOTE_MS } from '../escrita/lote-inbox.mjs';
import { ForaDoEscopo } from '../ambientes.mjs';

// T3 writes authorized by an OAuth session instead of a passkey lease. The existing Dispatcher
// (journal reservation, target/workspace preflight, uncertainty handling, final synchronous check
// right before the single outbound call) is reused with optional OAuth preflight hooks; its `gate` is
// replaced by SessionWriteGate, keyed by session id. The lease Gate is never consulted, created or
// extended here, and a lease id is never accepted as a session id (they live in different stores).
//
// OAuth/all consent contains environments, not project IDs. Each operation owns its live context.
// Restricted mode retains the sign-in snapshot for sandbox compatibility.

const fail = code => { throw new Error(code); };

export class SessionWriteGate {
  constructor({ authority, issuer, audit = () => {}, onClose = () => {}, operationGrant = null }) { Object.assign(this, { authority, issuer, auditSink: audit, onClose, operationGrant }); }
  callerFor(session) { return exigirIdentidade(identidadeSessaoOAuth({ issuer: this.issuer, subject: session.sub })); }
  #session(sid) { try { return this.authority.check(sid); } catch { return fail('lease_closed'); } }
  status(sid) {
    let s;
    try { s = this.authority.check(sid); } catch { return { active: false, scope: {} }; }
    return { active: true, scope: { caller: this.callerFor(s), environments: s.grants?.environments ?? [] } };
  }
  check(identity, sid, { environmentId, destination, projectIds, action }) {
    const caller = exigirIdentidade(identity), s = this.#session(sid);
    if (this.callerFor(s) !== caller) fail('lease_closed');
    const grant = grantDoAmbiente({ environments: s.grants?.environments ?? [] }, { environmentId, destination });
    if (!grant) fail('ambiente_fora_da_lease');
    const operational = s.grants?.projectPolicy === 'all' ? this.operationGrant : grant;
    if (!operational || operational.alias !== grant.alias || operational.environmentId !== environmentId || operational.destination !== destination) fail('scope_denied');
    // Environment-scoped native writes (project create/clone, preferences) target no project.
    if (!grant.actions.includes(action) || (!projectIds.length && !ENV_SCOPED.has(action)) || projectIds.some(p => !operational.projects?.some(g => g.id === p))) fail('scope_denied');
    return s;
  }
  dispatch(identity, sid, target, invoke, operationId) {
    this.check(identity, sid, target);
    this.audit({ event: 'dispatch', operationId, sid: redact(sid), action: target.action, projects: target.projectIds, authority: 'oauth_session' });
    // No await between final authorization and the one outbound invocation.
    this.check(identity, sid, target);
    return invoke();
  }
  audit(event) { this.auditSink(event); }
  // The Dispatcher calls close() when the journal fails or a send became uncertain: fail closed by
  // ending every OAuth session (the lease gate does the same with its leases).
  close() { this.onClose(); this.authority.revokeAll('write_path_failure'); }
}

// Internal codes are the write path's (Portuguese); clients get the English contract of ADR 0004,
// with the same code mapping as the lease bridge.
const CODES = { ambiente_obrigatorio: 'environment_required', ambiente_desconhecido: 'environment_unknown', ambiente_fora_da_lease: 'environment_not_in_lease', ambiente_indisponivel: 'environment_unavailable', sem_projetos: 'no_projects' };
const code = c => CODES[c] ?? c;
const MESSAGES = {
  environment_required: 'pass `environment` (alias or environmentId); writes have no default environment',
  environment_unknown: 'environment not configured for writes',
  environment_not_in_lease: 'this environment was not available or not approved when you signed in; reconnect the connector to approve it',
  environment_unavailable: 'the T3 server of this environment did not respond; nothing was sent',
  scope_denied: 'project or action outside the scope approved at sign-in for this environment',
  thread_not_found: 'thread not found in this environment',
  lease_closed: 'the OAuth session expired or was revoked; reconnect the connector (passkey sign-in)',
  dispatch_rejected: 'rejected while the connector prepared the request, before sending it to T3; no mutation was sent',
  reconciliation_required: 'the connector tried to send to T3 but could not confirm the result. Do not retry; call t3_reconciliar_escrita with the same environment and operationId',
  target_run_id_required: 'targetRunId required: read t3_thread in the same environment and pass the active run for steer_active or restart_active',
  queue_explicit_intent_required: 'queue_after_active requires an explicit request to defer and deferUntilActiveCompletes=true',
  project_not_empty: 'the project still has threads (active or archived); nothing was sent. Use t3_contar_threads_projeto; deleting with its threads needs project.delete-force',
  project_count_incomplete: 'could not obtain a complete thread count for the project (active and archived); nothing was sent',
  project_count_unavailable: 'this environment cannot count project threads; nothing was sent',
  project_count_changed: 'the live thread count differs from expectedThreadCount; nothing was sent. Count again and confirm',
  project_threads_changed: 'the set of live threads differs from expectedThreadsDigest (same total, other threads); nothing was sent. Count again and confirm',
  project_gone: 'the project is no longer live in T3 (deleted or missing in the same read as the count); nothing was sent',
  project_confirmation_mismatch: 'confirmProjectId must repeat the exact projectId; nothing was sent',
  project_has_active_work: 'a thread of the project has an active run or a pending request; nothing was sent. Interrupt or finish it first',
  ...MENSAGENS_GUARD,
};
const PROJECT_DESCRIPTIONS = {
  'project.delete': 'Deletes an EMPTY project (no active or archived threads) from T3. Refused if any thread exists; never escalates to force. The workspace directory on disk is kept.',
  'project.delete-force': 'Deletes a project AND all its threads (active and archived), cancelling their pending work. Only on an explicit request to delete the project with its threads: requires force=true, confirmProjectId equal to projectId, and expectedThreadCount and expectedThreadsDigest from one t3_contar_threads_projeto call; refused if the count or the set of threads changed, or a thread has an active run or a pending request. The workspace directory on disk is kept.',
};
// Batch-only texts: the singular tools keep their messages unchanged.
const BATCH_MESSAGES = {
  precondition_failed: 'the thread is not in expectedProjectId in this environment; nothing was sent. Resolve it again (t3_thread_find_batch) and confirm with the user',
  batch_stopped: 'not attempted because the batch stopped earlier (see `stopped`); nothing was sent for this item. To apply it, re-read the thread and use a new batchId and a new operationId',
  batch_conflict: 'this batchId was already used with different items or values; nothing was sent. Repeat the exact original call to see its results, or use a new batchId for a new intent',
  journal_failed: 'the connector could not record the operation and ended every OAuth session. Reconnect and repeat the same call (same batchId) to see what was recorded; never resend with a new batchId',
  reconciliation_required: 'the connector tried to send to T3 but could not confirm the result. Do not resend; call t3_reconciliar_escrita with this environment and operationId',
  environment_unavailable: 'the T3 server of this environment did not respond; nothing was sent for this item',
  duplicate_key: 'every item key must be unique in the call; nothing was sent',
  duplicate_target: 'the same thread appears twice in the call (one action per thread per batch); nothing was sent',
  duplicate_operation_id: 'every item needs its own operationId; nothing was sent',
  snoozed_until_required: 'snooze requires snoozedUntil on every item; nothing was sent',
  snoozed_until_not_allowed: 'snoozedUntil only applies to snooze; nothing was sent',
  snoozed_until_invalid: 'snoozedUntil must be an absolute ISO 8601 instant with Z or an explicit offset (for example 2026-10-06T09:00:00-03:00); nothing was sent',
  batch_size_invalid: `pass 1-${MAX_ITENS} items; split larger selections into several batches`,
};
const threadProject = (s, id) => s.threads?.find(t => t.id === id && !t.deletedAt)?.projectId;
const describe = action => PROJECT_DESCRIPTIONS[action] ?? (action === 'thread.send' ? SEND_DESCRIPTION
  : action === 'thread.settle' ? SETTLE_DESCRIPTION
  : action === 'runtime-request.answer' ? 'Answers a pending user_input runtime request using requestId and answers keyed by question ID from t3_thread.pedidosPendentes; thread.send does NOT answer it.'
  : action === 'runtime-request.approve' ? 'Responds to a pending approval runtime request using requestId and decision from t3_thread.pedidosPendentes; user_input requires runtime-request.answer instead.'
  : action);
export const writeToolName = action => `t3_escrever_${action.replaceAll('.', '_').replaceAll('-', '_')}`;

// In restricted mode, `allowedProjects` (Map alias → Set of project ids) narrows the sign-in grant
// to those projects; an environment without an entry gets no grant. Without it the grant is the
// full inventory, as with the lease.
export function sessionWrites({ conexoes, journal, authority, issuer, allowedProjects = null, inventoryMs = 15000, batchDeadlineMs = PRAZO_LOTE_MS, projectPolicy = 'restricted', projectAdmin = false, nativeTools = false, audit = e => journal.audit(e), chamarImpl }) {
  const all = projectPolicy === 'all';
  if (projectAdmin && !all) throw new Error('OAuth project administration requires projectPolicy all');
  if (nativeTools && !all) throw new Error('OAuth native tools require projectPolicy all');
  if (all && allowedProjects) throw new Error('OAuth all conflicts with allowedProjects');
  const gate = new SessionWriteGate({ authority, issuer, audit });
  const registros = conexoes.map(c => c.registro);
  const porAlias = new Map(conexoes.map(c => [c.registro.alias, c]));
  const dispatchers = new Map(all ? [] : conexoes.map(c => [c.registro.alias, new Dispatcher({ gate, adapter: c.adapter, journal, environmentId: c.registro.environmentId, destination: c.registro.destination, dispatchPreflight: (pedido, { scope }) => preflightDespacho(pedido, fontesEscrita(conexoes, scope, { chamarImpl })) })]));
  const identity = principal => identidadeSessaoOAuth({ issuer, subject: principal.sub });
  const resolve = chave => porAlias.get(resolverAmbiente(registros, chave).alias);

  // All-mode consent needs no backend availability; restricted retains the lease snapshot rule.
  async function inventory() {
    if (all) return { grants: consentAll(registros), unavailable: [] };
    const grants = [], unavailable = [];
    await Promise.all(conexoes.map(async c => {
      const r = c.registro;
      try {
        if (allowedProjects && !allowedProjects.has(r.alias)) throw new Error('no_projects_allowed');
        let projects = await Promise.race([c.inventario(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), inventoryMs).unref())]);
        if (allowedProjects) projects = projects.filter(p => allowedProjects.get(r.alias).has(p.id));
        if (!projects.length) throw new Error('sem_projetos');
        grants.push(grantFromInventory({ alias: r.alias, environmentId: r.environmentId, label: r.alias, destination: r.destination, projects, actions: r.acoes }));
      } catch (e) { unavailable.push({ alias: r.alias, environmentId: r.environmentId, reason: /^[a-z_]+$/.test(e.message) ? code(e.message) : 'environment_unavailable' }); }
    }));
    return { grants: grants.length ? escopoDosGrants(grants) : { scopeVersion: 2, runtimeMode: 'full-access', environments: [] }, unavailable };
  }

  // Refuses targets outside the frozen grant before the Dispatcher runs. The Dispatcher would refuse
  // them too, but only at its final check, after marking the operation uncertain, which fails closed
  // by ending every session; a model asking for a project it was not granted should not cost a
  // reconnect. The Dispatcher's own checks still run unchanged afterwards.
  async function precheck(principal, c, action, input) {
    let parsed;
    try { parsed = parseAction(action, input); } catch { return; } // the Dispatcher reports invalid input
    const grant = grantDoAmbiente({ environments: authority.check(principal.sid).grants?.environments ?? [] }, { environmentId: c.registro.environmentId, destination: c.registro.destination });
    if (!grant) return;
    const projects = new Set(parsed.input.projectId ? [parsed.input.projectId] : []);
    for (const ref of parsed.spec.refs) { const p = await c.adapter.projectForThread(parsed.input[ref]); if (p) projects.add(p); }
    if ([...projects].some(p => !grant.projects.some(g => g.id === p))) fail('scope_denied');
  }

  async function liveShell(principal, c) {
    consented(authority, principal, c.registro);
    let timer;
    try {
      const shell = await Promise.race([(async () => (await c.cliente()).shell({ signal: AbortSignal.timeout(inventoryMs) }))(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('ambiente_indisponivel')), inventoryMs); })]);
      consented(authority, principal, c.registro);
      return shell;
    } finally { clearTimeout(timer); }
  }
  function authorizeRecord(principal, c, action) {
    const s = consented(authority, principal, c.registro);
    const env = s.grants.environments.find(e => e.alias === c.registro.alias);
    if (!env.actions.includes(action)) fail('scope_denied');
  }
  async function dispatch(principal, { environment, action, operationId, input }) {
    // Project actions exist only while the flag is on, whatever an older consent recorded.
    if (isProjectAction(action) && !projectAdmin) fail('scope_denied');
    const c = resolve(environment);
    if (!all) {
      await precheck(principal, c, action, input);
      return { environment: { alias: c.registro.alias, environmentId: c.registro.environmentId }, ...await dispatchers.get(c.registro.alias).dispatch(identity(principal), principal.sid, { operationId, action, input }) };
    }
    authorizeRecord(principal, c, action);
    let shell;
    const opGate = new SessionWriteGate({ authority, issuer, audit });
    const projectsFrom = s => (s.projects ?? []).filter(p => !p.deletedAt).map(p => ({ id: p.id, name: p.title, directory: p.workspaceRoot ?? p.cwd ?? p.directory, workspaceRoots: p.workspaceRoots }));
    const grantFrom = s => ({ ...authority.check(principal.sid).grants.environments.find(e => e.alias === c.registro.alias), projects: projectsFrom(s) });
    const adapter = { ...c.adapter, projectForThread: async id => threadProject(shell, id) };
    const d = new Dispatcher({ gate: opGate, adapter, journal, environmentId: c.registro.environmentId, destination: c.registro.destination,
      authorizeRecorded: target => authorizeRecord(principal, c, target.action),
      dispatchPreflight: (pedido, { scope }) => preflightDespacho(pedido, fontesEscrita(conexoes, scope, { chamarImpl })),
      resolveGrant: async () => { shell = await liveShell(principal, c); opGate.operationGrant = grantFrom(shell); return opGate.operationGrant; },
      validateTarget: async ({ target, input, spec, validateWorkspace }) => {
        const latest = await liveShell(principal, c);
        for (const ref of spec.refs) {
          const p = threadProject(latest, input[ref]);
          if (!p) fail('thread_not_found');
          if (p !== threadProject(shell, input[ref])) fail('scope_denied');
        }
        opGate.operationGrant = grantFrom(latest);
        opGate.check(identity(principal), principal.sid, target);
        await validateWorkspace(opGate.operationGrant);
        // Filesystem canonicalization can await. Take the final live observation after it.
        const finalShell = await liveShell(principal, c);
        const finalGrant = grantFrom(finalShell);
        for (const ref of spec.refs) {
          if (threadProject(finalShell, input[ref]) !== threadProject(shell, input[ref])) fail('scope_denied');
        }
        for (const id of target.projectIds) {
          const before = opGate.operationGrant.projects.find(p => p.id === id);
          const after = finalGrant.projects.find(p => p.id === id);
          if (!after || JSON.stringify(before) !== JSON.stringify(after)) fail('scope_denied');
        }
        opGate.operationGrant = finalGrant;
        opGate.check(identity(principal), principal.sid, target);
      },
    });
    return { environment: { alias: c.registro.alias, environmentId: c.registro.environmentId }, ...await d.dispatch(identity(principal), principal.sid, { operationId, action, input }) };
  }
  // A write refused before sending (e.g. thread_not_found, workspace_scope_denied) is journaled
  // `rejected` without a target, and Dispatcher.reconcile cannot answer for it
  // (reconciliation_target_unknown). For that case only, answer locally that nothing was sent,
  // after the same authority checks dispatch makes (active session of the same caller, grant for
  // the environment and the action). The journal key is caller-bound, so another subject never
  // finds the record. Every other record goes to Dispatcher.reconcile unchanged; the lease path is
  // not touched.
  function rejectedBeforeSend(principal, c, operationId) {
    const caller = exigirIdentidade(identity(principal));
    const key = chaveOperacao({ environmentId: c.registro.environmentId, destination: c.registro.destination, caller, operationId });
    let record;
    try { record = journal.get(key); } catch { gate.close(); fail('journal_failed'); }
    if (!record || record.target || record.state !== 'rejected') return null;
    const authorize = () => {
      const status = gate.status(principal.sid);
      if (!status.active || status.scope.caller !== caller) fail('lease_closed');
      const grant = grantDoAmbiente(status.scope, { environmentId: c.registro.environmentId, destination: c.registro.destination });
      if (!grant) fail('ambiente_fora_da_lease');
      if (!grant.actions.includes(record.action)) fail('scope_denied');
    };
    authorize();
    // The audit is journal I/O: a failure fails closed like any journal failure.
    try { gate.audit({ event: 'reconciled_rejected', operationId: redact(operationId), sid: redact(principal.sid), action: record.action }); } catch { gate.close(); fail('journal_failed'); }
    // The audit sink may be reentrant (e.g. end the session); answer only if authority survived it.
    authorize();
    return { operationId, state: 'rejected', observation: null, sent: false };
  }

  async function reconcile(principal, { environment, operationId }) {
    const c = resolve(environment);
    const env = { alias: c.registro.alias, environmentId: c.registro.environmentId };
    if (all) {
      consented(authority, principal, c.registro);
      const caller = exigirIdentidade(identity(principal));
      let record;
      try { record = journal.get(chaveOperacao({ environmentId: c.registro.environmentId, destination: c.registro.destination, caller, operationId })); } catch { gate.close(); fail('journal_failed'); }
      if (!record) fail('operation_unknown');
      authorizeRecord(principal, c, record.action);
      if (!record.target && record.state !== 'rejected') fail('reconciliation_target_unknown');
      const observation = record.target ? z.object({ found: z.boolean(), sequence: z.number().int().nonnegative().optional(), threadId: z.string().optional(), state: z.enum(['running', 'completed', 'failed', 'unknown']).optional() }).strict().parse(await c.adapter.reconcile(record)) : null;
      authorizeRecord(principal, c, record.action);
      try { gate.audit({ event: 'reconciled', operationId: redact(operationId), sid: redact(principal.sid), action: record.action }); } catch { gate.close(); fail('journal_failed'); }
      authorizeRecord(principal, c, record.action);
      return { environment: env, operationId, state: record.state, observation, ...(!record.target ? { sent: false } : {}) };
    }
    const local = rejectedBeforeSend(principal, c, operationId);
    if (local) return { environment: env, ...local };
    return { environment: env, ...await dispatchers.get(c.registro.alias).reconcile(identity(principal), principal.sid, operationId) };
  }

  // Read-only full count of one project's threads, for the consented session.
  async function countThreads(principal, { environment, projectId }) {
    const c = resolve(environment);
    if (!projectAdmin) fail('scope_denied');
    const s = consented(authority, principal, c.registro);
    // The count belongs to project administration: only sessions consented with it.
    if (!s.grants.environments.find(e => e.alias === c.registro.alias)?.actions.some(a => PROJECT_ACTIONS.includes(a))) fail('scope_denied');
    const shell = await liveShell(principal, c);
    if (!(shell.projects ?? []).some(p => p.id === projectId && !p.deletedAt)) fail('scope_denied');
    if (!c.adapter.occupancy) fail('project_count_unavailable');
    let count;
    try { count = await c.adapter.occupancy(projectId); } catch { fail('project_count_incomplete'); }
    if (count?.complete && !count.projectLive) fail('scope_denied');
    consented(authority, principal, c.registro);
    return { environment: { alias: c.registro.alias, environmentId: c.registro.environmentId }, ...count };
  }

  // Native read wrappers (native.mjs): consented session, live projects of the environment only.
  async function nativeRead(principal, name, { environment, ...input }) {
    const c = resolve(environment);
    const s = consented(authority, principal, c.registro);
    if (!s.grants.environments.find(e => e.alias === c.registro.alias)?.actions.some(a => NATIVE_WRITE_ACTIONS.includes(a))) fail('scope_denied');
    if (!c.adapter.native) fail('environment_unavailable');
    const authorize = async ids => {
      if (!ids.length) return;
      const live = new Set(((await liveShell(principal, c)).projects ?? []).filter(p => !p.deletedAt).map(p => p.id));
      if (ids.some(id => !live.has(id))) fail('scope_denied');
    };
    const value = await NATIVE_READS[name].run({ input: NATIVE_READS[name].schema.parse(input), native: c.adapter.native, authorize });
    consented(authority, principal, c.registro);
    return value;
  }

  // t3_thread_inbox_update_batch (lote-inbox.mjs): one inbox action over several threads; every item
  // goes through `dispatch` above, so scope, journal and uncertainty rules are the singular ones.
  async function inboxBatch(principal, args, { signal, deadlineMs = batchDeadlineMs } = {}) {
    const lote = admitirLote(args, chave => resolve(chave).registro);
    const caller = exigirIdentidade(identity(principal));
    const store = (method, ...a) => { try { return journal[method](...a); } catch { gate.close(); return fail('journal_failed'); } };
    const status = () => { const s = gate.status(principal.sid); return s.active && s.scope.caller === caller ? s : null; };
    const itemError = c => ({ code: c, ...(BATCH_MESSAGES[c] ?? MESSAGES[c] ? { message: BATCH_MESSAGES[c] ?? MESSAGES[c] } : {}) });
    const itemCode = e => (e instanceof ForaDoEscopo ? 'environment_not_in_lease' : /^[a-z_]+$/.test(e?.message ?? '') ? code(e.message) : 'write_rejected');
    const grantFor = (s, env) => grantDoAmbiente(s.scope, { environmentId: env.environmentId, destination: env.destination });
    // Project of the target, read only after the environment and the action are authorized.
    async function projectOf(c, threadId) {
      if (all) { authorizeRecord(principal, c, lote.interna); return threadProject(await liveShell(principal, c), threadId); }
      const s = status() ?? fail('lease_closed');
      const grant = grantFor(s, c.registro) ?? fail('ambiente_fora_da_lease');
      if (!grant.actions.includes(lote.interna)) fail('scope_denied');
      return c.adapter.projectForThread(threadId);
    }
    async function executar(item) {
      const rejected = (c, stop) => ({ result: { status: 'rejected', error: itemError(c) }, ...(stop ? { stop } : {}) });
      if (!item.env) return rejected('environment_unknown');
      const c = porAlias.get(item.env.alias);
      try {
        const project = await projectOf(c, item.threadId);
        if (!project) return rejected('thread_not_found');
        if (project !== item.expectedProjectId) return rejected('precondition_failed');
      } catch (e) {
        if (!status()) return rejected('lease_closed', 'session_closed');
        return rejected(e instanceof ForaDoEscopo || /^[a-z_]+$/.test(e?.message ?? '') ? itemCode(e) : 'environment_unavailable');
      }
      const input = { threadId: item.threadId, ...(item.snoozedUntil !== undefined ? { snoozedUntil: item.snoozedUntil } : {}) };
      try {
        const r = await dispatch(principal, { environment: item.env.alias, action: lote.interna, operationId: item.operationId, input });
        // The Dispatcher answers a known operationId from the journal without sending again.
        if ('reconciliationRequired' in r) return { result: itemDoJournal(r) };
        return { result: { status: 'applied', receipt: r.receipt } };
      } catch (e) {
        const c = itemCode(e);
        if (c === 'reconciliation_required' || c === 'journal_failed') return { result: { status: 'uncertain', reconciliationRequired: true, error: itemError(c) }, stop: c === 'journal_failed' ? 'journal_failed' : 'uncertain_send' };
        if (!status()) return rejected(c, 'session_closed');
        return rejected(c);
      }
    }
    return executarLote(lote, {
      caller, store, signal, prazoMs: deadlineMs, executar, erro: itemError,
      autorizar: () => { status() ?? fail('lease_closed'); },
      // Recorded results are shown only to the same caller, still allowed to write this action there.
      autorizarReplay: itens => {
        const s = status() ?? fail('lease_closed');
        for (const item of itens.filter(i => i.env)) {
          const grant = grantFor(s, item.env) ?? fail('ambiente_fora_da_lease');
          if (!grant.actions.includes(lote.interna)) fail('scope_denied');
        }
      },
      observar: item => item.env ? store('get', chaveOperacao({ environmentId: item.env.environmentId, destination: item.env.destination, caller, operationId: item.operationId })) : undefined,
    });
  }

  const error = e => {
    // A native refusal keeps its native code and message (OrchestratorMcpFailure code or T3 error tag).
    if (e?.native) return { isError: true, content: [{ type: 'text', text: `${e.native.code}: ${e.native.message}` }] };
    const c = /^[a-z_]+$/.test(e.message) ? code(e.message) : 'write_rejected';
    const extra = c === 'environment_unknown' ? ` (configured: ${registros.map(r => r.alias).join(', ')})` : '';
    return { isError: true, content: [{ type: 'text', text: MESSAGES[c] ? `${c}: ${MESSAGES[c]}${extra}` : c }] };
  };
  const result = async op => { try { return { content: [{ type: 'text', text: JSON.stringify(await op()) }] }; } catch (e) { return error(e); } };
  const batchResult = async op => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await op()) }] }; } catch (e) {
      const c = /^[a-z_]+$/.test(e?.message ?? '') ? code(e.message) : null;
      if (!c || !BATCH_MESSAGES[c]) return error(e);
      const where = e instanceof LoteInvalido && e.detail !== undefined ? ` (item key ${JSON.stringify(e.detail)})` : '';
      return { isError: true, content: [{ type: 'text', text: `${c}: ${BATCH_MESSAGES[c]}${where}` }] };
    }
  };

  function registerTools(server, principal) {
    // Strict schemas: an unknown or legacy parameter (e.g. `ambiente`) is refused by the SDK.
    const environment = z.string().min(1).describe(`T3 environment where the thread/project lives (required; alias or environmentId): ${registros.map(r => r.alias).join(', ')}. IDs from one environment are not valid in another.`);
    // Project tools only for a session whose consent includes them (older grants never do).
    let granted = [];
    if (projectAdmin) { try { granted = PROJECT_ACTIONS.filter(a => authority.check(principal.sid).grants?.environments?.some(e => e.actions.includes(a))); } catch {} }
    let nativeGranted = [];
    if (nativeTools) { try { nativeGranted = NATIVE_WRITE_ACTIONS.filter(a => authority.check(principal.sid).grants?.environments?.some(e => e.actions.includes(a))); } catch {} }
    // Native names, native arguments under `input`; the operationId journals the write.
    for (const action of nativeGranted) server.registerTool(action, {
      description: `${NATIVE_WRITES[action].description} Chosen environment only.`,
      inputSchema: z.strictObject({ environment, operationId: z.string(), input: NATIVE_WRITES[action].schema }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, ({ environment: env, operationId, input }) => result(() => dispatch(principal, { environment: env, action, operationId, input })));
    if (nativeGranted.length) for (const [name, spec] of Object.entries(NATIVE_READS)) server.registerTool(name, {
      description: `${spec.description} Chosen environment only.`,
      inputSchema: spec.schema.extend({ environment }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    }, args => result(() => nativeRead(principal, name, args)));
    for (const action of [...ACTIONS, ...granted]) server.registerTool(writeToolName(action), {
      description: PROJECT_DESCRIPTIONS[action] ? `${describe(action)} Chosen environment only.` : `${describe(action)} in the chosen environment; authorized by the connector's OAuth session (passkey sign-in), ${all ? 'all current and future projects of the consented environments' : 'limited to the projects approved at sign-in (restricted mode)'}; authorization permits full-access; actions exposing runtimeMode accept an explicit T3 execution mode (default full-access).`,
      inputSchema: z.strictObject({ environment, operationId: z.string(), input: schemaForAction(action) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, ({ environment: env, operationId, input }) => result(() => dispatch(principal, { environment: env, action, operationId, input })));
    const batchItem = z.strictObject({
      key: z.string().min(1).max(200).describe('Your correlation label for this item (for example the thread title); unique in the call and echoed in its result'),
      environment,
      threadId: z.string().min(1).describe('Exact thread ID in that environment, from t3_thread_find_batch (candidates[].threadId), t3_buscar_threads or t3_thread; never a title'),
      expectedProjectId: z.string().min(1).describe('projectId of the thread as you observed it (candidates[].project.projectId); if the thread is not in that project the item is refused with precondition_failed and nothing is sent'),
      operationId: z.string().min(1).max(1024).describe('Stable ID of this item\'s write; new for every new intent, the same only when repeating the same call'),
      snoozedUntil: z.string().min(1).optional().describe('Required for snooze, refused for unsnooze: absolute ISO 8601 instant with Z or an explicit offset, for example 2026-10-06T09:00:00-03:00 (converted to UTC). Compute relative times such as "tomorrow 9:00" in the user\'s timezone before calling; items may have different instants'),
    });
    server.registerTool('t3_thread_inbox_update_batch', {
      description: `Applies one inbox action, snooze or unsnooze, to up to ${MAX_ITENS} threads in one call, with one result per item in the order sent. ` +
        'Use it only after every target is resolved to an exact (environment, threadId, projectId), for example with t3_thread_find_batch, and the user confirmed the selection; never pass a title or pick a candidate of an ambiguous match. ' +
        'snooze hides the thread from the inbox until snoozedUntil and does not interrupt or change its work; unsnooze brings it back now. ' +
        'Items run one at a time, best-effort, with no transaction: a refused item (thread_not_found, precondition_failed, scope_denied, environment_unknown, environment_unavailable) does not stop the others. An uncertain send, a closed session, a journal failure, a cancellation or the batch deadline stop the batch; `stopped` says why and the remaining items are not_started with nothing sent. ' +
        'Item `status`: applied (T3 acknowledged it), rejected (nothing was sent; `error` says why), uncertain (do not resend; call t3_reconciliar_escrita with its environment and operationId), not_started, replayed (this operationId was already recorded, so nothing was sent again; `originalStatus` says how it ended) or failed. ' +
        'Retries are safe: repeating the same call with the same batchId never sends again and returns the recorded results with replay=true, also after reconnecting (inProgress=true: the original call is still running or was interrupted, and its unrecorded items are never resumed); reusing a batchId with other items or values is refused (batch_conflict). To retry rejected or not_started items, re-read them and send a new batch with a new batchId and new operationIds. ' +
        'A repeated key, thread or operationId, or snoozedUntil missing/misplaced, rejects the whole call before anything is sent. `complete` true: every item has a known outcome (rejections included); `allSucceeded` true: every item was applied. ' +
        `Authorized by the connector's OAuth session; each item needs the action in the scope approved for its environment.`,
      inputSchema: z.strictObject({
        batchId: z.string().min(1).max(1024).describe('Stable ID of this batch intent, scoped to your session subject; repeat it only to repeat the exact same call'),
        action: z.enum(Object.keys(INBOX_ACTIONS)).describe('One inbox action for every item: snooze or unsnooze'),
        items: z.array(batchItem).min(1).max(MAX_ITENS).describe('Target threads, at most one item per thread'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, (args, extra) => batchResult(() => inboxBatch(principal, args, { signal: extra?.signal })));
    server.registerTool('t3_reconciliar_escrita', {
      description: 'Looks up the receipt of a write operation in the same environment; never repeats the mutation.',
      inputSchema: z.strictObject({ environment, operationId: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    }, ({ environment: env, operationId }) => result(() => reconcile(principal, { environment: env, operationId })));
    if (granted.length) server.registerTool('t3_contar_threads_projeto', {
      description: 'Counts every live thread of one project: active, archived, without a run, and busy (active run or pending request). threadsDigest identifies the exact set of threads counted; a force delete must pass it with the total. complete=false (total null) when the reads did not agree or a row was malformed; never reported as zero.',
      inputSchema: z.strictObject({ environment, projectId: z.string().min(1) }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    }, ({ environment: env, projectId }) => result(() => countThreads(principal, { environment: env, projectId })));
  }

  return { gate, inventory, dispatch, inboxBatch, reconcile, registerTools, close() { for (const c of conexoes) c.fechar?.(); } };
}
