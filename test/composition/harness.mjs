// Composition harness (isolated, no production): synthetic OAuth client (CIMD + private_key_jwt +
// software passkey) -> ingress proxy child process supervised by the Ponte's transport supervisor
// helper (supervisionarTransporte, t3-ponte b4fdfa9) -> OAuth AS/RS of this candidate -> session
// writes through the existing Dispatcher + a real SQLite journal -> doubled T3 backend that counts
// outbound sends. This is NOT the OpenAI tunnel-client and NOT ChatGPT: retries below are made by
// the synthetic client, never claimed as ChatGPT behaviour.
//
// Usage: node test/composition/harness.mjs <path to supervisionar-transporte.mjs>
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { startConnector, freePort, http } from '../oauth-apoio.mjs';
import { ambientesFalsos } from '../apoio.mjs';
import { t3Tools } from '../../src/oauth/t3-tools.mjs';
import { FileJournal } from '../../src/escrita/journal.mjs';
import { writeToolName } from '../../src/oauth/session-writes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const supervisorPath = process.argv[2];
if (!supervisorPath) { console.error('usage: harness.mjs <supervisionar-transporte.mjs>'); process.exit(2); }
const { supervisionarTransporte } = await import(pathToFileURL(supervisorPath).href);
const supervisorSha = createHash('sha256').update(readFileSync(supervisorPath)).digest('hex').slice(0, 12);

const dir = mkdtempSync(join(tmpdir(), 't3c-composition-'));
const logFile = join(dir, 'harness.log');
const brt = () => new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false });
const log = m => { const line = `${brt()} ${m}`; console.log(line); appendFileSync(logFile, line + '\n'); };
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Doubled T3 backend: one environment, one project, one thread. Counts every outbound invoke.
let failNextAfterSend = false;
const sent = [];
const conexao = {
  registro: { alias: 'local', environmentId: 'env-p', destination: 't3://env-p', acoes: ['thread.send', 'thread.settle'] },
  inventario: async () => [{ id: 'app', name: 'app', directory: '/local/app' }],
  adapter: {
    prepare: async () => {},
    projectForThread: async id => (id === 'thread' ? 'app' : undefined),
    invoke: async (method, payload) => {
      sent.push({ method, commandId: payload.commandId });
      if (failNextAfterSend) { failNextAfterSend = false; throw new Error('socket closed after write'); }
      return { sequence: sent.length };
    },
    receipt: r => ({ sequence: r.sequence }),
    reconcile: async r => ({ found: r.state === 'completed', state: r.state === 'completed' ? 'completed' : 'unknown' }),
  },
  fechar() {},
};
const journal = new FileJournal(join(dir, 'journal.sqlite'));
journal.audit = () => {};

// Ingress ports are fixed for the whole run so the issuer stays the same across relaunches.
const [proxyPort, rsPort] = [await freePort(), await freePort()];
const modeFile = join(dir, 'ingress-mode');
writeFileSync(modeFile, 'normal');
const c = await startConnector({
  config: { issuer: `http://localhost:${proxyPort}`, publicPort: rsPort },
  tools: t3Tools({ ambientes: ambientesFalsos(), conexoes: [conexao], journal }),
});

let starts = 0, current = null;
const ready = () => new Promise(res => { const t = setInterval(async () => { try { const r = await http('GET', `${c.issuer}/.well-known/oauth-protected-resource/mcp`); if (r.status === 200) { clearInterval(t); res(); } } catch {} }, 100); });
const supervisor = supervisionarTransporte({
  iniciar: () => spawn(process.execPath, [join(here, 'ingress-proxy.mjs'), String(proxyPort), String(rsPort), modeFile], { stdio: ['ignore', 'ignore', 'pipe'] }),
  atrasoInicialMs: 500, atrasoMaximoMs: 4000, estabilidadeMs: 2000,
  aoIniciar: f => { starts++; current = f; f.stderr.on('data', d => appendFileSync(join(dir, 'ingress.log'), d)); log(`supervisor: ingress attempt ${starts} pid ${f.pid}`); },
  aoEncerrar: (f, s) => log(`supervisor: ingress exited (code ${s.codigo}, signal ${s.sinal ?? 'none'}, error ${s.erro ?? 'none'})`),
  aoFalhar: ms => log(`supervisor: relaunch in ${ms} ms`),
});
await ready();

const sid = at => c.connector.tokens.resolveAccess(at).sid;
const sessions = () => c.connector.authority.list();
const toolText = r => r.data?.result?.content?.[0]?.text ?? '';
const send = (at, id, text = 'composition') => c.callTool(at, writeToolName('thread.send'), { environment: 'local', operationId: id, input: { threadId: 'thread', text, clientRequestId: id, delivery: 'start_immediately' } });
const reconcile = (at, id) => c.callTool(at, 't3_reconciliar_escrita', { environment: 'local', operationId: id });
const outage = async () => { const before = starts; current.kill('SIGKILL'); while (starts === before) await sleep(50); await ready(); };

try {
  log(`dir ${dir}; supervisor sha256:${supervisorSha}; ingress :${proxyPort} -> RS :${rsPort}`);

  // A — ingress outage between calls: supervisor relaunches the ingress; refresh continues the same
  // session; refresh does not renew idle; no new authority.
  let tok = (await c.signIn()).tokens;
  const sidA = sid(tok.access_token);
  check('A0 sign-in through supervised ingress', !!sidA);
  check('A1 read through ingress', !toolText(await c.callTool(tok.access_token, 't3_ambientes', { check: false })).includes('session_expired'));
  c.advance(10 * 60_000);
  const killedAt = starts;
  current.kill('SIGKILL');
  let refused = false;
  try { await http('GET', `${c.issuer}/.well-known/oauth-protected-resource/mcp`); } catch { refused = true; }
  check('A2 ingress down is observable by the client', refused);
  while (starts === killedAt) await sleep(50); await ready();
  check('A3 supervisor relaunched the ingress (same port, same issuer)', starts === killedAt + 1);
  const r = await c.refresh(tok.refresh_token);
  check('A4 refresh after the outage succeeds', r.status === 200, `status ${r.status}`);
  tok = r.data;
  check('A5 same session after outage + refresh', sid(tok.access_token) === sidA);
  const idleAfterRefresh = sessions().find(s => s.sid === sidA)?.idleSeconds ?? -1;
  check('A6 refresh did not renew idle', idleAfterRefresh >= 600, `idle ${idleAfterRefresh}s`);
  check('A7 no extra session or authority created', sessions().filter(s => s.state === 'active').length === 1 && !c.connector.authority.killed);

  // B — the write reaches the server and is sent; the response is lost in the ingress. The client
  // reconciles first, then repeats the same operationId: completed, exactly one outbound send.
  writeFileSync(modeFile, 'drop-response');
  let lost = false;
  try { const x = await send(tok.access_token, 'op-b'); lost = x.status !== 200; } catch { lost = true; }
  check('B1 client lost the response of op-b', lost);
  await ready();
  check('B2 backend received op-b exactly once', sent.length === 1, `sends ${sent.length}`);
  tok = (await c.refresh(tok.refresh_token)).data;
  const recB = JSON.parse(toolText(await reconcile(tok.access_token, 'op-b')) || '{}');
  check('B3 reconcile before repeating: completed', recB.state === 'completed', JSON.stringify({ state: recB.state, found: recB.observation?.found }));
  const again = JSON.parse(toolText(await send(tok.access_token, 'op-b')) || '{}');
  check('B4 repeating op-b returns completed without a new send', again.state === 'completed' && sent.length === 1, `state ${again.state}, sends ${sent.length}`);
  check('B5 same session throughout', sid(tok.access_token) === sidA);

  // C — the ingress dies while the backend write is ambiguous (sent, no acknowledgement): the
  // operation becomes uncertain, every OAuth session ends (fail closed), nothing is resent; after a
  // new passkey sign-in the operation is reconcilable and repeating it does not send again.
  failNextAfterSend = true;
  writeFileSync(modeFile, 'die-on-request');
  try { await send(tok.access_token, 'op-c'); } catch {}
  await sleep(300); await ready();
  check('C1 backend received op-c once (ambiguous)', sent.length === 2, `sends ${sent.length}`);
  const after = await c.mcp(tok.access_token, 'tools/list');
  check('C2 fail closed: old session refused (401)', after.status === 401);
  check('C3 refresh of the old session refused', (await c.refresh(tok.refresh_token)).data?.error === 'invalid_grant');
  const fresh = (await c.signIn()).tokens;
  check('C4 new passkey sign-in creates a new session', !!fresh && sid(fresh.access_token) !== sidA);
  const recC = JSON.parse(toolText(await reconcile(fresh.access_token, 'op-c')) || '{}');
  check('C5 op-c reconcilable after new sign-in: uncertain', recC.state === 'uncertain', JSON.stringify({ state: recC.state }));
  const againC = await send(fresh.access_token, 'op-c');
  const againCState = JSON.parse(toolText(againC) || '{}');
  check('C6 repeating op-c does not send again', sent.length === 2 && againCState.state === 'uncertain' && againCState.reconciliationRequired === true, `sends ${sent.length}, state ${againCState.state}`);

  check('Z1 total outbound sends = 2 (op-b once, op-c once)', sent.length === 2);
  const logText = readFileSync(logFile, 'utf8') + readFileSync(join(c.connector.stateDir, 'events.jsonl'), 'utf8');
  check('Z2 no tokens in harness or server logs', ![tok.access_token, tok.refresh_token, fresh.access_token, fresh.refresh_token].some(v => logText.includes(v)));
} catch (e) {
  check('harness error', false, e.stack?.split('\n').slice(0, 3).join(' | '));
} finally {
  supervisor.parar();
  await c.close();
  journal.close();
  const failed = results.filter(x => !x.ok).length;
  log(`SUMMARY ${results.length - failed}/${results.length} passed; ingress starts ${starts}; outbound sends ${sent.length}; dir ${dir}`);
  process.exit(failed ? 1 : 0);
}
