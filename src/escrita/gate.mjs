import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { exigirIdentidade } from './identidade.mjs';
export const TTL = 60 * 60 * 1000;
const opaque = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const fail = code => { throw new Error(code); };

// Escopo v2: um grant por environment. Autorização é sempre pelo par
// (environmentId, projectId); projectId sozinho não vale entre environments.
export function validarEscopo(scope) {
  if (scope?.scopeVersion !== 2 || scope.runtimeMode !== 'full-access' || !scope.environments?.length) fail('invalid_scope');
  const ids = new Set();
  for (const e of scope.environments) {
    if (!e.alias || !e.environmentId || !e.destination || !e.projects?.length || !e.actions?.length || ids.has(e.environmentId)) fail('invalid_scope');
    ids.add(e.environmentId);
  }
}
export function grantDoAmbiente(scope, { environmentId, destination }) {
  return scope.environments.find(e => e.environmentId === environmentId && e.destination === destination);
}

// In-memory authorization: a new process always starts closed. No timer cancels work.
export class Gate {
  #requests = new Map(); #leases = new Map(); #epoch = 0;
  constructor({ clock = () => performance.now(), wall = () => Date.now(), audit, verify }) {
    if (!audit || !verify) fail('dependencies_required');
    Object.assign(this, { clock, wall, verify });
    this.audit = event => { try { audit(event); } catch { this.close(); throw new Error('audit_failed'); } };
    this.bootId = randomUUID();
  }
  #active(lease) {
    if(lease.closed)return false;
    if(this.clock()>=lease.deadline || this.wall()>=lease.expiresAt) {
      lease.closed=true;
      this.audit({event:'lease_expired',leaseId:lease.id,caller:lease.caller,bootId:this.bootId});
      return false;
    }
    return true;
  }
  request(identity, scope) {
    const caller = exigirIdentidade(identity);
    for (const [id,r] of this.#requests) if (r.deadline <= this.clock()) this.#requests.delete(id);
    if (this.#requests.size >= 32) fail('too_many_requests');
    for (const l of this.#leases.values()) if (l.caller === caller && this.#active(l)) fail('lease_already_active');
    validarEscopo(scope);
    const approvedScope = copy({ ...scope, durationMinutes: 60, caller });
    const id = opaque();
    this.#requests.set(id, { id, scope: approvedScope, scopeHash: digest(approvedScope), deadline: this.clock()+120000, epoch: this.#epoch });
    this.audit({ event: 'approval_requested', requestId: id, caller, scopeHash: digest(approvedScope), scope: copy(approvedScope), bootId: this.bootId });
    return this.view(id);
  }
  view(id) {
    const r = this.#requests.get(id);
    if (!r || r.deadline <= this.clock()) fail('request_invalid');
    return { requestId: id, scope: copy(r.scope), scopeHash: r.scopeHash };
  }
  challenge(id, origin) {
    const r = this.#requests.get(id); this.view(id);
    if (r.challenge) fail('challenge_already_issued');
    r.challenge = opaque(); r.origin = origin;
    return r.challenge;
  }
  async approve(id, { response, origin }) {
    const r = this.#requests.get(id); this.view(id);
    if (!r.challenge || r.origin !== origin) fail('challenge_invalid');
    // Consume before crypto awaits: concurrent/replayed assertions cannot grant twice.
    this.#requests.delete(id);
    const epoch = this.#epoch;
    const credentialId = await this.verify({ response, challenge: r.challenge, origin });
    if (epoch !== this.#epoch || r.epoch !== this.#epoch || r.deadline <= this.clock()) fail('request_invalid');
    for (const l of this.#leases.values()) if (l.caller === r.scope.caller && this.#active(l)) fail('lease_already_active');
    const lease = { id: opaque(), caller: r.scope.caller, scope: r.scope, scopeHash:r.scopeHash, credentialId, deadline: this.clock()+TTL, expiresAt:this.wall()+TTL, bootId:this.bootId };
    this.audit({ event:'lease_granted', leaseId:lease.id, caller:lease.caller, scopeHash:lease.scopeHash, expiresAt:lease.expiresAt, credentialId, bootId:this.bootId });
    this.#leases.set(lease.id,lease);
    return this.status(lease.id);
  }
  status(id) {
    const l = this.#leases.get(id);
    if (!l) fail('lease_closed');
    return { leaseId:l.id, active:this.#active(l), expiresAt:l.expiresAt, remainingMs:l.closed?0:Math.max(0,Math.min(l.deadline-this.clock(),l.expiresAt-this.wall())), scope:copy(l.scope), scopeHash:l.scopeHash, credentialId:l.credentialId };
  }
  statusFor(identity) {
    const caller=exigirIdentidade(identity);
    for(const lease of this.#leases.values())if(lease.caller===caller&&this.#active(lease))return this.status(lease.id);
    return {active:false};
  }
  check(identity, id, { environmentId, destination, projectIds, action }) {
    const caller=exigirIdentidade(identity), l=this.#leases.get(id);
    if (!l || l.caller !== caller || !this.#active(l)) fail('lease_closed');
    const grant = grantDoAmbiente(l.scope, { environmentId, destination });
    if (!grant) fail('ambiente_fora_da_lease');
    if (!grant.actions.includes(action) || !projectIds.length || projectIds.some(p=>!grant.projects.some(s=>s.id===p))) fail('scope_denied');
    return l;
  }
  dispatch(identity,id,target,invoke,operationId) {
    const l=this.check(identity,id,target);
    this.audit({ event:'dispatch', operationId, leaseId:id, caller:l.caller, action:target.action, projects:target.projectIds, scopeHash:l.scopeHash, bootId:this.bootId });
    // No await between final authorization and the one outbound invocation.
    this.check(identity,id,target);
    return invoke();
  }
  revoke(id,credentialId) {
    const l=this.#leases.get(id);
    if (!l || l.credentialId!==credentialId) fail('lease_closed');
    this.audit({ event:'lease_revoked', leaseId:id, caller:l.caller, bootId:this.bootId });
    this.#leases.delete(id); this.#epoch++;
    this.#requests.clear();
  }
  close() { this.#leases.clear(); this.#requests.clear(); this.#epoch++; }
}
