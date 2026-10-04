// Throwaway spike harness: toy OAuth AS + MCP RS (public listener, meant to sit behind a quick
// tunnel) and a local control-plane with a WebAuthn login (127.0.0.1/::1 only, never tunnelled).
// No real backend, no real credentials. Tokens/codes/cookies are never logged in clear.
//
// Env: PUBLIC_BASE (https://xxx.trycloudflare.com or http://localhost:7534), PUBLIC_PORT (7534),
//      LOCAL_PORT (7533), STATE_DIR (./.state), MODE (button|302|oob), AT_TTL (60), IDLE (120)
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { Passkeys } from '../../src/escrita/webauthn.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT ?? 7534);
const LOCAL_PORT = Number(process.env.LOCAL_PORT ?? 7533);
const BASE = (process.env.PUBLIC_BASE ?? `http://localhost:${PUBLIC_PORT}`).replace(/\/$/, '');
const PUBLIC_HOST = new URL(BASE).host;
const LOCAL_ORIGIN = `http://localhost:${LOCAL_PORT}`;
const STATE = process.env.STATE_DIR ?? join(here, '.state');
const RESOURCE = `${BASE}/mcp`;
const PRMD_URL = `${BASE}/.well-known/oauth-protected-resource/mcp`;
const SCOPES = ['spike:read', 'spike:write'];
mkdirSync(STATE, { recursive: true, mode: 0o700 });

const flags = {
  mode: process.env.MODE ?? 'button',          // how /authorize reaches the local control-plane
  atTtl: Number(process.env.AT_TTL ?? 60),      // seconds
  idle: Number(process.env.IDLE ?? 120),        // seconds without an eligible tool call
  failNextRefresh: false,                       // next refresh -> invalid_grant + session dead
  requireLogin: true,
};

// ---- logging (redacted) ----
const h = v => (v ? createHash('sha256').update(String(v)).digest('hex').slice(0, 8) : null);
const LOG = join(STATE, 'events.jsonl');
function ev(event, data = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...data });
  appendFileSync(LOG, line + '\n');
  console.log(line);
}

// ---- state ----
const rnd = (n = 32) => randomBytes(n).toString('base64url');
const clients = new Map();   // client_id -> {kind, redirect_uris, auth_method, secretHash}
const txs = new Map();       // txId -> transaction
const byHandoff = new Map(); // handoff -> txId
const byOob = new Map();     // short code -> txId
const byResume = new Map();  // resume handle -> txId
const codes = new Map();     // hash(code) -> {...}
const sessions = new Map();  // sid -> {client_id, created, lastActivity, dead}
const ats = new Map();       // hash(at) -> {sid, exp, revoked}
const rts = new Map();       // hash(rt) -> {sid, used}
let sessionSeq = 0;
const now = () => Date.now();

function sessionState(sid) {
  const s = sessions.get(sid);
  if (!s) return 'unknown';
  if (s.dead) return s.dead;
  if (now() - s.lastActivity >= flags.idle * 1000) { s.dead = 'idle_expired'; ev('session.dead', { sid, reason: 'idle_expired' }); }
  return s.dead || 'active';
}
function kill(sid, reason) { const s = sessions.get(sid); if (s && !s.dead) { s.dead = reason; ev('session.dead', { sid, reason }); } }
function mintTokens(sid) {
  const at = rnd(), rt = rnd();
  ats.set(h(at), { sid, exp: now() + flags.atTtl * 1000, revoked: false });
  rts.set(h(rt), { sid, used: false });
  return { access_token: at, token_type: 'Bearer', expires_in: flags.atTtl, refresh_token: rt, scope: SCOPES.join(' '), _at: h(at), _rt: h(rt) };
}

// ---- passkeys (reuses the product verifier, unmodified) ----
const credFile = join(STATE, 'credentials.json');
const stored = existsSync(credFile) ? JSON.parse(readFileSync(credFile, 'utf8')) : [];
const credentials = new Map(stored.map(c => [c.id, { ...c, publicKey: Buffer.from(c.publicKey, 'base64url') }]));
const passkeys = new Passkeys({
  origin: LOCAL_ORIGIN, rpID: 'localhost', allowLocalhost: true, credentials,
  rpName: 'T3 Connector OAuth spike', userName: 'oauth-spike',
  saveCredential: async c => {
    const next = new Map(credentials); next.set(c.id, c);
    const tmp = credFile + '.next';
    writeFileSync(tmp, JSON.stringify([...next.values()].map(v => ({ ...v, publicKey: Buffer.from(v.publicKey).toString('base64url') }))), { mode: 0o600 });
    renameSync(tmp, credFile);
  },
});
const challenges = new Map(); // key -> {challenge, exp}
function newChallenge(key) { const c = rnd(); challenges.set(key, { challenge: c, exp: now() + 120_000 }); return c; }
function takeChallenge(key) { const c = challenges.get(key); challenges.delete(key); if (!c || c.exp < now()) throw new Error('challenge_expired'); return c.challenge; }

// ---- http helpers ----
const send = (res, status, body, headers = {}) => {
  const isJson = typeof body !== 'string';
  res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': isJson ? 'application/json' : 'text/html; charset=utf-8', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
};
const redirect = (res, location, headers = {}) => { res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers }); res.end(); };
async function readBody(req) {
  const parts = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 65536) throw new Error('body_too_large'); parts.push(c); }
  return Buffer.concat(parts).toString('utf8');
}
const cookies = req => Object.fromEntries((req.headers.cookie ?? '').split(';').map(s => s.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, v.join('=')]));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ua = req => {
  const u = req.headers['user-agent'] ?? '';
  const m = u.match(/(Firefox|Edg|OPR|Chrome|Safari)\/[\d.]+/);
  return { browser: m?.[0] ?? (u.slice(0, 40) || null), mobile: /Mobile|Android|iPhone/.test(u) };
};
const safeEq = (a, b) => a && b && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---- client resolution (DCR, CIMD, or rejected) ----
async function resolveClient(client_id) {
  if (clients.has(client_id)) return clients.get(client_id);
  if (/^https:\/\//.test(client_id)) {
    const r = await fetch(client_id, { signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('cimd_fetch_failed');
    const doc = await r.json();
    if (doc.client_id !== client_id) throw new Error('cimd_client_id_mismatch');
    const c = { kind: 'cimd', redirect_uris: doc.redirect_uris ?? [], auth_method: doc.token_endpoint_auth_method ?? 'none', name: doc.client_name ?? null, jwks: !!(doc.jwks || doc.jwks_uri) };
    clients.set(client_id, c);
    ev('client.cimd', { client: client_id, auth_method: c.auth_method, redirect_uris: c.redirect_uris, name: c.name, jwks: c.jwks });
    return c;
  }
  throw new Error('unknown_client');
}
function clientAuth(req, form) {
  const basic = req.headers.authorization?.match(/^Basic (.+)$/);
  if (basic) { const [id, secret] = Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent); return { method: 'client_secret_basic', client_id: id, secret }; }
  if (form.client_assertion) {
    let claims = {};
    try { claims = JSON.parse(Buffer.from(form.client_assertion.split('.')[1], 'base64url').toString()); } catch {}
    // Spike: signature NOT verified; we only record that private_key_jwt was used and its shape.
    return { method: 'private_key_jwt', client_id: form.client_id ?? claims.iss, assertion: { iss_eq_sub: claims.iss === claims.sub, aud: claims.aud, has_jti: !!claims.jti } };
  }
  if (form.client_secret) return { method: 'client_secret_post', client_id: form.client_id, secret: form.client_secret };
  return { method: 'none', client_id: form.client_id };
}

// ---- pages ----
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>
<style>body{font:16px system-ui;max-width:640px;margin:40px auto;padding:0 16px}code{background:#eee;padding:2px 4px}a.btn,button{display:inline-block;padding:10px 16px;background:#1a5;color:#fff;border:0;border-radius:6px;text-decoration:none;font-size:16px;cursor:pointer}.big{font-size:32px;letter-spacing:4px;font-family:monospace}pre{background:#f4f4f4;padding:8px;white-space:pre-wrap}</style></head><body>${body}</body></html>`;

function authorizePage(tx) {
  const local = `${LOCAL_ORIGIN}/login#handoff=${tx.handoff}`;
  if (tx.mode === 'oob') return page('Spike login', `<h1>T3 Connector spike — login</h1>
<p>Open the local control panel on <b>this computer</b>: <code>${esc(LOCAL_ORIGIN)}/login</code> and enter this code:</p>
<p class="big">${esc(tx.oob)}</p><p id="s">Waiting for local approval… keep this tab open.</p>
<script>const t=${JSON.stringify(tx.pub)};async function p(){try{const r=await fetch('/authorize/status?tx='+t,{credentials:'same-origin'});const v=await r.json();if(v.resume){document.getElementById('s').textContent='Approved, continuing…';location.replace(v.resume);return;}if(v.error){document.getElementById('s').textContent='Error: '+v.error;return;}}catch(e){}setTimeout(p,1500);}p();</script>`);
  return page('Spike login', `<h1>T3 Connector spike — login</h1>
<p>Client: <code>${esc(tx.client_id)}</code></p><p>This toy server needs a passkey on the local control panel of this computer.</p>
<p><a class="btn" id="go" href="${esc(local)}">Open local control (localhost)</a></p>
<p style="color:#666">If the button does nothing, copy <code>${esc(LOCAL_ORIGIN)}/login</code> into a normal browser tab and enter code <b>${esc(tx.oob)}</b>, then come back here.</p>
<script>const t=${JSON.stringify(tx.pub)};async function p(){try{const r=await fetch('/authorize/status?tx='+t,{credentials:'same-origin'});const v=await r.json();if(v.resume){location.replace(v.resume);return;}}catch(e){}setTimeout(p,2000);}p();</script>`);
}

const loginPage = page('Local passkey login', `<h1>Local control — passkey</h1>
<div id="code" hidden><p>Code shown on the login page: <input id="oob" autocomplete="off" style="font-size:20px;width:8em"> <button id="find">Find</button></p></div>
<pre id="view">Loading…</pre><p><button id="approve" hidden>Approve with passkey</button></p><p id="s"></p>
<script src="/vendor/swa.js"></script>
<script>
const $=id=>document.getElementById(id);const say=t=>$('s').textContent=t;
const api=async(p,d)=>{const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});const v=await r.json();if(!r.ok)throw new Error(v.error||r.status);return v;};
let ref=null;const frag=new URLSearchParams(location.hash.slice(1)).get('handoff');history.replaceState(null,'',location.pathname);
async function show(r){ref=r;const v=await api('/api/view',r);$('view').textContent='Client: '+v.client_id+'\\nReturns to: '+v.redirect_host+'\\nScope: '+v.scope+'\\nResource: '+v.resource+'\\nMode: '+v.mode;$('approve').hidden=false;}
$('find').onclick=()=>show({oob:$('oob').value.trim().toUpperCase()}).catch(e=>say(e.message));
$('approve').onclick=async()=>{try{say('Waiting for passkey…');const o=await api('/api/login/options',ref);const resp=await SimpleWebAuthnBrowser.startAuthentication({optionsJSON:o});const v=await api('/api/login/verify',{...ref,response:resp});
 if(v.mode==='oob'){say('Approved. Go back to the login tab; it continues by itself. You can close this tab.');$('approve').hidden=true;}else{say('Approved, returning…');location.replace(v.resume);}}catch(e){say('Error: '+e.message);}};
if(!window.isSecureContext||!window.PublicKeyCredential)say('This browser context does not allow passkeys (isSecureContext='+window.isSecureContext+').');
if(frag)show({handoff:frag}).catch(e=>say(e.message));else{$('code').hidden=false;$('view').textContent='';}
</script>`);

const enrollPage = page('Enroll spike passkey', `<h1>Enroll spike passkey (RP localhost)</h1>
<p>Creates a test passkey named <code>oauth-spike</code> for <code>localhost</code>. Delete it from your passkey manager after the spike.</p>
<p><button id="go">Create passkey</button></p><p id="s"></p><script src="/vendor/swa.js"></script>
<script>const say=t=>document.getElementById('s').textContent=t;
const api=async(p,d)=>{const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});const v=await r.json();if(!r.ok)throw new Error(v.error||r.status);return v;};
document.getElementById('go').onclick=async()=>{try{const o=await api('/api/enroll/options',{});const resp=await SimpleWebAuthnBrowser.startRegistration({optionsJSON:o});const v=await api('/api/enroll/verify',{response:resp});say('Enrolled ('+v.credentials+' credential(s)).');}catch(e){say('Error: '+e.message);}};</script>`);

const adminPage = page('Spike control', `<h1>OAuth spike — local control</h1>
<p><a href="/enroll">Enroll passkey</a> · MCP URL for ChatGPT: <code>${esc(RESOURCE)}</code></p>
<p>Login mode: <select id="mode"><option>button</option><option>302</option><option>oob</option></select>
<button data-a="/admin/fail-next-refresh">Fail next refresh (invalid_grant)</button>
<button data-a="/admin/kill-sessions">Kill sessions (401 + invalid_grant)</button>
<button data-a="/admin/revoke-ats">Revoke ATs only (401, refresh ok)</button></p>
<p>Note for the log: <input id="note" style="width:24em"> <button id="mark">Mark</button></p>
<pre id="state"></pre><h3>Recent events (UTC, redacted)</h3><pre id="ev" style="font-size:12px"></pre>
<script>
const api=(p,d={})=>fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}).then(r=>r.json());
document.querySelectorAll('button[data-a]').forEach(b=>b.onclick=()=>api(b.dataset.a).then(load));
document.getElementById('mode').onchange=e=>api('/admin/set',{mode:e.target.value}).then(load);
document.getElementById('mark').onclick=()=>api('/admin/mark',{note:document.getElementById('note').value}).then(()=>{document.getElementById('note').value='';load();});
async function load(){const s=await fetch('/admin/state').then(r=>r.json());document.getElementById('mode').value=s.flags.mode;document.getElementById('state').textContent=JSON.stringify({flags:s.flags,credentials:s.credentials,clients:s.clients.length,sessions:s.sessions,tokens:s.tokens},null,1);
const e=await fetch('/admin/events').then(r=>r.json());document.getElementById('ev').textContent=e.reverse().map(x=>{const{t,event,...r}=x;return t.slice(11,19)+' '+event+' '+JSON.stringify(r).slice(0,180)}).join('\\n');}
load();setInterval(load,3000);
</script>`);

// ---- MCP ----
function mcpServer(sid) {
  const s = new McpServer({ name: 'oauth-spike', version: '0.0.1' });
  s.registerTool('spike_now', { description: 'Harmless spike tool: returns the server time. No data behind it.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: 'text', text: `server time ${new Date().toISOString()} (session ${sid})` }] }));
  s.registerTool('spike_echo', { description: 'Harmless spike tool: echoes the given text back.', inputSchema: { text: z.string().max(200) }, annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }));
  return s;
}
function unauthorized(res, error, rpc) {
  const parts = [`Bearer resource_metadata="${PRMD_URL}"`, `scope="${SCOPES.join(' ')}"`];
  if (error) parts.push(`error="invalid_token"`, `error_description="${error}"`);
  ev('mcp.401', { reason: error ?? 'no_token', rpc });
  send(res, 401, { error: error ? 'invalid_token' : 'unauthorized' }, { 'WWW-Authenticate': parts.join(', ') });
}
async function handleMcp(req, res) {
  let body;
  if (req.method === 'POST') { const raw = await readBody(req); try { body = raw ? JSON.parse(raw) : undefined; } catch { body = null; } }
  const msgs = Array.isArray(body) ? body : body ? [body] : [];
  const rpc = msgs.map(m => m.method === 'tools/call' ? `tools/call:${m.params?.name}` : m.method ?? 'response').join(',') || req.method;
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!bearer) return unauthorized(res, null, rpc);
  if (body === null) return send(res, 400, { error: 'bad_json' });
  const at = ats.get(h(bearer));
  if (!at) return unauthorized(res, 'unknown_token', rpc);
  if (at.revoked) return unauthorized(res, 'token_revoked', rpc);
  if (at.exp <= now()) return unauthorized(res, 'token_expired', rpc);
  const st = sessionState(at.sid);
  if (st !== 'active') return unauthorized(res, `session_${st}`, rpc);
  if (msgs.some(m => m.method === 'tools/call')) sessions.get(at.sid).lastActivity = now(); // only eligible activity
  ev('mcp.ok', { sid: at.sid, at: h(bearer), rpc, http: req.method });
  const server = mcpServer(at.sid);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// ---- public listener: AS + RS ----
async function publicHandler(req, res) {
  const url = new URL(req.url, BASE);
  const p = url.pathname;
  if (req.headers.host !== PUBLIC_HOST) { ev('public.bad_host', { host: req.headers.host }); return send(res, 421, { error: 'misdirected' }); }
  if (p.startsWith('/.well-known/')) ev('discovery', { path: p, ua: ua(req).browser });
  if (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp')
    return send(res, 200, { resource: RESOURCE, authorization_servers: [BASE], scopes_supported: SCOPES, bearer_methods_supported: ['header'], resource_name: 'T3 Connector OAuth spike' });
  if (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/openid-configuration' || p === '/.well-known/oauth-authorization-server/mcp')
    return send(res, 200, {
      issuer: BASE, authorization_endpoint: `${BASE}/authorize`, token_endpoint: `${BASE}/token`, registration_endpoint: `${BASE}/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic', 'private_key_jwt'],
      token_endpoint_auth_signing_alg_values_supported: ['RS256', 'ES256'],
      scopes_supported: SCOPES, authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: true,
    });
  if (p === '/register' && req.method === 'POST') {
    let m; try { m = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid_client_metadata' }); }
    const redirect_uris = Array.isArray(m.redirect_uris) ? m.redirect_uris.filter(u => typeof u === 'string') : [];
    if (!redirect_uris.length) return send(res, 400, { error: 'invalid_redirect_uri' });
    const auth_method = m.token_endpoint_auth_method ?? 'client_secret_basic';
    const client_id = `dcr-${rnd(12)}`, secret = auth_method === 'none' ? undefined : rnd();
    clients.set(client_id, { kind: 'dcr', redirect_uris, auth_method, secretHash: secret && h(secret), name: m.client_name ?? null });
    ev('client.dcr', { client: client_id, auth_method, redirect_uris, name: m.client_name ?? null, grant_types: m.grant_types, scope: m.scope });
    return send(res, 201, { client_id, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), client_id_issued_at: Math.floor(now() / 1000), redirect_uris, token_endpoint_auth_method: auth_method, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  }
  if (p === '/authorize' && req.method === 'GET') {
    const q = Object.fromEntries(url.searchParams);
    let client;
    try { client = await resolveClient(q.client_id); } catch (e) { ev('authorize.reject', { reason: e.message, client: q.client_id }); return send(res, 400, page('Error', `<p>Invalid client: ${esc(e.message)}</p>`)); }
    if (!client.redirect_uris.includes(q.redirect_uri)) { ev('authorize.reject', { reason: 'redirect_uri_mismatch', client: q.client_id, redirect_uri: q.redirect_uri }); return send(res, 400, page('Error', '<p>redirect_uri not registered</p>')); }
    const back = (error) => { const u = new URL(q.redirect_uri); u.searchParams.set('error', error); if (q.state) u.searchParams.set('state', q.state); u.searchParams.set('iss', BASE); return redirect(res, u.href); };
    const info = { client: q.client_id, kind: client.kind, response_type: q.response_type, pkce: q.code_challenge_method, has_state: !!q.state, state: h(q.state), resource: q.resource ?? null, scope: q.scope ?? null, prompt: q.prompt ?? null, ua: ua(req), mode: flags.mode, redirect_uri: q.redirect_uri };
    if (q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !q.code_challenge) { ev('authorize.reject', { ...info, reason: 'invalid_request' }); return back('invalid_request'); }
    if (q.resource && q.resource !== RESOURCE) { ev('authorize.reject', { ...info, reason: 'invalid_target' }); return back('invalid_target'); }
    const txId = rnd(), cookie = rnd(), tx = {
      id: txId, pub: rnd(9), client_id: q.client_id, redirect_uri: q.redirect_uri, state: q.state, code_challenge: q.code_challenge,
      resource: q.resource ?? null, scope: q.scope ?? SCOPES.join(' '), cookieHash: h(cookie), handoff: rnd(18), oob: randomBytes(4).toString('hex').toUpperCase().slice(0, 6),
      mode: flags.mode, created: now(), approved: false, resume: null, used: false,
    };
    txs.set(txId, tx); byHandoff.set(tx.handoff, txId); byOob.set(tx.oob, txId);
    ev('authorize', { ...info, tx: h(txId) });
    const setCookie = `spike_tx=${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`;
    if (flags.mode === '302') return redirect(res, `${LOCAL_ORIGIN}/login#handoff=${tx.handoff}`, { 'Set-Cookie': setCookie });
    return send(res, 200, authorizePage(tx), { 'Set-Cookie': setCookie });
  }
  if (p === '/authorize/status') {
    const tx = [...txs.values()].find(t => t.pub === url.searchParams.get('tx'));
    if (!tx || h(cookies(req).spike_tx) !== tx.cookieHash) return send(res, 403, { error: 'tx_cookie_mismatch' });
    if (tx.created + 600_000 < now()) return send(res, 200, { error: 'expired' });
    return send(res, 200, tx.approved && !tx.used ? { resume: `${BASE}/resume?h=${tx.resume}` } : { pending: true });
  }
  if (p === '/resume') {
    const txId = byResume.get(url.searchParams.get('h') ?? ''), tx = txs.get(txId);
    const cookieOk = !!tx && h(cookies(req).spike_tx) === tx.cookieHash;
    ev('resume', { tx: h(txId), found: !!tx, cookie_present: !!cookies(req).spike_tx, cookie_ok: cookieOk, approved: tx?.approved, used: tx?.used, ua: ua(req) });
    if (!tx || !cookieOk || !tx.approved || tx.used || tx.created + 600_000 < now()) return send(res, 400, page('Error', '<p>Login transaction invalid or expired. Restart the connection from the client.</p>'));
    tx.used = true;
    const code = rnd();
    codes.set(h(code), { tx, exp: now() + 60_000, used: false });
    const u = new URL(tx.redirect_uri); u.searchParams.set('code', code); if (tx.state) u.searchParams.set('state', tx.state); u.searchParams.set('iss', BASE);
    ev('callback.redirect', { tx: h(txId), code: h(code), state: h(tx.state), iss: true, redirect_host: u.host });
    return redirect(res, u.href, { 'Set-Cookie': 'spike_tx=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' });
  }
  if (p === '/token' && req.method === 'POST') {
    const raw = await readBody(req);
    const form = (req.headers['content-type'] ?? '').includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    const auth = clientAuth(req, form), client = clients.get(auth.client_id);
    const base = { grant_type: form.grant_type, client: auth.client_id, auth_method: auth.method, assertion: auth.assertion, resource: form.resource ?? null, scope: form.scope ?? null, ua: req.headers['user-agent']?.slice(0, 40) ?? null };
    const fail = (error, reason, status = 400) => { ev('token.error', { ...base, error, reason }); return send(res, status, { error, error_description: reason }); };
    if (!client) return fail('invalid_client', 'unknown_client', 401);
    if (client.secretHash && h(auth.secret) !== client.secretHash) return fail('invalid_client', 'bad_secret', 401);
    if (form.grant_type === 'authorization_code') {
      const c = codes.get(h(form.code));
      if (!c || c.used || c.exp < now()) return fail('invalid_grant', c?.used ? 'code_reused' : 'code_unknown_or_expired');
      c.used = true;
      const { tx } = c;
      if (tx.client_id !== auth.client_id) return fail('invalid_grant', 'client_mismatch');
      if (form.redirect_uri && form.redirect_uri !== tx.redirect_uri) return fail('invalid_grant', 'redirect_uri_mismatch');
      const pkceOk = !!form.code_verifier && safeEq(createHash('sha256').update(form.code_verifier).digest('base64url'), tx.code_challenge);
      if (!pkceOk) return fail('invalid_grant', 'pkce_failed');
      if (form.resource && form.resource !== RESOURCE) return fail('invalid_target', 'resource_mismatch');
      const sid = `s${++sessionSeq}`;
      sessions.set(sid, { client_id: auth.client_id, created: now(), lastActivity: now(), dead: null });
      const t = mintTokens(sid);
      ev('token.issued', { ...base, sid, pkce_ok: true, at: t._at, rt: t._rt, at_ttl: flags.atTtl });
      delete t._at; delete t._rt; return send(res, 200, t);
    }
    if (form.grant_type === 'refresh_token') {
      const key = h(form.refresh_token), r = rts.get(key);
      if (!r) return fail('invalid_grant', 'rt_unknown');
      if (r.used) { kill(r.sid, 'rt_reuse'); return fail('invalid_grant', 'rt_reuse'); }
      r.used = true;
      if (flags.failNextRefresh) { flags.failNextRefresh = false; kill(r.sid, 'forced_invalid_grant'); return fail('invalid_grant', 'forced_by_admin'); }
      const st = sessionState(r.sid);
      if (st !== 'active') return fail('invalid_grant', `session_${st}`);
      const t = mintTokens(r.sid);
      ev('token.refreshed', { ...base, sid: r.sid, old_rt: key, at: t._at, rt: t._rt });
      delete t._at; delete t._rt; return send(res, 200, t);
    }
    return fail('unsupported_grant_type', String(form.grant_type));
  }
  if (p === '/mcp') return handleMcp(req, res);
  if (p === '/' || p === '/favicon.ico') return send(res, 404, { error: 'not_found' });
  ev('public.404', { path: p, method: req.method });
  return send(res, 404, { error: 'not_found' });
}

// ---- local control-plane (loopback only) ----
const swaBundle = readFileSync(join(here, '../../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js'));
function txFromRef({ handoff, oob }) {
  const txId = handoff ? byHandoff.get(handoff) : byOob.get(String(oob ?? ''));
  const tx = txs.get(txId);
  if (!tx || tx.approved || tx.created + 600_000 < now()) throw new Error('transaction_not_found');
  return tx;
}
function redactedState() {
  return {
    flags, base: BASE, resource: RESOURCE, credentials: credentials.size,
    clients: [...clients.entries()].map(([id, c]) => ({ id, kind: c.kind, auth_method: c.auth_method, redirect_uris: c.redirect_uris })),
    sessions: [...sessions.entries()].map(([sid, s]) => ({ sid, client: s.client_id, state: sessionState(sid), age_s: Math.round((now() - s.created) / 1000), idle_s: Math.round((now() - s.lastActivity) / 1000) })),
    tokens: { at_live: [...ats.values()].filter(a => !a.revoked && a.exp > now()).length, rt_unused: [...rts.values()].filter(r => !r.used).length },
  };
}
async function localHandler(req, res) {
  const url = new URL(req.url, LOCAL_ORIGIN), p = url.pathname;
  if (req.headers.host !== `localhost:${LOCAL_PORT}` || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return send(res, 403, { error: 'forbidden' });
  if (req.method === 'GET') {
    if (p === '/vendor/swa.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(swaBundle); }
    if (p === '/login') { ev('local.login_page', { ua: ua(req), referer_host: req.headers.referer ? new URL(req.headers.referer).host : null, sec_fetch_site: req.headers['sec-fetch-site'] ?? null }); return send(res, 200, loginPage); }
    if (p === '/enroll') return send(res, 200, enrollPage);
    if (p === '/admin/state') return send(res, 200, redactedState());
    if (p === '/admin/events') { const lines = readFileSync(LOG, 'utf8').trim().split('\n').slice(-40); return send(res, 200, lines.map(l => JSON.parse(l))); }
    if (p === '/') return send(res, 200, adminPage);
    return send(res, 404, { error: 'not_found' });
  }
  // POSTs: JSON only; browser calls must carry our exact Origin (curl sends none).
  if (req.method !== 'POST' || !(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'json_only' });
  const origin = req.headers.origin;
  if (origin && origin !== LOCAL_ORIGIN) return send(res, 403, { error: 'origin_invalid' });
  let d; try { d = JSON.parse((await readBody(req)) || '{}'); } catch { return send(res, 400, { error: 'bad_json' }); }
  try {
    switch (p) {
      case '/api/enroll/options': if (!origin) throw new Error('origin_required'); return send(res, 200, await passkeys.registrationOptions(newChallenge('enroll'), new Uint8Array(randomBytes(16))));
      case '/api/enroll/verify': { const id = await passkeys.register(d.response, takeChallenge('enroll')); ev('local.enrolled', { cred: h(id) }); return send(res, 200, { credentials: credentials.size }); }
      case '/api/view': { const tx = txFromRef(d); ev('local.view', { tx: h(tx.id), via: d.handoff ? 'handoff' : 'oob' }); return send(res, 200, { client_id: tx.client_id, redirect_host: new URL(tx.redirect_uri).host, scope: tx.scope, resource: tx.resource, mode: tx.mode }); }
      case '/api/login/options': { if (!origin) throw new Error('origin_required'); const tx = txFromRef(d); return send(res, 200, await passkeys.options(newChallenge(`login:${tx.id}`))); }
      case '/api/login/verify': {
        const tx = txFromRef(d);
        const cred = await passkeys.verify({ response: d.response, challenge: takeChallenge(`login:${tx.id}`), origin });
        tx.approved = true; tx.resume = rnd(18); byResume.set(tx.resume, tx.id); byHandoff.delete(tx.handoff); byOob.delete(tx.oob);
        ev('local.uv_ok', { tx: h(tx.id), cred: h(cred), via: d.handoff ? 'handoff' : 'oob', mode: tx.mode });
        return send(res, 200, { mode: tx.mode, resume: `${BASE}/resume?h=${tx.resume}` });
      }
      case '/admin/set': for (const k of ['mode', 'atTtl', 'idle']) if (d[k] !== undefined) flags[k] = d[k]; ev('admin.set', { flags }); return send(res, 200, flags);
      case '/admin/fail-next-refresh': flags.failNextRefresh = true; ev('admin.fail_next_refresh'); return send(res, 200, flags);
      case '/admin/kill-sessions': for (const sid of sessions.keys()) kill(sid, 'admin_kill'); return send(res, 200, redactedState());
      case '/admin/revoke-ats': { let n = 0; for (const a of ats.values()) if (!a.revoked && a.exp > now()) { a.revoked = true; n++; } ev('admin.revoke_ats', { n }); return send(res, 200, { revoked: n }); }
      case '/admin/mark': ev('mark', { note: String(d.note ?? '').slice(0, 200) }); return send(res, 200, { ok: true });
      default: return send(res, 404, { error: 'not_found' });
    }
  } catch (e) {
    ev('local.error', { path: p, error: e.message });
    return send(res, 400, { error: /^[a-z_]+$/.test(e.message) ? e.message : 'rejected' });
  }
}

const wrap = fn => (req, res) => fn(req, res).catch(e => { ev('handler.crash', { error: e.message }); if (!res.headersSent) send(res, 500, { error: 'internal' }); });
const listen = (srv, port, host) => new Promise((ok, ko) => { srv.once('error', ko); srv.listen(port, host, ok); });
await listen(createServer(wrap(publicHandler)), PUBLIC_PORT, '127.0.0.1');
await listen(createServer(wrap(localHandler)), LOCAL_PORT, '127.0.0.1');
await listen(createServer(wrap(localHandler)), LOCAL_PORT, '::1').catch(() => {});
ev('harness.start', { base: BASE, local: LOCAL_ORIGIN, flags, credentials: credentials.size });
