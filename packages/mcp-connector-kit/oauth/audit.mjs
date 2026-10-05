import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './http.mjs';
import { stopwatch } from './session-authority.mjs';

// One rotated file and a bounded map aggregate repeated rejected events. Callers supply only
// event metadata, never browser bodies, cookies, tickets, codes, tokens or assertion strings.
export function boundedAudit({ stateDir, clock, wall, log = null }) {
  const file = join(stateDir, 'events.jsonl'), time = stopwatch({ clock, wall }), repeats = new Map();
  const emit = event => {
    const line = JSON.stringify({ t: new Date().toISOString(), ...event });
    try {
      if (existsSync(file) && statSync(file).size >= 1024 * 1024) renameSync(file, file + '.1');
      appendFileSync(file, line + '\n', { mode: 0o600 });
    } catch {}
    log?.(line);
  };
  const flushOne = r => { if (r.count) emit({ ...r.event, repeated: r.count }); };
  const sweep = () => { for (const [key, r] of repeats) if (time.elapsed(r.at) >= 60_000) { flushOne(r); repeats.delete(key); } };
  const audit = input => {
    const event = { ...input };
    for (const key of ['reason', 'error']) if (typeof event[key] === 'string' && !/^[a-z0-9_]{1,64}$/.test(event[key])) event[key] = 'rejected';
    for (const key of ['sid', 'credentialId', 'credential']) if (typeof event[key] === 'string' && !/^[0-9a-f]{8}$/.test(event[key])) event[key] = redact(event[key]);
    // Unknown JSON-RPC method names are attacker input, not useful logging metadata.
    if (typeof event.rpc === 'string' && !['initialize', 'tools/list', 'tools/call', 'ping', 'notifications/initialized'].includes(event.rpc)) event.rpc = 'unknown';
    if (/(?:rejected|error|bad_host|unauthorized)$/.test(event.event)) {
      sweep();
      const key = JSON.stringify([event.event, event.reason, event.error]);
      const r = repeats.get(key);
      if (r) { r.count++; return; }
      if (repeats.size >= 128) return;
      repeats.set(key, { event: { event: event.event, reason: event.reason, error: event.error }, at: time.mark(), count: 0 });
    }
    emit(event);
  };
  audit.sweep = sweep;
  audit.flush = () => { for (const r of repeats.values()) flushOne(r); repeats.clear(); };
  return audit;
}
