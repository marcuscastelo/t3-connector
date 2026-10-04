import { createHash, randomBytes } from 'node:crypto';
import { stopwatch } from './session-authority.mjs';
import { CEREMONY_MS } from './passkeys.mjs';
import { limited } from './limits.mjs';
const hash = v => createHash('sha256').update(String(v)).digest('base64url');
const bad = () => { throw limited('enrollment_invalid', 400); };

// One ephemeral digest-only capability. Possession is necessary, and the first claim fixes the
// browser cookie for its whole generation. Invalid guesses never consume the operator's ticket.
export class PublicEnrollment {
  #record = null;
  #generation = 0;
  constructor({ authority, origin, rpID, subject, clock, wall }) { Object.assign(this, { authority, origin, rpID, subject, time: stopwatch({ clock, wall }) }); }
  invalidate() { this.#record = null; this.#generation++; }
  get active() {
    const r = this.#record;
    if (r && (this.authority.killed || r.epoch !== this.authority.epoch || this.time.elapsed(r.at) >= 900_000)) this.invalidate();
    return !!this.#record;
  }
  issue() {
    if (this.authority.killed) throw limited('kill_switch', 400);
    const ticket = randomBytes(16).toString('base64url');
    this.#record = { digest: hash(ticket), generation: ++this.#generation, epoch: this.authority.epoch, at: this.time.mark(), state: 'issued', cookieHash: null, options: 0, failures: 0, lastOption: null, challenge: null };
    return `${this.origin}/enroll#ticket=${ticket}`;
  }
  #match(ticket, cookie) {
    if (!this.active || typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(ticket) || typeof cookie !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) bad();
    const r = this.#record;
    if (r.digest !== hash(ticket) || (r.cookieHash && r.cookieHash !== hash(cookie))) bad();
    return r;
  }
  assert(r) { if (!this.active || this.#record !== r || r.generation !== this.#generation || r.state !== 'committing') bad(); }
  options(ticket, cookie) {
    const r = this.#match(ticket, cookie);
    if (r.state === 'committing') bad();
    if (r.options >= 5) { this.invalidate(); throw limited('options_exhausted'); }
    if (r.lastOption && this.time.elapsed(r.lastOption) < 1000) throw limited();
    r.cookieHash ??= hash(cookie); r.state = 'claimed'; r.options++; r.lastOption = this.time.mark();
    const value = randomBytes(32).toString('base64url');
    r.challenge = { value, at: this.time.mark(), purpose: 'public-enrollment', origin: this.origin, rpID: this.rpID, generation: r.generation, cookieHash: r.cookieHash, subject: this.subject };
    return value;
  }
  take(ticket, cookie) {
    const r = this.#match(ticket, cookie), c = r.challenge;
    r.challenge = null;
    if (r.state !== 'claimed' || !c || this.time.elapsed(c.at) >= CEREMONY_MS) bad();
    r.state = 'committing';
    return { challenge: c.value, guard: () => { this.assert(r); if (this.time.elapsed(c.at) >= CEREMONY_MS) bad(); },
      committed: () => { this.assert(r); this.invalidate(); },
      failed: () => { if (this.#record !== r) return; r.failures++; if (r.failures >= 5) this.invalidate(); else r.state = 'claimed'; } };
  }
}
