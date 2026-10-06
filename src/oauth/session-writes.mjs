import { z } from 'zod';
import { Dispatcher, ACTIONS, schemaForAction, parseAction, chaveOperacao, SEND_DESCRIPTION, LAUNCH_DESCRIPTION } from '../escrita/adapters.mjs';
import { grantDoAmbiente } from '../escrita/gate.mjs';
import { grantFromInventory, escopoDosGrants } from '../escrita/scope.mjs';
import { identidadeSessaoOAuth, exigirIdentidade } from '../escrita/identidade.mjs';
import { resolverAmbiente } from '../escrita/config.mjs';
import { consentAll, consented } from './project-policy.mjs';
import { redact } from './http.mjs';
import { PROJECT_ACTIONS } from '../escrita/project-admin.mjs';
import { NATIVE_WRITES, NATIVE_WRITE_ACTIONS, NATIVE_READS, ENV_SCOPED } from '../escrita/native.mjs';

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
  project_confirmation_mismatch: 'confirmProjectId must repeat the exact projectId; nothing was sent',
  project_has_active_work: 'a thread of the project has an active run or a pending request; nothing was sent. Interrupt or finish it first',
};
const PROJECT_DESCRIPTIONS = {
  'project.delete': 'Deletes an EMPTY project (no active or archived threads) from T3. Refused if any thread exists; never escalates to force. The workspace directory on disk is kept.',
  'project.delete-force': 'Deletes a project AND all its threads (active and archived), cancelling their pending work. Only on an explicit request to delete the project with its threads: requires force=true, confirmProjectId equal to projectId and expectedThreadCount from t3_contar_threads_projeto; refused if the count changed or a thread has an active run. The workspace directory on disk is kept.',
};
const describe = action => PROJECT_DESCRIPTIONS[action] ?? (action === 'thread.send' ? SEND_DESCRIPTION
  : action === 'thread.launch' ? LAUNCH_DESCRIPTION
  : action === 'runtime-request.answer' ? 'Answers a pending user_input runtime request using requestId and answers keyed by question ID from t3_thread.pedidosPendentes; thread.send does NOT answer it.'
  : action === 'runtime-request.approve' ? 'Responds to a pending approval runtime request using requestId and decision from t3_thread.pedidosPendentes; user_input requires runtime-request.answer instead.'
  : action);
export const writeToolName = action => `t3_escrever_${action.replaceAll('.', '_').replaceAll('-', '_')}`;

// In restricted mode, `allowedProjects` (Map alias → Set of project ids) narrows the sign-in grant
// to those projects; an environment without an entry gets no grant. Without it the grant is the
// full inventory, as with the lease.
export function sessionWrites({ conexoes, journal, authority, issuer, allowedProjects = null, inventoryMs = 15000, projectPolicy = 'restricted', projectAdmin = false, nativeTools = false, audit = e => journal.audit(e) }) {
  const all = projectPolicy === 'all';
  if (projectAdmin && !all) throw new Error('OAuth project administration requires projectPolicy all');
  if (nativeTools && !all) throw new Error('OAuth native tools require projectPolicy all');
  if (all && allowedProjects) throw new Error('OAuth all conflicts with allowedProjects');
  const gate = new SessionWriteGate({ authority, issuer, audit });
  const registros = conexoes.map(c => c.registro);
  const porAlias = new Map(conexoes.map(c => [c.registro.alias, c]));
  const dispatchers = new Map(all ? [] : conexoes.map(c => [c.registro.alias, new Dispatcher({ gate, adapter: c.adapter, journal, environmentId: c.registro.environmentId, destination: c.registro.destination })]));
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
    const threadProject = (s, id) => s.threads?.find(t => t.id === id && !t.deletedAt)?.projectId;
    const adapter = { ...c.adapter, projectForThread: async id => threadProject(shell, id) };
    const d = new Dispatcher({ gate: opGate, adapter, journal, environmentId: c.registro.environmentId, destination: c.registro.destination,
      authorizeRecorded: target => authorizeRecord(principal, c, target.action),
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
    const s = consented(authority, principal, c.registro);
    // The count belongs to project administration: only sessions consented with it.
    if (!s.grants.environments.find(e => e.alias === c.registro.alias)?.actions.some(a => PROJECT_ACTIONS.includes(a))) fail('scope_denied');
    const shell = await liveShell(principal, c);
    if (!(shell.projects ?? []).some(p => p.id === projectId && !p.deletedAt)) fail('scope_denied');
    if (!c.adapter.occupancy) fail('project_count_unavailable');
    let count;
    try { count = await c.adapter.occupancy(projectId); } catch { fail('project_count_incomplete'); }
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

  const error = e => {
    // A native refusal keeps its native code and message (OrchestratorMcpFailure code or T3 error tag).
    if (e?.native) return { isError: true, content: [{ type: 'text', text: `${e.native.code}: ${e.native.message}` }] };
    const c = /^[a-z_]+$/.test(e.message) ? code(e.message) : 'write_rejected';
    const extra = c === 'environment_unknown' ? ` (configured: ${registros.map(r => r.alias).join(', ')})` : '';
    return { isError: true, content: [{ type: 'text', text: MESSAGES[c] ? `${c}: ${MESSAGES[c]}${extra}` : c }] };
  };
  const result = async op => { try { return { content: [{ type: 'text', text: JSON.stringify(await op()) }] }; } catch (e) { return error(e); } };

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
    server.registerTool('t3_reconciliar_escrita', {
      description: 'Looks up the receipt of a write operation in the same environment; never repeats the mutation.',
      inputSchema: z.strictObject({ environment, operationId: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    }, ({ environment: env, operationId }) => result(() => reconcile(principal, { environment: env, operationId })));
    if (granted.length) server.registerTool('t3_contar_threads_projeto', {
      description: 'Counts every live thread of one project: active, archived, without a run, and busy (active run or pending request). complete=false (total null) when the active and archived reads did not agree; never reported as zero.',
      inputSchema: z.strictObject({ environment, projectId: z.string().min(1) }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    }, ({ environment: env, projectId }) => result(() => countThreads(principal, { environment: env, projectId })));
  }

  return { gate, inventory, dispatch, reconcile, registerTools, close() { for (const c of conexoes) c.fechar?.(); } };
}
