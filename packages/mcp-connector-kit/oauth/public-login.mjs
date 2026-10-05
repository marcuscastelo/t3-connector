import { brandOf } from './brand.mjs';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Admission, boundedObject, deadline, limited } from './limits.mjs';
import { CEREMONY_MS } from './passkeys.mjs';
import { transactionCookie } from './authorization-server.mjs';
import { cookies, esc, html, json, page, readBody, redact, SECURITY_HEADERS } from './http.mjs';
import { stopwatch } from './session-authority.mjs';

const safeError = e => /^[a-z_]{1,64}$/.test(e?.message ?? '') ? e.message : 'ceremony_rejected';
const bundle = () => readFileSync(join(dirname(dirname(createRequire(import.meta.url).resolve('@simplewebauthn/browser'))), 'dist/bundle/index.umd.min.js'));
const API = `const api=async(p,d)=>{const r=await fetch(p,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});const v=await r.json();if(!r.ok)throw new Error(v.error||r.status);return v;};const $=id=>document.getElementById(id);const say=t=>$('status').textContent=t;`;

export function publicLogin({ issuer, mode, passkeys, subject, authority, transactions, consent, enrollment, clock, wall, audit = () => {}, limits = {}, brand }) {
  const time = stopwatch({ clock, wall });
  const authorizeBudget = new Admission({ clock, wall, ...limits.authorize });
  const budget = new Admission({ clock, wall, burst: 30, perMinute: 60, ...limits.ceremony });
  const worker = new Admission({ clock, wall, concurrency: 8, ...limits.worker });
  let vendor;
  const cookieName = transactionCookie(issuer, brand), BRAND = brandOf(brand), ENROLL_COOKIE = `__Host-${BRAND.cookie}_enroll`;
  const lookup = (req, d) => transactions.findPublic(d.tx, cookies(req)[cookieName], authority);
  const state = tx => (tx.publicCeremony ??= { issued: 0, failures: 0, lastOption: null, challenge: null });
  const currentAuth = (req, d, expected) => {
    const tx = lookup(req, d), auth = tx.authenticated;
    if (!auth || (expected && auth !== expected) || time.elapsed(auth.at) >= CEREMONY_MS || !passkeys.current(auth.credentialId, auth.credentialGeneration)) throw limited('authentication_required', 400);
    return tx;
  };
  async function loginApi(req, path, d) {
    boundedObject(d, path === '/authorize/passkey/verify' ? ['tx', 'response'] : path === '/authorize/consent' ? ['tx', 'accept'] : ['tx']);
    const tx = lookup(req, d), st = state(tx);
    if (path === '/authorize/passkey/options') {
      if (tx.verifying || tx.consentBusy) throw limited('ceremony_busy');
      if (st.issued >= 5) { transactions.cancel(tx); throw limited('options_exhausted'); }
      if (st.lastOption && time.elapsed(st.lastOption) < 1000) throw limited();
      st.issued++; st.lastOption = time.mark(); tx.authenticated = null;
      const value = randomBytes(32).toString('base64url');
      st.challenge = { value, at: time.mark(), ttlMs: Math.min(CEREMONY_MS, transactions.remaining(tx)), purpose: 'public-login', rpID: passkeys.rpID, origin: issuer, tx: tx.id, cookieHash: tx.cookieHash, epoch: authority.epoch };
      const options = await passkeys.options(value); lookup(req, d); return options;
    }
    if (path === '/authorize/passkey/verify') {
      if (tx.verifying || tx.consentBusy || tx.authenticated) throw limited('ceremony_busy');
      const c = st.challenge; st.challenge = null; // single use, before any crypto await
      tx.verifying = true;
      try {
        if (!c || time.elapsed(c.at) >= c.ttlMs || c.tx !== tx.id || c.cookieHash !== tx.cookieHash || c.epoch !== authority.epoch || c.purpose !== 'public-login' || c.origin !== issuer || c.rpID !== passkeys.rpID) throw limited('challenge_expired', 400);
        const guard = () => { lookup(req, d); if (time.elapsed(c.at) >= c.ttlMs) throw limited('challenge_expired', 400); };
        const credentialId = await passkeys.verify({ response: d.response, challenge: c.value, origin: issuer, guard }); guard();
        const auth = { credentialId, credentialRp: passkeys.rpID, credentialOrigin: issuer, credentialGeneration: passkeys.version(credentialId), at: time.mark() };
        if (!passkeys.current(credentialId, auth.credentialGeneration)) throw limited('credential_unknown', 400);
        tx.authenticated = auth;
        // Authentication alone never approves. Private policy/inventory starts only after UV.
        auth.snapshot = await consent.grantsFor(tx); currentAuth(req, d, auth);
        const view = await consent.view(tx); currentAuth(req, d, auth);
        audit({ event: 'public_login_authenticated', tx: redact(tx.id), credential: redact(credentialId) });
        return { authenticated: true, view };
      } catch (e) {
        tx.authenticated = null;
        if (++st.failures >= 5) transactions.cancel(tx);
        throw e;
      } finally { tx.verifying = false; }
    }
    if (path === '/authorize/consent/view') {
      currentAuth(req, d);
      const auth = tx.authenticated, view = await consent.view(tx); currentAuth(req, d, auth); return view;
    }
    if (path === '/authorize/consent') {
      currentAuth(req, d);
      if (d.accept !== true) throw limited('consent_required', 400);
      if (tx.consentBusy || tx.verifying) throw limited('ceremony_busy');
      tx.consentBusy = true;
      try {
        const auth = tx.authenticated, g = await consent.grantsFor(tx); currentAuth(req, d, auth);
        if (g !== auth.snapshot) throw limited('consent_changed', 400);
        const resume = transactions.approve(tx, { sub: subject, credentialId: auth.credentialId, credentialRp: auth.credentialRp, credentialOrigin: auth.credentialOrigin, credentialGeneration: auth.credentialGeneration, grants: g.grants });
        audit({ event: 'public_login_approved', tx: redact(tx.id), credential: redact(auth.credentialId) });
        return { resume: `${issuer}/resume?h=${encodeURIComponent(resume)}` };
      } finally { tx.consentBusy = false; }
    }
    throw limited('not_found', 404);
  }
  async function enrollmentApi(req, path, d) {
    boundedObject(d, path === '/enroll/options' ? ['ticket'] : ['ticket', 'response']);
    const cookie = cookies(req)[ENROLL_COOKIE];
    if (path === '/enroll/options') {
      const c = enrollment.options(d.ticket, cookie);
      return await passkeys.registrationOptions(c, new Uint8Array(Buffer.from(subject)));
    }
    const claim = enrollment.take(d.ticket, cookie);
    try {
      const id = await passkeys.register(d.response, claim.challenge, claim);
      audit({ event: 'public_passkey_enrolled', credential: redact(id) });
      return { enrolled: true };
    } catch (e) { claim.failed(); throw e; }
  }
  return {
    admitAuthorize(req) { authorizeBudget.take(req.socket.remoteAddress ?? 'peer'); },
    sweep() { authorizeBudget.sweep(); budget.sweep(); void enrollment.active; },
    page(tx, n) { return page('Sign in', `<h1>${esc(BRAND.name)} sign-in</h1><dl><dt>Client</dt><dd>${esc(tx.clientName ?? tx.clientId)} (${esc(tx.clientId)})</dd><dt>Returns to</dt><dd>${esc(new URL(tx.redirectUri).host)}</dd><dt>Access</dt><dd>${esc(tx.scope)}</dd><dt>Resource</dt><dd>${esc(tx.resource)}</dd></dl>
<p>Authenticate with your passkey, then review and explicitly approve the requested access.</p><button id="authenticate">Authenticate with passkey</button><dl id="consent"></dl><button id="approve" hidden>Approve connection</button><p id="status"></p>
<script nonce="${n}" src="/authorize/vendor/swa.js"></script><script nonce="${n}">${API}
const tx=${JSON.stringify(tx.statusId)};
function row(k,v){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=k;dd.textContent=v;$('consent').append(dt,dd);}
$('authenticate').onclick=async()=>{try{say('Waiting for passkey…');const options=await api('/authorize/passkey/options',{tx});const response=await SimpleWebAuthnBrowser.startAuthentication({optionsJSON:options});const r=await api('/authorize/passkey/verify',{tx,response});const v=r.view;$('consent').textContent='';row('Client',(v.clientName||'')+' ('+v.clientId+')');row('Returns to',v.returnsTo);row('Resource',v.resource);row('Access',v.scope);row('Consent',v.writes.consent);for(const e of v.writes.environments)row('Environment: '+e.alias,e.environmentId+' '+e.destination+'; '+(e.projects?e.projects.join(', '):'all current and future projects')+(v.scope.split(' ').includes('connector:write')&&e.actions>0?'; '+e.actions+' actions, full-access':''));for(const u of v.writes.unavailable)row('Unavailable',(u.alias||'')+' '+u.reason);$('approve').hidden=false;$('authenticate').hidden=true;say('Review the access above before approving.');}catch(e){say(e.message==='enrollment_required'?'Administrative enrollment of a public passkey is required.':e.message);}};
$('approve').onclick=async()=>{try{$('approve').disabled=true;const r=await api('/authorize/consent',{tx,accept:true});location.replace(r.resume);}catch(e){say(e.message);$('approve').disabled=false;$('approve').hidden=true;$('authenticate').hidden=false;}};
</script>`, n); },
    async handle(req, res, url) {
      const p = url.pathname, enrollRoute = ['/enroll', '/enroll/options', '/enroll/verify'].includes(p);
      const loginRoute = ['/authorize/passkey/options', '/authorize/passkey/verify', '/authorize/consent/view', '/authorize/consent'].includes(p);
      if (p === '/authorize/vendor/swa.js' && req.method === 'GET') { vendor ??= bundle(); res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/javascript' }); res.end(vendor); return true; }
      if (!enrollRoute && !loginRoute) return false;
      if ((enrollRoute && !enrollment.active) || (loginRoute && mode !== 'public')) { json(res, 404, { error: 'not_found' }); return true; }
      if (enrollRoute && p === '/enroll' && req.method === 'GET') {
        if (url.search) { json(res, 404, { error: 'not_found' }); return true; }
        const previous = cookies(req)[ENROLL_COOKIE], cookie = typeof previous === 'string' && /^[A-Za-z0-9_-]{43}$/.test(previous) ? previous : randomBytes(32).toString('base64url');
        html(res, 200, enrollmentPage, { 'Set-Cookie': `${ENROLL_COOKIE}=${cookie}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=900` }); return true;
      }
      if (req.method !== 'POST' || p === '/enroll') { json(res, 405, { error: 'method_not_allowed' }); return true; }
      // Admission and browser policy precede parsing, crypto and private inventory work.
      if (req.headers.origin !== issuer || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) { json(res, 403, { error: 'origin_invalid' }); return true; }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { json(res, 415, { error: 'json_only' }); return true; }
      let release;
      try {
        budget.take(req.socket.remoteAddress ?? 'peer'); release = worker.enter();
        const text = await deadline(readBody(req), 5000);
        let d; try { d = JSON.parse(text); } catch { throw limited('bad_json', 400); }
        const result = await (enrollRoute ? enrollmentApi(req, p, d) : loginApi(req, p, d));
        json(res, 200, result);
      } catch (e) {
        const status = e.status ?? 400;
        // Do not log input, handles, assertions, cookies, tickets or library errors.
        audit({ event: 'public_ceremony_rejected', reason: safeError(e) });
        json(res, status, { error: safeError(e) }, status === 429 ? { 'Retry-After': '1' } : {});
      } finally { release?.(); }
      return true;
    },
  };
}

const enrollmentPage = n => page('Enroll public passkey', `<h1>Enroll a public passkey</h1><p>This enrollment was authorized on the connector's administrative control page. The link is single use.</p><button id="enroll">Create passkey</button><p id="status"></p><script nonce="${n}" src="/authorize/vendor/swa.js"></script><script nonce="${n}">${API}
const ticket=new URLSearchParams(location.hash.slice(1)).get('ticket');history.replaceState(null,'',location.pathname);
$('enroll').onclick=async()=>{try{const options=await api('/enroll/options',{ticket});const response=await SimpleWebAuthnBrowser.startRegistration({optionsJSON:options});await api('/enroll/verify',{ticket,response});$('enroll').hidden=true;say('Public passkey enrolled. Start the connection from your client.');}catch(e){say(e.message);}};
</script>`, n);
