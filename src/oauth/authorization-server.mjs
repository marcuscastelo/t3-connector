import { createHash, timingSafeEqual } from 'node:crypto';
import { OAuthError } from './token-store.mjs';
import { json, html, redirect, readBody, cookies, page, esc, redact } from './http.mjs';

// Embedded OAuth 2.1 authorization server (public routes). Authorization code + PKCE S256 only,
// CIMD clients with private_key_jwt, RFC 9207 `iss` in every callback, RFC 8707 single resource.
// The user authenticates with a passkey on the local control-plane, reached from /authorize by a
// top-level navigation to localhost (button or 302) or by an out-of-band code.
export const SCOPES = ['connector:read', 'connector:write'];
export const LOGIN_MODES = ['button', '302', 'oob'];
const COOKIE = 't3c_tx';
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const GRANT_TYPES = new Set(['authorization_code', 'refresh_token']);

export function asMetadata({ issuer }) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['private_key_jwt'],
    token_endpoint_auth_signing_alg_values_supported: ['ES256', 'RS256', 'PS256'],
    revocation_endpoint_auth_methods_supported: ['private_key_jwt'],
    revocation_endpoint_auth_signing_alg_values_supported: ['ES256', 'RS256', 'PS256'],
    scopes_supported: SCOPES,
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}

export const pkceMatches = (verifier, challenge) => {
  if (typeof verifier !== 'string' || !VERIFIER.test(verifier) || typeof challenge !== 'string') return false;
  const a = Buffer.from(createHash('sha256').update(verifier).digest('base64url')), b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function authorizationServer({ issuer, resource, localOrigin, loginMode = 'button', authority, tokens, clients, transactions, audit = () => {} }) {
  if (!LOGIN_MODES.includes(loginMode)) throw new Error('invalid_login_mode');
  const secureCookie = issuer.startsWith('https://') ? '; Secure' : '';
  const setCookie = (v, maxAge) => `${COOKIE}=${v}; HttpOnly${secureCookie}; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
  const errorPage = (res, status, message) => html(res, status, n => page('Sign-in error', `<h1>Sign-in failed</h1><p>${esc(message)}</p><p class="muted">Start the connection again from the client app.</p>`, n));
  const callback = (redirectUri, params) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
    u.searchParams.set('iss', issuer);
    return u.href;
  };

  async function authorize(req, res, url) {
    const q = Object.fromEntries(url.searchParams);
    let client;
    try { client = await clients.resolve(q.client_id); } catch (e) {
      audit({ event: 'authorize_rejected', reason: e.description ?? e.message, clientId: redact(q.client_id) });
      return errorPage(res, 400, 'Unknown or invalid client.');
    }
    if (!client.redirectUris.includes(q.redirect_uri)) {
      audit({ event: 'authorize_rejected', reason: 'redirect_uri_mismatch', clientId: client.clientId });
      return errorPage(res, 400, 'The redirect URI is not registered for this client.');
    }
    const back = (error, description) => { audit({ event: 'authorize_rejected', reason: description ?? error, clientId: client.clientId }); return redirect(res, callback(q.redirect_uri, { error, error_description: description, state: q.state })); };
    if (q.response_type !== 'code') return back('unsupported_response_type');
    if (q.code_challenge_method !== 'S256' || typeof q.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) return back('invalid_request', 'pkce_s256_required');
    if (q.resource !== undefined && q.resource !== resource) {
      // Hashed only: a request value can carry anything, including a secret in a valid-looking URL.
      audit({ event: 'authorize_unknown_resource', clientId: client.clientId, requestedHash: redact(q.resource) });
      return back('invalid_target', 'unknown_resource');
    }
    if (q.request !== undefined || q.request_uri !== undefined) return back('request_not_supported');
    if (authority.killed) return back('access_denied', 'kill_switch');
    // Absent scope means the full default scope. Unknown scopes are dropped (RFC 6749 §3.3), but an
    // explicit request with no supported scope is refused rather than widened to the default.
    const asked = typeof q.scope === 'string' ? [...new Set(q.scope.split(' ').filter(s => SCOPES.includes(s)))] : null;
    if (asked && !asked.length) return back('invalid_scope', 'no_supported_scope');
    const scope = (asked ?? SCOPES).join(' ');
    const { tx, cookie, handoff } = transactions.create({ clientId: client.clientId, clientName: client.name, redirectUri: q.redirect_uri, state: q.state, codeChallenge: q.code_challenge, resource, scope, mode: loginMode, epoch: authority.epoch });
    audit({ event: 'authorize', tx: redact(tx.id), clientId: client.clientId, scope, resourceSent: q.resource !== undefined, mode: loginMode, browser: browser(req) });
    const headers = { 'Set-Cookie': setCookie(cookie, 300) };
    const localUrl = `${localOrigin}/login#handoff=${handoff}`;
    if (loginMode === '302') return redirect(res, localUrl, headers);
    return html(res, 200, n => page('Sign in', `<h1>T3 Connector sign-in</h1>
<dl><dt>Client</dt><dd>${esc(tx.clientName ?? tx.clientId)} <span class="muted">(${esc(tx.clientId)})</span></dd><dt>Access</dt><dd>${esc(scope)}</dd></dl>
${loginMode === 'button' ? `<p>Approve this sign-in with your passkey on the local control panel of <b>this computer</b>.</p><p><a class="btn" href="${esc(localUrl)}">Open local control (localhost)</a></p>` : ''}
<p class="muted">${loginMode === 'button' ? 'If the button does not work: ' : ''}open <code>${esc(localOrigin)}/login</code> in a browser on this computer and enter the code <span class="big">${esc(tx.oob)}</span>. Keep this page open; it continues by itself.</p>
<p id="s" class="muted"></p>
<script nonce="${n}">const id=${JSON.stringify(tx.statusId)};async function poll(){try{const r=await fetch('/authorize/status?tx='+encodeURIComponent(id),{credentials:'same-origin'});const v=await r.json();if(v.approved){location.replace('/resume?tx='+encodeURIComponent(id));return;}if(v.error){document.getElementById('s').textContent='Sign-in expired. Start again from the client app.';return;}}catch(e){}setTimeout(poll,1500);}poll();</script>`, n), headers);
  }

  function status(req, res, url) {
    try { return json(res, 200, transactions.status(url.searchParams.get('tx'), cookies(req)[COOKIE])); } catch { return json(res, 403, { error: 'forbidden' }); }
  }

  function resume(req, res, url) {
    let tx;
    try { tx = transactions.consume({ resume: url.searchParams.get('h') ?? undefined, statusId: url.searchParams.get('tx') ?? undefined, cookie: cookies(req)[COOKIE] }); } catch (e) {
      audit({ event: 'resume_rejected', reason: e.message, cookiePresent: !!cookies(req)[COOKIE] });
      return errorPage(res, 400, 'This sign-in is invalid, expired or was opened in a different browser.');
    }
    const clear = { 'Set-Cookie': setCookie('', 0) };
    let sid;
    try {
      // A revoke-all or kill switch after this sign-in started cancels it, even if already approved.
      if (tx.epoch !== authority.epoch) throw new Error('authority_reset'); sid = authority.create({ sub: tx.approved.sub, clientId: tx.clientId, credentialId: tx.approved.credentialId, scope: tx.scope, resource: tx.resource, grants: tx.approved.grants ?? null }); } catch (e) {
      audit({ event: 'resume_rejected', reason: e.message });
      return redirect(res, callback(tx.redirectUri, { error: 'access_denied', error_description: e.message, state: tx.state }), clear);
    }
    const code = tokens.issueCode({ sid, clientId: tx.clientId, redirectUri: tx.redirectUri, codeChallenge: tx.codeChallenge, resource: tx.resource, scope: tx.scope });
    audit({ event: 'code_issued', tx: redact(tx.id), sid: redact(sid), clientId: tx.clientId });
    return redirect(res, callback(tx.redirectUri, { code, state: tx.state }), clear);
  }

  async function formBody(req) {
    if (!(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) throw new OAuthError('invalid_request', 'form_encoding_required');
    const params = new URLSearchParams(await readBody(req)), form = {};
    for (const [k, v] of params) { if (Object.hasOwn(form, k)) throw new OAuthError('invalid_request', 'duplicate_parameter'); form[k] = v; }
    return form;
  }
  const oauthError = (res, e, extra = {}) => {
    if (!(e instanceof OAuthError)) throw e;
    audit({ event: 'token_error', error: e.error, reason: e.description, ...extra });
    return json(res, e.status, { error: e.error, error_description: e.description });
  };

  async function token(req, res) {
    let form, client;
    try {
      form = await formBody(req);
      client = await clients.authenticate(form, { audiences: [`${issuer}/token`, issuer] });
      let issued;
      if (form.grant_type === 'authorization_code') issued = tokens.consumeCode(form.code, { clientId: client.clientId, redirectUri: form.redirect_uri, verifyPkce: c => pkceMatches(form.code_verifier, c), resource: form.resource });
      else if (form.grant_type === 'refresh_token') issued = tokens.refresh(form.refresh_token, { clientId: client.clientId, resource: form.resource, scope: form.scope });
      else throw new OAuthError('unsupported_grant_type', 'unsupported_grant_type');
      audit({ event: form.grant_type === 'refresh_token' ? 'token_refreshed' : 'token_issued', clientId: client.clientId, expiresIn: issued.expires_in });
      return json(res, 200, issued);
    } catch (e) { return oauthError(res, e, { grantType: GRANT_TYPES.has(form?.grant_type) ? form.grant_type : redact(form?.grant_type), clientId: client?.clientId ?? null }); }
  }

  async function revoke(req, res) {
    try {
      const form = await formBody(req);
      const client = await clients.authenticate(form, { audiences: [`${issuer}/revoke`, `${issuer}/token`, issuer] });
      tokens.revokeToken(form.token, { clientId: client.clientId });
      audit({ event: 'token_revocation', clientId: client.clientId });
      return json(res, 200, {});
    } catch (e) { return oauthError(res, e); }
  }

  // Returns true when the route was handled.
  return async function handle(req, res, url) {
    const p = url.pathname;
    if (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/openid-configuration' || p === '/.well-known/oauth-authorization-server/mcp') {
      audit({ event: 'discovery', path: p });
      json(res, 200, asMetadata({ issuer })); return true;
    }
    if (p === '/authorize' && req.method === 'GET') { await authorize(req, res, url); return true; }
    if (p === '/authorize/status' && req.method === 'GET') { status(req, res, url); return true; }
    if (p === '/resume' && req.method === 'GET') { resume(req, res, url); return true; }
    if (p === '/token' && req.method === 'POST') { await token(req, res); return true; }
    if (p === '/revoke' && req.method === 'POST') { await revoke(req, res); return true; }
    return false;
  };
}

function browser(req) {
  const m = (req.headers['user-agent'] ?? '').match(/(Firefox|Edg|OPR|Chrome|Safari)\/[\d.]+/);
  return m?.[0] ?? null;
}
