// Real-browser rehearsal without ChatGPT: headless Chrome + CDP virtual authenticator (UV=true)
// drives /authorize on the public tunnel -> localhost control-plane -> /resume -> client callback,
// for each mode (button, 302, oob). Node plays the OAuth client (DCR + PKCE + /token + MCP call).
// Requires the harness up (./run.sh up) with STATE_DIR pointing to a throwaway dir.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const STATE = process.env.STATE_DIR ?? '.state';
const PUB = readFileSync(join(STATE, 'base'), 'utf8').trim();
const LOCAL = 'http://localhost:7533';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a.map(x => typeof x === 'string' ? x.replaceAll(PUB, '<BASE>') : x));

// --- fake client callback ---
const hits = [];
const cbServer = createServer((req, res) => { hits.push(new URL(req.url, 'http://127.0.0.1:7999')); res.end('callback received'); }).listen(7999, '127.0.0.1');
const CB = 'http://127.0.0.1:7999/cb';

// --- chrome + minimal CDP ---
const profile = mkdtempSync(join(tmpdir(), 'spike-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=9333', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
let version;
for (let i = 0; i < 40 && !version; i++) { await sleep(250); version = await fetch('http://127.0.0.1:9333/json/version').then(r => r.json()).catch(() => null); }
log('browser', version.Browser);
async function page() {
  const t = await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' }).then(r => r.json());
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(); const events = [];
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id) { pending.get(d.id)?.(d); pending.delete(d.id); } else events.push(d); };
  const send = (method, params = {}) => new Promise((ok, ko) => { const i = ++id; pending.set(i, d => d.error ? ko(new Error(`${method}: ${d.error.message}`)) : ok(d.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
  const waitFor = async (expr, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await evalJs(expr).catch(() => null); if (v) return v; await sleep(200); } throw new Error(`timeout waiting for ${expr} at ${await evalJs('location.href')}: ${await evalJs("document.body&&document.body.innerText.slice(0,200)")}`); };
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  return { send, evalJs, waitFor, events, close: () => ws.close() };
}
const p1 = await page();
await p1.send('WebAuthn.enable', { enableUI: false });
// Virtual authenticators are per-tab; oob mode uses a second tab, which gets its own below.
const vopts = { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true };
const { authenticatorId } = await p1.send('WebAuthn.addVirtualAuthenticator', { options: vopts });

// enroll in tab 1
await p1.send('Page.navigate', { url: `${LOCAL}/enroll` });
await p1.waitFor("document.readyState==='complete'&&!!document.getElementById('go')");
await p1.evalJs("document.getElementById('go').click()");
log('enroll:', await p1.waitFor("(t=>/Enrolled|Error/.test(t)&&t)(document.getElementById('s').textContent)"));

// OAuth client bits
const meta = await fetch(`${PUB}/.well-known/oauth-authorization-server`).then(r => r.json());
const reg = await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CB], token_endpoint_auth_method: 'none', client_name: 'chrome-e2e' }) }).then(r => r.json());
const admin = (path, body = {}) => fetch(LOCAL + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

async function run(mode) {
  await admin('/admin/set', { mode }); await admin('/admin/mark', { note: `chrome-e2e ${mode}` });
  hits.length = 0;
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(8).toString('hex');
  const u = new URL(meta.authorization_endpoint);
  Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: CB, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${PUB}/mcp`, scope: 'spike:read spike:write' }).forEach(([k, v]) => u.searchParams.set(k, v));
  await p1.send('Page.navigate', { url: u.href });
  if (mode === 'button') {
    await p1.waitFor("!!document.getElementById('go')");
    await p1.evalJs("document.getElementById('go').click()");
  }
  if (mode === 'oob') {
    const code = await p1.waitFor("(e=>e&&e.textContent)(document.querySelector('.big'))");
    const p2 = await page();
    await p2.send('WebAuthn.enable', { enableUI: false });
    const a2 = await p2.send('WebAuthn.addVirtualAuthenticator', { options: vopts });
    const { credentials } = await p1.send('WebAuthn.getCredentials', { authenticatorId }); // fresh signCount
    for (const c of credentials) await p2.send('WebAuthn.addCredential', { authenticatorId: a2.authenticatorId, credential: c });
    await p2.send('Page.navigate', { url: `${LOCAL}/login` });
    await p2.waitFor("!!document.getElementById('oob')&&!document.getElementById('code').hidden");
    await p2.evalJs(`document.getElementById('oob').value=${JSON.stringify(code)};document.getElementById('find').click()`);
    await p2.waitFor("!document.getElementById('approve').hidden");
    await p2.evalJs("document.getElementById('approve').click()");
    log(`  [${mode}] local tab:`, await p2.waitFor("(t=>/Approved|Error/.test(t)&&t)(document.getElementById('s').textContent)"));
    p2.close();
  } else {
    await p1.waitFor("location.origin==='http://localhost:7533'&&!document.getElementById('approve').hidden");
    log(`  [${mode}] reached`, await p1.evalJs('location.origin+location.pathname'), 'isSecureContext=', await p1.evalJs('isSecureContext'), 'fragment cleared=', await p1.evalJs("location.hash===''"));
    await p1.evalJs("document.getElementById('approve').click()");
  }
  const end = Date.now() + 20000; while (!hits.length && Date.now() < end) await sleep(200);
  if (!hits.length) throw new Error(`[${mode}] no callback; page at ${await p1.evalJs('location.href')}: ${await p1.evalJs('document.body.innerText.slice(0,200)')}`);
  const cb = hits[0];
  assert.equal(cb.searchParams.get('state'), state); assert.equal(cb.searchParams.get('iss'), meta.issuer);
  const tok = await fetch(meta.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: cb.searchParams.get('code'), code_verifier: verifier, redirect_uri: CB, client_id: reg.client_id, resource: `${PUB}/mcp` }) }).then(r => r.json());
  const out = await fetch(`${PUB}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'spike_now', arguments: {} } }) }).then(r => r.json());
  log(`  [${mode}] callback state ok, iss ok -> token -> MCP: ${out.result.content[0].text.slice(0, 32)}…`);
}

let failed = 0;
for (const mode of (process.argv[2] ?? 'button,302,oob').split(',')) {
  try { await run(mode); log(`PASS ${mode}`); } catch (e) { failed++; log(`FAIL ${mode}: ${e.message}`); }
}
const consoleErrs = p1.events.filter(e => e.method === 'Log.entryAdded' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')).map(e => e.params.entry?.text ?? e.params.args?.[0]?.value);
if (consoleErrs.length) log('browser console:', consoleErrs.slice(0, 10));
p1.close(); chrome.kill(); cbServer.close();
process.exit(failed ? 1 : 0);
