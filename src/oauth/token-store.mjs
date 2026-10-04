import { createHmac, randomBytes } from 'node:crypto';
import { stopwatch } from './session-authority.mjs';

// Authorization codes, opaque access tokens and rotating refresh tokens. Only HMACs of the token
// values are kept (process-local pepper), never the values. Every token resolves to a session of the
// SessionAuthority, which stays authoritative: a token never outlives its session.
//
// Refresh rotation: each refresh consumes the presented token and issues a successor. Presenting a
// consumed refresh token again (reuse) ends the whole session. Refresh never counts as activity.
export const AT_TTL_MS = 60 * 1000;
export const RT_TTL_MS = 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 60 * 1000;

export class OAuthError extends Error {
  constructor(error, description, status = 400) { super(description ?? error); Object.assign(this, { error, description: description ?? error, status }); }
}

export class TokenStore {
  #pepper = randomBytes(32);
  #codes = new Map();
  #access = new Map();
  #refresh = new Map();
  constructor({ authority, atTtlMs = AT_TTL_MS, rtTtlMs = RT_TTL_MS, codeTtlMs = CODE_TTL_MS, clock, wall, audit = () => {} }) {
    if (!authority) throw new Error('authority_required');
    Object.assign(this, { authority, atTtlMs, rtTtlMs, codeTtlMs, audit, time: stopwatch({ clock, wall }) });
    authority.onTerminal(sid => this.#purge(sid));
  }
  #key(v) { return createHmac('sha256', this.#pepper).update(String(v)).digest('base64url'); }
  #token() { return randomBytes(32).toString('base64url'); }
  #purge(sid) {
    for (const m of [this.#codes, this.#access, this.#refresh]) for (const [k, v] of m) if (v.sid === sid) m.delete(k);
  }

  issueCode({ sid, clientId, redirectUri, codeChallenge, resource, scope }) {
    const code = this.#token();
    this.#codes.set(this.#key(code), { sid, clientId, redirectUri, codeChallenge, resource, scope, issued: this.time.mark(), used: false });
    return code;
  }

  // Validates and consumes a code. A second presentation of a used code ends the session it created.
  consumeCode(code, { clientId, redirectUri, verifyPkce, resource }) {
    const c = this.#codes.get(this.#key(code ?? ''));
    if (!c) throw new OAuthError('invalid_grant', 'code_unknown');
    if (c.used) { this.authority.revoke(c.sid, 'code_reuse'); throw new OAuthError('invalid_grant', 'code_reused'); }
    c.used = true;
    if (this.time.elapsed(c.issued) >= this.codeTtlMs) throw new OAuthError('invalid_grant', 'code_expired');
    if (c.clientId !== clientId) throw new OAuthError('invalid_grant', 'client_mismatch');
    if (redirectUri !== undefined && redirectUri !== c.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri_mismatch');
    if (!verifyPkce(c.codeChallenge)) throw new OAuthError('invalid_grant', 'pkce_failed');
    if (resource !== undefined && resource !== c.resource) throw new OAuthError('invalid_target', 'resource_mismatch');
    this.#checkSession(c.sid);
    return this.#mint(c.sid, c);
  }

  refresh(token, { clientId, resource, scope }) {
    const k = this.#key(token ?? ''), r = this.#refresh.get(k);
    if (!r) throw new OAuthError('invalid_grant', 'refresh_token_unknown');
    if (r.consumed) {
      this.audit({ event: 'refresh_reuse', sid: r.sid });
      this.authority.revoke(r.sid, 'refresh_reuse');
      throw new OAuthError('invalid_grant', 'refresh_token_reused');
    }
    if (r.clientId !== clientId) throw new OAuthError('invalid_grant', 'client_mismatch');
    if (resource !== undefined && resource !== r.resource) throw new OAuthError('invalid_target', 'resource_mismatch');
    if (scope !== undefined && !scope.split(' ').filter(Boolean).every(s => r.scope.split(' ').includes(s))) throw new OAuthError('invalid_scope', 'scope_not_granted');
    if (this.time.elapsed(r.issued) >= this.rtTtlMs) throw new OAuthError('invalid_grant', 'refresh_token_expired');
    this.#checkSession(r.sid);
    r.consumed = true; // tombstone kept until the session ends, for reuse detection
    // A narrower scope applies to the new access token only; the refresh token keeps the grant's
    // scope (RFC 6749 §6).
    return this.#mint(r.sid, r, scope === undefined ? r.scope : [...new Set(scope.split(' ').filter(Boolean))].join(' '));
  }

  #checkSession(sid) {
    try { this.authority.check(sid); } catch (e) { throw new OAuthError('invalid_grant', e.message); }
  }

  #mint(sid, { clientId, resource, scope }, accessScope = scope) {
    const accessToken = this.#token(), refreshToken = this.#token(), issued = this.time.mark();
    // The access token never outlives the idle deadline known at issuance; the authority check on
    // every request still decides.
    const atTtl = Math.max(1, Math.min(this.atTtlMs, this.authority.remainingMs(sid)));
    this.#access.set(this.#key(accessToken), { sid, clientId, resource, scope: accessScope, issued, ttl: atTtl });
    this.#refresh.set(this.#key(refreshToken), { sid, clientId, resource, scope, issued, consumed: false });
    this.audit({ event: 'tokens_issued', sid });
    return { access_token: accessToken, token_type: 'Bearer', expires_in: Math.max(1, Math.floor(atTtl / 1000)), refresh_token: refreshToken, scope: accessScope };
  }

  // RS side: resolves a bearer token to its session. Does not touch activity.
  resolveAccess(token) {
    const a = this.#access.get(this.#key(token ?? ''));
    if (!a) throw new OAuthError('invalid_token', 'token_unknown', 401);
    if (this.time.elapsed(a.issued) >= a.ttl) { this.#access.delete(this.#key(token)); throw new OAuthError('invalid_token', 'token_expired', 401); }
    let session;
    try { session = this.authority.check(a.sid); } catch (e) { throw new OAuthError('invalid_token', e.message, 401); }
    return { ...session, scope: a.scope, resource: a.resource, clientId: a.clientId };
  }

  // RFC 7009: revoking any token of a session ends the session (and with it every token).
  revokeToken(token, { clientId }) {
    const k = this.#key(token ?? '');
    const t = this.#refresh.get(k) ?? this.#access.get(k);
    if (t && t.clientId === clientId) this.authority.revoke(t.sid, 'client_revoked');
  }

  // Test/admin helper: invalidates access tokens only (refresh tokens keep working).
  revokeAccessTokens() { const n = this.#access.size; this.#access.clear(); return n; }

  counts() { return { codes: this.#codes.size, access: this.#access.size, refresh: [...this.#refresh.values()].filter(r => !r.consumed).length }; }

  // Drops expired codes and access tokens; refresh tombstones live as long as their session.
  sweep() {
    for (const [k, c] of this.#codes) if (c.used || this.time.elapsed(c.issued) >= this.codeTtlMs) this.#codes.delete(k);
    for (const [k, a] of this.#access) if (this.time.elapsed(a.issued) >= a.ttl) this.#access.delete(k);
  }
}
