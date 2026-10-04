import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { stopwatch } from './session-authority.mjs';
import { Admission, deadline } from './limits.mjs';
import { json, html, readBody, page, redact } from './http.mjs';

// Local control-plane, served only on loopback with Host `localhost:<port>` (the WebAuthn RP is
// `localhost`). It never goes through the public ingress. Pages:
//   /login   approve a pending OAuth sign-in with a passkey (user verification required)
//   /enroll  register a passkey, gated by a one-time bootstrap ticket printed on the terminal
//   /        sessions, revoke, revoke all, kill switch (release needs a passkey)
// Every POST must be JSON with our exact Origin, so other sites cannot drive it from a browser.
const CHALLENGE_MS = 120 * 1000;
const swaBundle = () => readFileSync(join(dirname(dirname(createRequire(import.meta.url).resolve('@simplewebauthn/browser'))), 'dist/bundle/index.umd.min.js'));
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const FETCH_SITES = new Set(['cross-site', 'same-origin', 'same-site', 'none']);

export function controlPlane({ port, issuer, passkeys, subject, authority, tokens, transactions, killSwitch, enrollment, consent, admin, clock, wall, audit = () => {} }) {
  const origin = `http://localhost:${port}`, host = `localhost:${port}`, time = stopwatch({ clock, wall });
  const challenges = new Map();
  const adminAdmission = new Admission({ clock, wall, burst: 30, perMinute: 60 });
  let bundle;
  const newChallenge = key => { for (const [id, v] of challenges) if (time.elapsed(v.at) >= CHALLENGE_MS) challenges.delete(id); if (!challenges.has(key) && challenges.size >= 128) throw Object.assign(new Error('challenge_capacity'), { status: 429 }); const c = randomBytes(32).toString('base64url'); challenges.set(key, { c, at: time.mark() }); return c; };
  const takeChallenge = key => { const v = challenges.get(key); challenges.delete(key); if (!v || time.elapsed(v.at) >= CHALLENGE_MS) throw new Error('challenge_expired'); return v.c; };
  const grantsFor = consent.grantsFor;
  const txView = consent.view;

  async function api(p, d) {
    switch (p) {
      case '/api/login/view': { const tx = transactions.find(d); audit({ event: 'local_login_view', tx: redact(tx.id), via: d.handoff ? 'handoff' : 'oob' }); return await txView(tx); }
      case '/api/login/options': {
        if (authority.killed) throw new Error('kill_switch');
        const tx = transactions.find(d);
        if (tx.epoch !== authority.epoch) throw new Error('transaction_not_found');
        return passkeys.options(newChallenge(`login:${tx.id}`));
      }
      case '/api/credentials/options': return admin.options(d);
      case '/api/credentials/verify': return admin.verify(d);
      case '/api/login/verify': {
        if (authority.killed) throw new Error('kill_switch');
        const tx = transactions.find(d);
        const challenge = takeChallenge(`login:${tx.id}`);
        const { grants } = await grantsFor(tx);
        const credentialId = await passkeys.verify({ response: d.response, challenge, origin });
        // Re-checked after the awaits: a kill switch or revoke-all meanwhile cancels the sign-in.
        if (authority.killed || tx.epoch !== authority.epoch || !passkeys.current(credentialId)) throw new Error('transaction_not_found');
        const resume = transactions.approve(tx, { sub: subject, credentialId, credentialRp: 'localhost', credentialOrigin: origin, credentialGeneration: passkeys.version(credentialId), grants });
        audit({ event: 'local_login_approved', tx: redact(tx.id), credential: redact(credentialId), via: d.handoff ? 'handoff' : 'oob' });
        return { resume: `${issuer}/resume?h=${encodeURIComponent(resume)}`, via: d.handoff ? 'handoff' : 'oob' };
      }
      case '/api/enroll/options': {
        if (!enrollment.check(d.ticket)) throw new Error('enrollment_ticket_invalid');
        return passkeys.registrationOptions(newChallenge('enroll'), new Uint8Array(Buffer.from(subject)));
      }
      case '/api/enroll/verify': {
        if (!enrollment.check(d.ticket)) throw new Error('enrollment_ticket_invalid');
        const id = await passkeys.register(d.response, takeChallenge('enroll'));
        enrollment.consume();
        audit({ event: 'passkey_enrolled', credential: redact(id) });
        return { credentials: passkeys.credentials.size };
      }
      case '/api/sessions': return { killed: authority.killed, credentials: passkeys.credentials.size, sessions: authority.list().map(s => ({ ...s, credentialId: redact(s.credentialId) })), tokens: tokens.counts() };
      case '/api/sessions/revoke': { const ok = authority.revoke(String(d.sid ?? ''), 'revoked_locally'); audit({ event: 'local_revoke', sid: redact(d.sid), ok }); return { revoked: ok }; }
      case '/api/sessions/revoke-all': { const n = authority.revokeAll('revoked_locally'); audit({ event: 'local_revoke_all', n }); return { revoked: n }; }
      case '/api/kill': { const n = killSwitch.on(); return { killed: true, revoked: n }; }
      case '/api/release/options': return passkeys.options(newChallenge('release'));
      case '/api/release/verify': {
        await passkeys.verify({ response: d.response, challenge: takeChallenge('release'), origin });
        killSwitch.off();
        return { killed: false };
      }
      default: { const e = new Error('not_found'); e.status = 404; throw e; }
    }
  }

  return async function handle(req, res) {
    if (req.headers.host !== host || !LOOPBACK.has(req.socket.remoteAddress)) return json(res, 403, { error: 'forbidden' });
    const url = new URL(req.url, origin), p = url.pathname;
    if (req.method === 'GET') {
      if (p === '/vendor/swa.js') { bundle ??= swaBundle(); res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end(bundle); }
      if (p === '/login') { audit({ event: 'local_login_page', fetchSite: FETCH_SITES.has(req.headers['sec-fetch-site']) ? req.headers['sec-fetch-site'] : null }); return html(res, 200, loginPage); }
      if (p === '/enroll') return html(res, 200, enrollPage);
      if (p === '/') return html(res, 200, adminPage);
      return json(res, 404, { error: 'not_found' });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
    if (req.headers.origin !== origin) return json(res, 403, { error: 'origin_invalid' });
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'json_only' });
    let release;
    try {
      if (p.startsWith('/api/credentials/')) { adminAdmission.take('local-admin'); release = adminAdmission.enter(); }
      let d;
      try { d = JSON.parse((await deadline(readBody(req), 5000)) || '{}'); } catch (e) { return json(res, e.status ?? 400, { error: e.status ? e.message : 'bad_json' }); }
      if (!d || typeof d !== 'object') return json(res, 400, { error: 'bad_json' });
      try { return json(res, 200, await api(p, d)); } catch (e) {
        if (e.status === 404) return json(res, 404, { error: 'not_found' });
        audit({ event: 'local_error', error: /^[a-z_]+$/.test(e.message) ? e.message : 'rejected' });
        return json(res, e.status ?? 400, { error: /^[a-z_]+$/.test(e.message) ? e.message : 'rejected' });
      }
    } catch (e) { return json(res, e.status ?? 400, { error: /^[a-z_]+$/.test(e.message) ? e.message : 'rejected' }); } finally { release?.(); }
  };
}

// Bootstrap ticket for enrolling passkeys: random, single use, short lived, shown only on the
// terminal that started the server. Nothing remote can obtain or create one.
export function enrollmentTicket({ ttlMs = 15 * 60 * 1000, clock, wall } = {}) {
  const time = stopwatch({ clock, wall });
  let value = null, at = null;
  return {
    issue() { value = randomBytes(12).toString('base64url'); at = time.mark(); return value; },
    check(t) {
      if (!value || typeof t !== 'string' || time.elapsed(at) >= ttlMs) return false;
      const a = Buffer.from(t), b = Buffer.from(value);
      return a.length === b.length && timingSafeEqual(a, b);
    },
    consume() { value = null; },
  };
}

const api = `const api=async(p,d={})=>{const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});const v=await r.json();if(!r.ok)throw new Error(v.error||r.status);return v;};const $=id=>document.getElementById(id);const say=t=>$('s').textContent=t;`;

const loginPage = n => page('Approve sign-in', `<h1>Approve sign-in</h1>
<div id="code" hidden><p>Code shown on the sign-in page: <input id="oob" autocomplete="off" size="10"> <button id="find">Find</button></p></div>
<dl id="view"></dl><p><button id="approve" hidden>Approve with passkey</button></p><p id="s"></p>
<script src="/vendor/swa.js"></script>
<script nonce="${n}">${api}
let ref=null;const frag=new URLSearchParams(location.hash.slice(1)).get('handoff');history.replaceState(null,'',location.pathname);
function row(k,v){const dt=document.createElement('dt');dt.textContent=k;const dd=document.createElement('dd');dd.textContent=v;$('view').append(dt,dd);}
async function show(r){ref=r;const v=await api('/api/login/view',r);$('view').textContent='';row('Client',(v.clientName?v.clientName+' ':'')+'('+v.clientId+')');row('Returns to',v.returnsTo);row('Access',v.scope);row('Resource',v.resource);row('Consent',v.writes.consent);for(const e of v.writes.environments)row('Environment: '+e.alias,e.environmentId+' '+e.destination+'; '+(e.projects?e.projects.join(', '):'all current and future projects')+(v.scope.split(' ').includes('connector:write')&&e.actions>0?' ('+e.actions+' actions, full-access)':''));for(const u of v.writes.unavailable)row('Unavailable',(u.alias||'')+' '+u.reason);$('approve').hidden=false;$('code').hidden=true;say('');}
$('find').onclick=()=>show({oob:$('oob').value}).catch(e=>say('Error: '+e.message));
$('approve').onclick=async()=>{try{say('Waiting for passkey…');const o=await api('/api/login/options',ref);const response=await SimpleWebAuthnBrowser.startAuthentication({optionsJSON:o});const v=await api('/api/login/verify',{...ref,response});$('approve').hidden=true;
if(v.via==='oob'){say('Approved. Go back to the sign-in page; it continues by itself. You can close this tab.');}else{say('Approved, returning…');location.replace(v.resume);}}catch(e){say('Error: '+e.message);}};
if(!window.isSecureContext||!window.PublicKeyCredential)say('This browser context does not allow passkeys.');
if(frag)show({handoff:frag}).catch(e=>say('Error: '+e.message));else $('code').hidden=false;
</script>`, n);

const enrollPage = n => page('Enroll passkey', `<h1>Enroll a passkey</h1>
<p>Enter the enrollment ticket printed on the terminal that started the connector.</p>
<p><input id="ticket" autocomplete="off" size="24"> <button id="go">Create passkey</button></p><p id="s"></p>
<script src="/vendor/swa.js"></script>
<script nonce="${n}">${api}
$('go').onclick=async()=>{try{const ticket=$('ticket').value.trim();const o=await api('/api/enroll/options',{ticket});const response=await SimpleWebAuthnBrowser.startRegistration({optionsJSON:o});const v=await api('/api/enroll/verify',{ticket,response});say('Enrolled. '+v.credentials+' passkey(s) registered.');}catch(e){say('Error: '+e.message);}};
</script>`, n);

const adminPage = n => page('T3 Connector — local control', `<h1>Local control</h1>
<p><a href="/enroll">Enroll a passkey</a></p>
<p><button id="all" class="danger">Revoke all sessions</button> <button id="kill" class="danger">Kill switch</button> <button id="release" hidden>Release kill switch (passkey)</button></p>
<p><button id="public-enroll">Authorize public passkey enrollment</button> <button id="credentials">Manage credentials (local passkey)</button></p><p id="enrollment-link"></p><div id="qr"></div><div id="credential-list"></div>
<p id="s"></p><table><thead><tr><th>Session</th><th>Client</th><th>State</th><th>Idle (s)</th><th>Age (s)</th><th></th></tr></thead><tbody id="rows"></tbody></table>
<script src="/vendor/swa.js"></script>
<script nonce="${n}">${api}
async function load(){const v=await api('/api/sessions');$('release').hidden=!v.killed;$('kill').hidden=v.killed;say((v.killed?'KILL SWITCH ON. ':'')+v.credentials+' passkey(s); tokens '+JSON.stringify(v.tokens));const tb=$('rows');tb.textContent='';
for(const x of v.sessions){const tr=document.createElement('tr');for(const c of [x.sid.slice(0,8),x.clientId,x.state,x.idleSeconds,x.ageSeconds]){const td=document.createElement('td');td.textContent=c;tr.append(td);}const td=document.createElement('td');if(x.state==='active'){const b=document.createElement('button');b.className='danger';b.textContent='Revoke';b.onclick=()=>api('/api/sessions/revoke',{sid:x.sid}).then(load);td.append(b);}tr.append(td);tb.append(tr);}}
async function administration(action,rp,credentialId){const proof=await api('/api/credentials/options',{action,...(rp?{rp}:{}),...(credentialId?{credentialId}:{})});const response=await SimpleWebAuthnBrowser.startAuthentication({optionsJSON:proof.options});return api('/api/credentials/verify',{handle:proof.handle,response});}
function credentials(v){const box=$('credential-list');box.textContent='';for(const c of v.credentials){const p=document.createElement('p');p.textContent=c.rp+' ('+c.rpID+'): '+c.credentialId;const b=document.createElement('button');b.textContent='Remove with local passkey';b.onclick=async()=>{try{const v=await administration('remove',c.rp,c.credentialId);credentials(v);load();}catch(e){say(e.message);}};p.append(b);box.append(p);}}
$('credentials').onclick=async()=>{try{credentials(await administration('list'));}catch(e){say(e.message);}};
$('public-enroll').onclick=async()=>{try{const v=await administration('enroll-public');const a=document.createElement('a');a.href=v.link;a.textContent='Open public enrollment (single use, 15 minutes)';a.rel='noreferrer';$('enrollment-link').replaceChildren(a);const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 '+(v.qr.size+8)+' '+(v.qr.size+8));svg.setAttribute('width','240');svg.setAttribute('height','240');const background=document.createElementNS(ns,'rect');background.setAttribute('width','100%');background.setAttribute('height','100%');background.setAttribute('fill','white');svg.append(background);for(const [x,y] of v.qr.cells){const rect=document.createElementNS(ns,'rect');rect.setAttribute('x',x+4);rect.setAttribute('y',y+4);rect.setAttribute('width','1');rect.setAttribute('height','1');rect.setAttribute('fill','black');svg.append(rect);}$('qr').replaceChildren(svg);say('Public enrollment authorized. Treat the link and QR as a temporary administrative capability.');}catch(e){say(e.message);}};
$('all').onclick=()=>api('/api/sessions/revoke-all').then(load);
$('kill').onclick=()=>api('/api/kill').then(load);
$('release').onclick=async()=>{try{const o=await api('/api/release/options');const response=await SimpleWebAuthnBrowser.startAuthentication({optionsJSON:o});await api('/api/release/verify',{response});load();}catch(e){say('Error: '+e.message);}};
load().catch(e=>say('Error: '+e.message));setInterval(()=>load().catch(()=>{}),5000);
</script>`, n);

