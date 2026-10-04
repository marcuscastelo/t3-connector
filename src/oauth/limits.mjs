import { stopwatch } from './session-authority.mjs';
export const limited = (code = 'rate_limited', status = 429) => Object.assign(new Error(code), { status });

// Conservative app budgets use the socket peer only. Behind ingress this is a shared budget;
// forwarded IP/Host headers are never trusted. Per-browser/transaction limits are independent.
export class Admission {
  #buckets = new Map();
  #active = 0;
  constructor({ clock, wall, burst = 5, perMinute = 10, maxEntries = 256, concurrency = 8 } = {}) {
    Object.assign(this, { time: stopwatch({ clock, wall }), burst, perMinute, maxEntries, concurrency });
  }
  take(key) {
    let b = this.#buckets.get(key);
    if (!b) {
      this.sweep(); if (this.#buckets.size >= this.maxEntries) throw limited('rate_capacity');
      b = { at: this.time.mark(), tokens: this.burst, elapsed: 0 }; this.#buckets.set(key, b);
    }
    const elapsed = this.time.elapsed(b.at);
    b.tokens = Math.min(this.burst, b.tokens + (elapsed - b.elapsed) * this.perMinute / 60_000); b.elapsed = elapsed;
    if (b.tokens < 1) throw limited(); b.tokens--;
  }
  enter() { if (this.#active >= this.concurrency) throw limited('verification_overload'); this.#active++; let done = false; return () => { if (!done) { done = true; this.#active--; } }; }
  sweep() { for (const [key, b] of this.#buckets) if (this.time.elapsed(b.at) - b.elapsed > 60_000) this.#buckets.delete(key); }
  get active() { return this.#active; }
  get size() { return this.#buckets.size; }
}

export async function deadline(work, ms = 10_000) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(limited('request_timeout', 408)), ms); })]); }
  finally { clearTimeout(timer); }
}
export function boundedObject(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw limited('bad_request', 400);
  const pending = [[value, 0]]; let nodes = 0;
  while (pending.length) {
    const [v, depth] = pending.pop(); if (++nodes > 256 || depth > 6) throw limited('bad_request', 400);
    if (v && typeof v === 'object') for (const item of Object.values(v)) pending.push([item, depth + 1]);
    if (typeof v === 'string' && v.length > 16_384) throw limited('bad_request', 400);
  }
  return value;
}
