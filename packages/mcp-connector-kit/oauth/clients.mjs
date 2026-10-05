import { createPublicKey, verify as verifySignature, constants } from 'node:crypto';
import { stopwatch } from './session-authority.mjs';
import { deadline } from './limits.mjs';
import { OAuthError } from './token-store.mjs';

// OAuth clients identified by a Client ID Metadata Document (CIMD): the client_id is an HTTPS URL
// whose JSON document lists redirect URIs and the client's public keys. Only allowlisted client IDs
// are fetched (no arbitrary outbound requests), and this profile requires private_key_jwt at the
// token endpoint, verified against the document's JWKS. There is no downgrade to "none".
export const CHATGPT_CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
export const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const MAX_DOC_BYTES = 64 * 1024;
const CACHE_MS = 10 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
const MAX_ASSERTION_LIFETIME_S = 10 * 60;
const SKEW_S = 60;
const ALGS = {
  RS256: { kty: 'RSA', hash: 'sha256' },
  PS256: { kty: 'RSA', hash: 'sha256', pss: true },
  ES256: { kty: 'EC', crv: 'P-256', hash: 'sha256', ec: true },
};

async function fetchJson(fetchImpl, url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('https_required');
  const r = await fetchImpl(u.href, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
  const discard = () => r.body?.cancel().catch(() => {});
  if (!r.ok) { await discard(); throw new Error(`fetch_status_${r.status}`); }
  if (Number(r.headers.get('content-length')) > MAX_DOC_BYTES) { await discard(); throw new Error('document_too_large'); }
  if (!r.body) throw new Error('document_empty');
  // Counts bytes while streaming and stops at the limit, so an oversized body is not retained.
  const reader = r.body.getReader(), parts = [];
  let size = 0, finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { finished = true; break; }
      size += value.byteLength;
      if (size > MAX_DOC_BYTES) throw new Error('document_too_large');
      parts.push(value);
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

// Only a document that was fetched and parsed but failed validation (cimd_*) is authoritative.
// Network errors, timeouts, any HTTP status and unparseable bodies (an HTML challenge page) are not.
const transient = e => !/^cimd_/.test(e?.message ?? '');

export class ClientRegistry {
  #cache = new Map();
  #loading = new Map();
  #seenJti = new Map();
  constructor({ allowedClients = [CHATGPT_CLIENT_ID], fetch: fetchImpl = globalThis.fetch, clock, wall = () => Date.now(), audit = () => {} } = {}) {
    if (allowedClients.length > 32) throw new Error('client_capacity');
    for (const id of allowedClients) if (new URL(id).protocol !== 'https:' || new URL(id).href !== id) throw new Error(`invalid_client_id:${id}`);
    Object.assign(this, { allowed: new Set(allowedClients), fetchImpl, wall, audit, time: stopwatch({ clock, wall }) });
  }

  // Stale-while-revalidate: past CACHE_MS a cached document is still served at once while one refetch
  // runs in the background, for up to STALE_MS. A transient failure of that refetch (network,
  // timeout, 5xx, 429) keeps the copy, so one slow response from the client's host cannot fail a
  // refresh and end the user's connection; a document that arrives but no longer validates drops it.
  // A forced load (unknown kid) always waits for the network.
  async #load(clientId, { force = false } = {}) {
    const hit = this.#cache.get(clientId);
    const age = hit ? this.time.elapsed(hit.at) : Infinity;
    if (hit && !force && age < CACHE_MS) return hit.client;
    const stale = hit && !force && age < STALE_MS;
    let work = this.#loading.get(clientId);
    if (!work) {
      if (this.#loading.size >= 4) { if (stale) return hit.client; throw new OAuthError('temporarily_unavailable', 'client_metadata_overload', 429); }
      work = this.#fetchClient(clientId);
      this.#loading.set(clientId, work);
      work.finally(() => { if (this.#loading.get(clientId) === work) this.#loading.delete(clientId); }).catch(() => {});
      work.catch(e => {
        if (!transient(e)) { if (this.#cache.get(clientId) === hit) this.#cache.delete(clientId); return; }
        if (hit) this.audit({ event: 'client_refetch_failed', clientId, reason: /^[a-z0-9_]{1,64}$/.test(e.message) ? e.message : 'fetch_failed', staleS: Math.round(age / 1000) });
      });
    }
    if (stale) return hit.client;
    return deadline(work, 5000);
  }
  async #fetchClient(clientId) {
    const doc = await fetchJson(this.fetchImpl, clientId);
    if (doc?.client_id !== clientId) throw new Error('cimd_client_id_mismatch');
    const redirectUris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter(u => typeof u === 'string' && new URL(u).protocol === 'https:') : [];
    if (!redirectUris.length || redirectUris.length > 32) throw new Error('cimd_redirect_uris_missing');
    if (doc.token_endpoint_auth_method !== 'private_key_jwt') throw new Error('cimd_auth_method_unsupported');
    let jwks = doc.jwks;
    if (!jwks && typeof doc.jwks_uri === 'string') jwks = await fetchJson(this.fetchImpl, doc.jwks_uri);
    if (!Array.isArray(jwks?.keys) || !jwks.keys.length || jwks.keys.length > 16) throw new Error('cimd_jwks_missing');
    const client = { clientId, name: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 120) : null, redirectUris, keys: jwks.keys };
    this.#cache.set(clientId, { client, at: this.time.mark() });
    this.audit({ event: 'client_loaded', clientId, keys: jwks.keys.length });
    return client;
  }

  // Used by /authorize: the client must be allowlisted and its document valid.
  async resolve(clientId) {
    if (typeof clientId !== 'string' || !this.allowed.has(clientId)) throw new OAuthError('invalid_client', 'client_not_allowed', 401);
    try { return await this.#load(clientId); } catch (e) { if (e.status === 429) throw e; const reason = /^[a-z0-9_]{1,64}$/.test(e.message) ? e.message : 'fetch_failed'; throw new OAuthError('invalid_client', `cimd_${reason}`.replace(/^cimd_cimd_/, 'cimd_'), 401); }
  }

  // Token endpoint client authentication (RFC 7523 §3 / RFC 7521 §4.2).
  async authenticate(form, { audiences }) {
    if (form.client_assertion_type !== ASSERTION_TYPE || typeof form.client_assertion !== 'string') throw new OAuthError('invalid_client', 'private_key_jwt_required', 401);
    const parts = form.client_assertion.split('.');
    if (parts.length !== 3) throw new OAuthError('invalid_client', 'assertion_malformed', 401);
    let header, claims;
    try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw new OAuthError('invalid_client', 'assertion_malformed', 401); }
    const clientId = claims?.iss;
    if (form.client_id !== undefined && form.client_id !== clientId) throw new OAuthError('invalid_client', 'client_id_mismatch', 401);
    if (claims.sub !== clientId) throw new OAuthError('invalid_client', 'assertion_sub_mismatch', 401);
    const client = await this.resolve(clientId);
    const alg = ALGS[header?.alg];
    if (!alg) throw new OAuthError('invalid_client', 'assertion_alg_unsupported', 401);
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`), signature = Buffer.from(parts[2], 'base64url');
    let ok = this.#verifyWith(client.keys, header, alg, signed, signature);
    if (ok === null) { // unknown kid: the client may have rotated keys; refetch once
      const fresh = await this.#load(clientId, { force: true }).catch(() => client);
      ok = this.#verifyWith(fresh.keys, header, alg, signed, signature);
    }
    if (!ok) throw new OAuthError('invalid_client', 'assertion_signature_invalid', 401);
    const now = Math.floor(this.wall() / 1000), aud = [].concat(claims.aud ?? []);
    if (!aud.some(a => audiences.includes(a))) throw new OAuthError('invalid_client', 'assertion_audience_invalid', 401);
    const time = v => v === undefined || Number.isFinite(v);
    if (!Number.isFinite(claims.exp) || !time(claims.iat) || !time(claims.nbf)) throw new OAuthError('invalid_client', 'assertion_time_claims_invalid', 401);
    if (claims.exp + SKEW_S <= now) throw new OAuthError('invalid_client', 'assertion_expired', 401);
    // Freshness: at most 10 minutes of remaining validity and, when iat is present (RFC 7523 makes it
    // optional), at most 10 minutes from issuance to expiry.
    if (claims.exp - now > MAX_ASSERTION_LIFETIME_S) throw new OAuthError('invalid_client', 'assertion_lifetime_too_long', 401);
    if (claims.iat !== undefined && (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_ASSERTION_LIFETIME_S)) throw new OAuthError('invalid_client', 'assertion_lifetime_too_long', 401);
    if (claims.iat !== undefined && claims.iat - SKEW_S > now) throw new OAuthError('invalid_client', 'assertion_issued_in_future', 401);
    if (claims.nbf !== undefined && claims.nbf - SKEW_S > now) throw new OAuthError('invalid_client', 'assertion_not_yet_valid', 401);
    if (typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > 256) throw new OAuthError('invalid_client', 'assertion_jti_missing', 401);
    this.#pruneJti(now);
    const jtiKey = `${clientId} ${claims.jti}`;
    if (this.#seenJti.has(jtiKey)) throw new OAuthError('invalid_client', 'assertion_replayed', 401);
    if (this.#seenJti.size >= 4096) throw new OAuthError('temporarily_unavailable', 'assertion_replay_capacity', 429);
    this.#seenJti.set(jtiKey, claims.exp + SKEW_S);
    // Evidence that the signature was verified, and with which key (public metadata only).
    this.audit({ event: 'client_authenticated', clientId, alg: header.alg, kid: typeof header.kid === 'string' ? header.kid.slice(0, 64).replace(/[^A-Za-z0-9._-]/g, '_') : null, lifetime: claims.iat !== undefined ? claims.exp - claims.iat : null });
    return client;
  }

  // true/false when a matching key exists; null when no key matches the header's kid.
  #verifyWith(keys, header, alg, signed, signature) {
    const candidates = keys.filter(k => k && k.kty === alg.kty && (!alg.crv || k.crv === alg.crv) && k.use !== 'enc' && (!k.alg || k.alg === header.alg) && (header.kid === undefined || k.kid === header.kid));
    if (!candidates.length) return header.kid === undefined ? false : null;
    for (const jwk of candidates) {
      try {
        const key = createPublicKey({ key: jwk, format: 'jwk' });
        const opts = alg.ec ? { key, dsaEncoding: 'ieee-p1363' } : alg.pss ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : key;
        if (verifySignature(alg.hash, signed, opts, signature)) return true;
      } catch {}
    }
    return false;
  }

  #pruneJti(now) { for (const [k, exp] of this.#seenJti) if (exp <= now) this.#seenJti.delete(k); }
}
