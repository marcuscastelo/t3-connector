import { Passkeys } from '../escrita/webauthn.mjs';
import { stopwatch } from './session-authority.mjs';

const reject = (code, status = 400) => { throw Object.assign(new Error(code), { status }); };
export const CEREMONY_MS = 120_000;
export const MAX_CREDENTIALS = 32;
export const TRANSPORTS = ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'];

// The OAuth wrapper keeps the Ponte crypto abstraction unchanged. All credential mutations
// share one bounded queue per RP; a synchronous guarded save is the only durable commit point.
export class OAuthPasskeys {
  #chain = Promise.resolve();
  #pending = 0;
  #activeGuard = null;
  #versions = new Map();
  #disabled = new Set();
  #serial = 0;
  constructor({ persist, credentials = new Map(), clock, wall, deadlineMs = 10_000, maxPending = 9, ...options }) {
    Object.assign(this, { credentials, persist, deadlineMs, maxPending, time: stopwatch({ clock, wall }), origin: options.origin, rpID: options.rpID });
    if (credentials.size > MAX_CREDENTIALS) reject('credential_capacity');
    this.crypto = new Passkeys({ ...options, credentials, saveCredential: c => {
      this.#activeGuard();
      const next = new Map(credentials); next.set(c.id, c);
      // persist must be synchronous: no reset/removal can intervene after the guard.
      const result = persist(next);
      if (result?.then) reject('synchronous_persistence_required');
      if (!credentials.has(c.id)) this.#versions.set(c.id, ++this.#serial);
    } });
  }
  version(id) { return this.#versions.get(id) ?? 0; }
  current(id, version = this.version(id)) { return this.credentials.has(id) && !this.#disabled.has(id) && this.version(id) === version; }
  #run(work, guard = () => {}, committed = () => {}) {
    if (this.#pending >= this.maxPending) return Promise.reject(Object.assign(new Error('verification_overload'), { status: 429 }));
    this.#pending++;
    const at = this.time.mark(); let expired = false, timer;
    const check = () => { if (expired || this.time.elapsed(at) >= this.deadlineMs) reject('verification_timeout', 408); guard(); };
    const operation = this.#chain.then(async () => {
      check(); this.#activeGuard = check;
      try { const result = await work(); check(); committed(); return result; }
      finally { this.#activeGuard = null; }
    }).finally(() => { this.#pending--; clearTimeout(timer); });
    this.#chain = operation.catch(() => {});
    const deadline = new Promise((_, rej) => { timer = setTimeout(() => { expired = true; rej(Object.assign(new Error('verification_timeout'), { status: 408 })); }, this.deadlineMs); });
    return Promise.race([operation, deadline]);
  }
  options(challenge) {
    if (![...this.credentials.keys()].some(id => this.current(id))) reject('enrollment_required');
    return this.crypto.options(challenge);
  }
  registrationOptions(challenge, userID) {
    if (this.credentials.size >= MAX_CREDENTIALS) reject('credential_capacity', 429);
    return this.crypto.registrationOptions(challenge, userID);
  }
  verify({ response, challenge, origin, guard = () => {} }) {
    validateClientData(response);
    const id = response.id, version = this.version(id);
    return this.#run(() => this.crypto.verify({ response, challenge, origin }), () => {
      guard(); if (!this.current(id, version)) reject('credential_unknown');
    });
  }
  register(response, challenge, { guard = () => {}, committed = () => {} } = {}) {
    validateClientData(response);
    return this.#run(() => this.crypto.register(response, challenge), () => {
      guard(); if (this.credentials.size >= MAX_CREDENTIALS && !this.credentials.has(response.id)) reject('credential_capacity', 429);
    }, committed);
  }
  remove(id, { guard = () => {}, invalidated = () => {} } = {}) {
    if (!this.current(id)) return Promise.reject(new Error('credential_unknown'));
    // Disable synchronously so an in-flight signature/counter save cannot restore the key.
    this.#disabled.add(id); this.#versions.set(id, ++this.#serial); invalidated();
    return this.#run(() => {
      const next = new Map(this.credentials); next.delete(id);
      const result = this.persist(next); if (result?.then) reject('synchronous_persistence_required');
      this.credentials.delete(id); this.#disabled.delete(id); this.#versions.delete(id);
      return true;
    }, guard);
  }
  get pending() { return this.#pending; }
}

export function validateClientData(response) {
  if (!response || typeof response !== 'object' || typeof response.id !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(response.id) || !response.response || typeof response.response !== 'object') reject('assertion_invalid');
  const transports = response.response.transports;
  if (transports !== undefined && (!Array.isArray(transports) || transports.length > 8 || transports.some(t => !TRANSPORTS.includes(t)))) reject('assertion_invalid');
  for (const key of ['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature', 'userHandle']) {
    const v = response.response[key];
    if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > 16_384 || !/^[A-Za-z0-9_-]*$/.test(v))) reject('assertion_invalid');
  }
  const raw = response.response.clientDataJSON;
  if (typeof raw !== 'string' || raw.length > 8192) reject('client_data_invalid');
  let data; try { data = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { reject('client_data_invalid'); }
  if (!data || typeof data !== 'object' || !['webauthn.get', 'webauthn.create'].includes(data.type) || typeof data.origin !== 'string' || typeof data.challenge !== 'string' || data.origin.length > 512 || data.challenge.length > 256) reject('client_data_invalid');
  if ((data.crossOrigin !== undefined && data.crossOrigin !== false) || data.topOrigin !== undefined) reject('cross_origin_ceremony');
}
