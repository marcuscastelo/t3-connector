import { createPublicKey, verify as verifySignature, constants } from 'node:crypto';
import { stopwatch } from './session-authority.mjs';
import { OAuthError } from './token-store.mjs';

// OAuth clients identified by a Client ID Metadata Document (CIMD): the client_id is an HTTPS URL
// whose JSON document lists redirect URIs and the client's public keys. Only allowlisted client IDs
// are fetched (no arbitrary outbound requests), and this profile requires private_key_jwt at the
// token endpoint, verified against the document's JWKS. There is no downgrade to "none".
export const CHATGPT_CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
export const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const MAX_DOC_BYTES = 64 * 1024;
const CACHE_MS = 10 * 60 * 1000;
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

export class ClientRegistry {
  #cache = new Map();
  #seenJti = new Map();
  constructor({ allowedClients = [CHATGPT_CLIENT_ID], fetch: fetchImpl = globalThis.fetch, clock, wall = () => Date.now(), audit = () => {} } = {}) {
    for (const id of allowedClients) if (new URL(id).protocol !== 'https:' || new URL(id).href !== id) throw new Error(`invalid_client_id:${id}`);
    Object.assign(this, { allowed: new Set(allowedClients), fetchImpl, wall, audit, time: stopwatch({ clock, wall }) });
  }

  async #load(clientId, { force = false } = {}) {
    const hit = this.#cache.get(clientId);
    if (hit && !force && this.time.elapsed(hit.at) < CACHE_MS) return hit.client;
    const doc = await fetchJson(this.fetchImpl, clientId);
    if (doc?.client_id !== clientId) throw new Error('cimd_client_id_mismatch');
    const redirectUris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter(u => typeof u === 'string' && new URL(u).protocol === 'https:') : [];
    if (!redirectUris.length) throw new Error('cimd_redirect_uris_missing');
    if (doc.token_endpoint_auth_method !== 'private_key_jwt') throw new Error('cimd_auth_method_unsupported');
    let jwks = doc.jwks;
    if (!jwks && typeof doc.jwks_uri === 'string') jwks = await fetchJson(this.fetchImpl, doc.jwks_uri);
    if (!Array.isArray(jwks?.keys) || !jwks.keys.length) throw new Error('cimd_jwks_missing');
    const client = { clientId, name: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 120) : null, redirectUris, keys: jwks.keys };
    this.#cache.set(clientId, { client, at: this.time.mark() });
    this.audit({ event: 'client_loaded', clientId, keys: jwks.keys.length });
    return client;
  }

  // Used by /authorize: the client must be allowlisted and its document valid.
  async resolve(clientId) {
    if (typeof clientId !== 'string' || !this.allowed.has(clientId)) throw new OAuthError('invalid_client', 'client_not_allowed', 401);
    try { return await this.#load(clientId); } catch (e) { throw new OAuthError('invalid_client', `cimd_${e.message}`.replace(/^cimd_cimd_/, 'cimd_'), 401); }
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
    if (typeof claims.jti !== 'string' || !claims.jti) throw new OAuthError('invalid_client', 'assertion_jti_missing', 401);
    this.#pruneJti(now);
    const jtiKey = `${clientId} ${claims.jti}`;
    if (this.#seenJti.has(jtiKey)) throw new OAuthError('invalid_client', 'assertion_replayed', 401);
    this.#seenJti.set(jtiKey, claims.exp + SKEW_S);
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
