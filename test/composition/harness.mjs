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
import { startConnector, freePort, http, setHttpTimeout } from '../oauth-apoio.mjs';
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
// Every HTTP call of the harness and of the synthetic client is bounded and destroyed on expiry.
setHttpTimeout(10_000);

// Doubled T3 backend: one environment, one project, one thread. Counts every outbound invoke. In
// scenario C the next invoke is held on a barrier (sent, no acknowledgement) until released.
let holdNext = null;
const sent = [];
const conexao = {
  registro: { alias: 'local', environmentId: 'env-p', destination: 't3://env-p', acoes: ['thread.send', 'thread.settle'] },
  inventario: async () => [{ id: 'app', name: 'app', directory: '/local/app' }],
  adapter: {
    prepare: async () => {},
    projectForThread: async id => (id === 'thread' ? 'app' : undefined),
    invoke: async (method, payload) => {
      sent.push({ method, commandId: payload.commandId });
      if (holdNext) { const h = holdNext; holdNext = null; h.reached(); await h.released; throw new Error('socket closed after write'); }
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
const withTimeout = (p, ms, what) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout: ${what}`)), ms); })]).finally(() => clearTimeout(t)); };
const until = async (cond, ms, what) => { const end = Date.now() + ms; while (!(await cond())) { if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(50); } };
// Readiness: sequential probes, each bounded, overall deadline.
const ready = (ms = 10_000) => until(async () => { try { return (await withTimeout(http('GET', `${c.issuer}/.well-known/oauth-protected-resource/mcp`), 1000, 'probe')).status === 200; } catch { return false; } }, ms, 'ingress ready');
const supervisor = supervisionarTransporte({
  iniciar: () => spawn(process.execPath, [join(here, 'ingress-proxy.mjs'), String(proxyPort), String(rsPort), modeFile], { stdio: ['ignore', 'ignore', 'pipe'] }),
  atrasoInicialMs: 500, atrasoMaximoMs: 4000, estabilidadeMs: 2000,
  aoIniciar: f => { starts++; current = f; f.stderr.on('data', d => appendFileSync(join(dir, 'ingress.log'), d)); log(`supervisor: ingress attempt ${starts} pid ${f.pid}`); },
  aoEncerrar: (f, s) => log(`supervisor: ingress exited (code ${s.codigo}, signal ${s.sinal ?? 'none'}, error ${s.erro ?? 'none'})`),
  aoFalhar: ms => log(`supervisor: relaunch in ${ms} ms`),
});

const issued = [];
const keep = t => { if (t?.access_token) issued.push(t.access_token, t.refresh_token); return t; };
const sid = at => c.connector.tokens.resolveAccess(at).sid;
const sessions = () => c.connector.authority.list();
const toolText = r => r.data?.result?.content?.[0]?.text ?? '';
const send = (at, id, text = 'composition') => c.callTool(at, writeToolName('thread.send'), { environment: 'local', operationId: id, input: { threadId: 'thread', text, clientRequestId: id, delivery: 'start_immediately' } });
const reconcile = (at, id) => c.callTool(at, 't3_reconciliar_escrita', { environment: 'local', operationId: id });

try {
  log(`dir ${dir}; supervisor sha256:${supervisorSha}; ingress :${proxyPort} -> RS :${rsPort}`);
  await ready();

  // A — ingress outage between calls: supervisor relaunches the ingress; refresh continues the same
  // session; refresh does not renew idle; no new authority.
  let tok = keep((await c.signIn()).tokens);
  const sidA = sid(tok.access_token);
  check('A0 sign-in through supervised ingress', !!sidA);
  const a1 = await withTimeout(c.callTool(tok.access_token, 't3_ambientes', { check: false }), 10_000, 'A1');
  check('A1 read through ingress', a1.status === 200 && !a1.data.error && !a1.data.result?.isError && /"environments"/.test(toolText(a1)), `status ${a1.status}`);
  c.advance(10 * 60_000);
  const killedAt = starts;
  current.kill('SIGKILL');
  let refused = false;
  try { await http('GET', `${c.issuer}/.well-known/oauth-protected-resource/mcp`); } catch { refused = true; }
  check('A2 ingress down is observable by the client', refused);
  await until(() => starts > killedAt, 10_000, 'relaunch'); await ready();
  check('A3 supervisor relaunched the ingress (same port, same issuer)', starts === killedAt + 1);
  const r = await c.refresh(tok.refresh_token);
  check('A4 refresh after the outage succeeds', r.status === 200, `status ${r.status}`);
  tok = keep(r.data);
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
  tok = keep((await c.refresh(tok.refresh_token)).data);
  const recB = JSON.parse(toolText(await reconcile(tok.access_token, 'op-b')) || '{}');
  check('B3 reconcile before repeating: completed', recB.state === 'completed', JSON.stringify({ state: recB.state, found: recB.observation?.found }));
  const again = JSON.parse(toolText(await send(tok.access_token, 'op-b')) || '{}');
  check('B4 repeating op-b returns completed without a new send', again.state === 'completed' && sent.length === 1, `state ${again.state}, sends ${sent.length}`);
  check('B5 same session throughout', sid(tok.access_token) === sidA);

  // C — the backend write is outstanding (sent, no acknowledgement) when the ingress dies: the
  // client gets no response; only then the send fails ambiguously. The operation becomes
  // uncertain, every OAuth session ends (fail closed), nothing is resent; after a new passkey
  // sign-in the operation is reconcilable and repeating it does not send again.
  let reached; const reachedP = new Promise(r => { reached = r; });
  let release; const released = new Promise(r => { release = r; });
  holdNext = { reached, released };
  const pendingC = send(tok.access_token, 'op-c').then(x => ({ status: x.status, body: x.text }), e => ({ error: e.message }));
  await withTimeout(reachedP, 10_000, 'op-c reached backend');
  check('C1 backend received op-c (held: sent, not acknowledged)', sent.length === 2, `sends ${sent.length}`);
  const beforeKill = starts, victim = current;
  const victimExit = new Promise(r => victim.once('exit', () => r()));
  victim.kill('SIGKILL');
  await withTimeout(victimExit, 5_000, 'ingress exit');
  const clientC = await pendingC;
  // A deadline is not a dropped connection: only a transport error counts, and the backend send is
  // still held at this point (released only below).
  check('C2 client got a transport error for op-c, no response, while the send was outstanding', !!clientC.error && !clientC.error.startsWith('timeout') && clientC.status === undefined && holdNext === null && sent.length === 2, clientC.error ?? `status ${clientC.status}`);
  release();
  await until(() => c.connector.authority.list().every(s => s.state !== 'active'), 10_000, 'fail closed');
  await until(() => starts > beforeKill, 10_000, 'relaunch'); await ready();
  const after = await c.mcp(tok.access_token, 'tools/list');
  check('C3 fail closed: old session refused (401)', after.status === 401);
  check('C4 refresh of the old session refused', (await c.refresh(tok.refresh_token)).data?.error === 'invalid_grant');
  const fresh = keep((await c.signIn()).tokens);
  check('C5 new passkey sign-in creates a new session', !!fresh && sid(fresh.access_token) !== sidA);
  const recC = JSON.parse(toolText(await reconcile(fresh.access_token, 'op-c')) || '{}');
  check('C6 op-c reconcilable after new sign-in: uncertain', recC.state === 'uncertain', JSON.stringify({ state: recC.state }));
  const againCState = JSON.parse(toolText(await send(fresh.access_token, 'op-c')) || '{}');
  check('C7 repeating op-c does not send again', sent.length === 2 && againCState.state === 'uncertain' && againCState.reconciliationRequired === true, `sends ${sent.length}, state ${againCState.state}`);

  check('Z1 total outbound sends = 2 (op-b once, op-c once)', sent.length === 2);
  const logs = ['harness.log', 'ingress.log'].map(f => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return ''; } }).join('') + readFileSync(join(c.connector.stateDir, 'events.jsonl'), 'utf8');
  check('Z2 none of the tokens issued during the run appear in harness, ingress or server logs', issued.length >= 6 && !issued.some(v => logs.includes(v)), `${issued.length} tokens checked`);
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
