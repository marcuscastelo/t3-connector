import { z } from 'zod';
import { Dispatcher, ACTIONS, schemaForAction, parseAction, SEND_DESCRIPTION } from '../escrita/adapters.mjs';
import { grantDoAmbiente } from '../escrita/gate.mjs';
import { grantFromInventory, escopoDosGrants } from '../escrita/scope.mjs';
import { identidadeSessaoOAuth, exigirIdentidade } from '../escrita/identidade.mjs';
import { resolverAmbiente } from '../escrita/config.mjs';
import { redact } from './http.mjs';

// T3 writes authorized by an OAuth session instead of a passkey lease. The existing Dispatcher
// (journal reservation, target/workspace preflight, uncertainty handling, final synchronous check
// right before the single outbound call) is reused unchanged; only its structural `gate` is
// replaced by SessionWriteGate, keyed by session id. The lease Gate is never consulted, created or
// extended here, and a lease id is never accepted as a session id (they live in different stores).
//
// Scope: the grants are the inventory frozen when the user approved the sign-in with a passkey
// (same snapshot rule as the lease). Refresh never changes them; new projects need a new sign-in.

const fail = code => { throw new Error(code); };

export class SessionWriteGate {
  constructor({ authority, issuer, audit = () => {}, onClose = () => {} }) { Object.assign(this, { authority, issuer, auditSink: audit, onClose }); }
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
    if (!grant.actions.includes(action) || !projectIds.length || projectIds.some(p => !grant.projects.some(g => g.id === p))) fail('scope_denied');
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
};
const describe = action => action === 'thread.send' ? SEND_DESCRIPTION
  : action === 'runtime-request.answer' ? 'Answers a pending user_input runtime request using requestId and answers keyed by question ID from t3_thread.pedidosPendentes; thread.send does NOT answer it.'
  : action === 'runtime-request.approve' ? 'Responds to a pending approval runtime request using requestId and decision from t3_thread.pedidosPendentes; user_input requires runtime-request.answer instead.'
  : action;
export const writeToolName = action => `t3_escrever_${action.replaceAll('.', '_').replaceAll('-', '_')}`;

// `allowedProjects` (optional, Map alias → Set of project ids) narrows the grant offered at sign-in
// to those projects; an environment without an entry gets no grant. Without it the grant is the
// full inventory, as with the lease.
export function sessionWrites({ conexoes, journal, authority, issuer, allowedProjects = null, inventoryMs = 15000, audit = e => journal.audit(e) }) {
  const gate = new SessionWriteGate({ authority, issuer, audit });
  const registros = conexoes.map(c => c.registro);
  const porAlias = new Map(conexoes.map(c => [c.registro.alias, c]));
  const dispatchers = new Map(conexoes.map(c => [c.registro.alias, new Dispatcher({ gate, adapter: c.adapter, journal, environmentId: c.registro.environmentId, destination: c.registro.destination })]));
  const identity = principal => identidadeSessaoOAuth({ issuer, subject: principal.sub });
  const resolve = chave => porAlias.get(resolverAmbiente(registros, chave).alias);

  // Inventory of every environment now; unavailable ones get no grant (same rule as the lease).
  async function inventory() {
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

  async function dispatch(principal, { environment, action, operationId, input }) {
    const c = resolve(environment);
    await precheck(principal, c, action, input);
    return { environment: { alias: c.registro.alias, environmentId: c.registro.environmentId }, ...await dispatchers.get(c.registro.alias).dispatch(identity(principal), principal.sid, { operationId, action, input }) };
  }
  async function reconcile(principal, { environment, operationId }) {
    const c = resolve(environment);
    return { environment: { alias: c.registro.alias, environmentId: c.registro.environmentId }, ...await dispatchers.get(c.registro.alias).reconcile(identity(principal), principal.sid, operationId) };
  }

  const error = e => {
    const c = /^[a-z_]+$/.test(e.message) ? code(e.message) : 'write_rejected';
    const extra = c === 'environment_unknown' ? ` (configured: ${registros.map(r => r.alias).join(', ')})` : '';
    return { isError: true, content: [{ type: 'text', text: MESSAGES[c] ? `${c}: ${MESSAGES[c]}${extra}` : c }] };
  };
  const result = async op => { try { return { content: [{ type: 'text', text: JSON.stringify(await op()) }] }; } catch (e) { return error(e); } };

  function registerTools(server, principal) {
    // Strict schemas: an unknown or legacy parameter (e.g. `ambiente`) is refused by the SDK.
    const environment = z.string().min(1).describe(`T3 environment where the thread/project lives (required; alias or environmentId): ${registros.map(r => r.alias).join(', ')}. IDs from one environment are not valid in another.`);
    for (const action of ACTIONS) server.registerTool(writeToolName(action), {
      description: `${describe(action)} in the chosen environment; authorized by the connector's OAuth session (passkey sign-in), limited to the projects approved at sign-in; the work runs in full-access mode.`,
      inputSchema: z.strictObject({ environment, operationId: z.string(), input: schemaForAction(action) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, ({ environment: env, operationId, input }) => result(() => dispatch(principal, { environment: env, action, operationId, input })));
    server.registerTool('t3_reconciliar_escrita', {
      description: 'Looks up the receipt of a write operation in the same environment; never repeats the mutation.',
      inputSchema: z.strictObject({ environment, operationId: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    }, ({ environment: env, operationId }) => result(() => reconcile(principal, { environment: env, operationId })));
  }

  return { gate, inventory, dispatch, reconcile, registerTools, close() { for (const c of conexoes) c.fechar?.(); } };
}
