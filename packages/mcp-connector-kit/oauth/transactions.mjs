import { createHash, randomBytes, randomInt } from 'node:crypto';
import { stopwatch } from './session-authority.mjs';

// Login transactions created by /authorize. A transaction holds everything the AS validated
// (client, exact callback, PKCE challenge, resource, scope, state) server side. The browser only
// carries opaque handles, none of which authorizes anything alone:
//   - cookie: binds the transaction to the browser that started it (public origin);
//   - handoff: lets the local control-plane find the transaction (fragment of the localhost URL);
//   - oob: short code for the out-of-band fallback (type it into the local page);
//   - resume: issued only after a verified passkey ceremony, single use, and still needs the cookie.
export const TX_TTL_MS = 5 * 60 * 1000;
const OOB_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const hash = v => createHash('sha256').update(String(v)).digest('base64url');
const token = (n = 24) => randomBytes(n).toString('base64url');

export class LoginTransactions {
  #txs = new Map();
  constructor({ ttlMs = TX_TTL_MS, clock, wall, maxSize = 128 } = {}) { Object.assign(this, { ttlMs, maxSize, time: stopwatch({ clock, wall }) }); }

  create(request) {
    this.sweep();
    if (this.#txs.size >= this.maxSize) throw Object.assign(new Error('transaction_capacity'), { status: 429 });
    const id = token(), cookie = token(), handoff = token(), statusId = token(12);
    let oob;
    do { oob = Array.from({ length: 8 }, () => OOB_ALPHABET[randomInt(OOB_ALPHABET.length)]).join(''); } while ([...this.#txs.values()].some(t => t.oob === oob));
    const tx = { id, statusId, ...request, cookieHash: hash(cookie), handoffHash: hash(handoff), oob, created: this.time.mark(), approved: null, resumeHash: null, done: false };
    this.#txs.set(id, tx);
    return { tx, cookie, handoff };
  }

  #live(tx) { return tx && this.#txs.get(tx.id) === tx && !tx.done && this.time.elapsed(tx.created) < this.ttlMs ? tx : null; }

  // Local control-plane lookup, by handoff (from the URL fragment) or by the out-of-band code.
  find({ handoff, oob }) {
    let tx = null;
    if (typeof handoff === 'string' && handoff) { const h = hash(handoff); tx = [...this.#txs.values()].find(t => t.handoffHash === h); }
    else if (typeof oob === 'string' && oob) { const code = oob.trim().toUpperCase(); tx = [...this.#txs.values()].find(t => t.oob === code); }
    tx = this.#live(tx);
    if (!tx || tx.approved || tx.mode === 'public') throw new Error('transaction_not_found');
    return tx;
  }

  remaining(tx) { if (!this.#live(tx)) throw new Error('transaction_not_found'); return this.ttlMs - this.time.elapsed(tx.created); }
  assert(tx, authority) {
    if (!this.#live(tx) || tx.approved || authority.killed || tx.epoch !== authority.epoch) throw new Error('transaction_not_found');
    return tx;
  }
  findPublic(statusId, cookie, authority) {
    if (typeof statusId !== 'string' || statusId.length > 64 || typeof cookie !== 'string' || cookie.length > 64) throw new Error('transaction_not_found');
    const tx = [...this.#txs.values()].find(t => t.statusId === statusId);
    if (!tx || tx.mode !== 'public' || tx.cookieHash !== hash(cookie)) throw new Error('transaction_not_found');
    return this.assert(tx, authority);
  }
  cancel(tx) { if (this.#txs.get(tx?.id) === tx) { tx.done = true; this.#txs.delete(tx.id); } }
  cancelPublic() { for (const tx of this.#txs.values()) if (tx.mode === 'public') this.cancel(tx); }
  cancelBrowser(cookie) { const h = hash(cookie ?? ''); for (const tx of this.#txs.values()) if (tx.mode === 'public' && tx.cookieHash === h) this.cancel(tx); }
  cancelCredential(rpID, credentialId, origin) {
    for (const tx of this.#txs.values()) for (const a of [tx.approved, tx.authenticated]) {
      if (a?.credentialId === credentialId && (a.credentialRp ?? 'localhost') === rpID && (origin === undefined || a.credentialOrigin === origin)) this.cancel(tx);
    }
  }

  // After a verified passkey ceremony. Returns the single-use resume handle.
  approve(tx, approval) {
    if (!this.#live(tx) || tx.approved) throw new Error('transaction_not_found');
    const resume = token();
    Object.assign(tx, { approved: approval, resumeHash: hash(resume), oob: null, handoffHash: null });
    return resume;
  }

  // Public page polling (out-of-band mode): requires the transaction cookie.
  status(statusId, cookie) {
    const tx = [...this.#txs.values()].find(t => t.statusId === statusId);
    if (!tx || hash(cookie ?? '') !== tx.cookieHash) throw new Error('transaction_cookie_mismatch');
    if (!this.#live(tx)) return { error: 'expired' };
    return tx.approved ? { approved: true } : { pending: true };
  }

  // /resume: either the resume handle (button/302 modes) or the status id after approval
  // (out-of-band mode), always together with the cookie of the browser that started the login.
  consume({ resume, statusId, cookie }) {
    let tx = null;
    if (typeof resume === 'string' && resume) { const h = hash(resume); tx = [...this.#txs.values()].find(t => t.resumeHash === h); }
    else if (typeof statusId === 'string' && statusId) tx = [...this.#txs.values()].find(t => t.statusId === statusId);
    if (!this.#live(tx) || !tx.approved || hash(cookie ?? '') !== tx.cookieHash) throw new Error('transaction_invalid');
    tx.done = true;
    this.#txs.delete(tx.id);
    return tx;
  }

  sweep() { for (const [id, tx] of this.#txs) if (!this.#live(tx)) this.#txs.delete(id); }
  get size() { return this.#txs.size; }
}
