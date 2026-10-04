import { randomBytes } from 'node:crypto';

// Server-side source of truth for OAuth sessions. The AS consults it before issuing or refreshing
// tokens and the RS consults it on every request, so idle expiry, revocation and the kill switch
// take effect even while an access or refresh token is still nominally valid.
//
// Time: every interval is measured on two clocks and the larger elapsed value wins. A monotonic
// clock that stops during suspend cannot rejuvenate a session, and a wall clock moved backwards
// cannot either. Elapsed time is accumulated per observation, so a wall rollback after a suspend
// cannot give back time that was already counted (it errs on the side of counting more when the
// clocks diverge). An interval never observed, e.g. suspend and rollback both while nobody asked,
// cannot be reconstructed by any two-clock scheme. A terminal session never becomes active again.
export const IDLE_MS = 60 * 60 * 1000;
const deepFreeze = o => { if (o && typeof o === 'object') { for (const v of Object.values(o)) deepFreeze(v); Object.freeze(o); } return o; };

export function stopwatch({ clock = () => performance.now(), wall = () => Date.now() } = {}) {
  // A mark accumulates elapsed time observation by observation: each read adds the larger of the
  // two clocks' advances since the previous read (never a negative advance).
  const mark = () => ({ mono: clock(), wall: wall(), acc: 0 });
  const elapsed = m => {
    const mono = clock(), w = wall();
    m.acc += Math.max(mono - m.mono, w - m.wall, 0);
    m.mono = Math.max(m.mono, mono); m.wall = Math.max(m.wall, w);
    return m.acc;
  };
  return { mark, elapsed };
}

export class SessionAuthority {
  #sessions = new Map();
  #killed = false;
  #epoch = 0;
  #listeners = new Set();
  constructor({ idleMs = IDLE_MS, maxAgeMs = 0, clock, wall, audit = () => {} } = {}) {
    if (!(idleMs > 0)) throw new Error('invalid_idle');
    if (!(maxAgeMs >= 0)) throw new Error('invalid_max_age');
    Object.assign(this, { idleMs, maxAgeMs, audit, time: stopwatch({ clock, wall }) });
  }
  get killed() { return this.#killed; }
  // Increments on revoke-all and on the kill switch. Pending sign-ins record it and are refused at
  // approval and at resume when it changed, so authorization approved before a global reset cannot
  // create a session afterwards.
  get epoch() { return this.#epoch; }
  // Called with (sid, reason) once, when a session becomes terminal, so token stores can purge it.
  onTerminal(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  // A session starts right after a verified passkey ceremony; that instant is its first activity.
  // `grants` is the policy frozen at consent time (environments/actions; projects only in restricted mode); refresh
  // never changes it.
  create({ sub, clientId, credentialId, scope, resource, grants = null }) {
    if (this.#killed) throw new Error('kill_switch');
    for (const [k, v] of Object.entries({ sub, clientId, credentialId, scope, resource })) if (typeof v !== 'string' || !v) throw new Error(`invalid_${k}`);
    const sid = randomBytes(18).toString('base64url'), at = this.time.mark();
    this.#sessions.set(sid, { sid, sub, clientId, credentialId, scope, resource, grants: grants && deepFreeze(structuredClone(grants)), created: at, lastActivity: at, terminal: null });
    this.audit({ event: 'session_created', sid, clientId, credentialId });
    return sid;
  }

  #end(s, reason) {
    if (s.terminal) return;
    s.terminal = reason;
    this.audit({ event: 'session_ended', sid: s.sid, reason });
    for (const l of this.#listeners) { try { l(s.sid, reason); } catch {} }
  }

  #live(sid) {
    const s = this.#sessions.get(sid);
    if (!s) throw new Error('session_unknown');
    if (!s.terminal) {
      if (this.#killed) this.#end(s, 'kill_switch');
      else if (this.time.elapsed(s.lastActivity) >= this.idleMs) this.#end(s, 'idle_expired');
      else if (this.maxAgeMs && this.time.elapsed(s.created) >= this.maxAgeMs) this.#end(s, 'max_age');
    }
    if (s.terminal) throw new Error(`session_${s.terminal}`);
    return s;
  }

  // Read-only check: refresh, ping, initialize and tools/list use this and never extend the session.
  check(sid) { return this.#view(this.#live(sid)); }

  // Eligible activity (an authorized tools/call): checks, then restarts the idle window.
  admit(sid) {
    const s = this.#live(sid);
    s.lastActivity = this.time.mark();
    return this.#view(s);
  }

  // Milliseconds until the session ends unless there is new eligible activity.
  remainingMs(sid) {
    const s = this.#live(sid);
    const idle = this.idleMs - this.time.elapsed(s.lastActivity);
    return Math.max(0, this.maxAgeMs ? Math.min(idle, this.maxAgeMs - this.time.elapsed(s.created)) : idle);
  }

  revoke(sid, reason = 'revoked') {
    const s = this.#sessions.get(sid);
    if (!s) return false;
    const was = !s.terminal;
    this.#end(s, reason);
    return was;
  }
  revokeAll(reason = 'revoked') { this.#epoch++; let n = 0; for (const s of this.#sessions.values()) if (!s.terminal) { this.#end(s, reason); n++; } return n; }

  // Kill switch: ends every session and refuses new ones until released. Releasing it does not
  // revive anything; new sessions need a new passkey ceremony.
  kill() { this.#killed = true; this.audit({ event: 'kill_switch', on: true }); return this.revokeAll('kill_switch'); }
  release() { this.#killed = false; this.audit({ event: 'kill_switch', on: false }); }

  list() {
    return [...this.#sessions.values()].map(s => {
      let state = 'active';
      try { this.#live(s.sid); } catch (e) { state = e.message.replace(/^session_/, ''); }
      return { ...this.#view(s), state, idleSeconds: Math.round(this.time.elapsed(s.lastActivity) / 1000), ageSeconds: Math.round(this.time.elapsed(s.created) / 1000) };
    });
  }

  // Drops terminal sessions; their tokens are already purged through onTerminal.
  sweep() { for (const s of [...this.#sessions.values()]) { try { this.#live(s.sid); } catch { this.#sessions.delete(s.sid); } } }

  #view(s) { return { sid: s.sid, sub: s.sub, clientId: s.clientId, credentialId: s.credentialId, scope: s.scope, resource: s.resource, grants: s.grants }; }
}
