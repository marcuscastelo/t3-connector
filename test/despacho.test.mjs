// Despacho protegido (control-plane v1, §5): t3_dispatch_preflight e o dispatchGuard que o
// Dispatcher refaz logo antes do envio. Preflight nunca envia; guard recusa com dispatch_*.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao, LOCAL, REMOTO } from './apoio.mjs';
import { mensagem, projecao, thread } from './fixtures.mjs';
import { Dispatcher } from '../src/escrita/adapters.mjs';
import { fontesEscrita, preflightDespacho } from '../src/despacho.mjs';
import { setup, memoryJournal } from './escrita-fixtures.mjs';

const modelo = { slug: 'gpt-6.1-sol', capabilities: { optionDescriptors: [{ id: 'reasoningEffort', type: 'select', options: [{ id: 'high' }] }] } };
const provider = (extra = {}) => ({ instanceId: 'codex', enabled: true, installed: true, status: 'ready', auth: { status: 'authenticated' }, supportedRuntimeModes: ['full-access'], models: [modelo], ...extra });
const ms = { instanceId: 'codex', model: 'gpt-6.1-sol', options: [{ id: 'reasoningEffort', value: 'high' }] };
const ROOT = '/Users/dev/app';

function dadosDespacho() {
  const d = dadosPadrao();
  d.local.shell.snapshotSequence = 7;
  d.remoto.shell.snapshotSequence = 7;
  d.local.completo = { 't-comum': { snapshotSequence: 30, projection: { ...projecao({ mensagens: [mensagem()], runs: [{ id: 'run-1', ordinal: 1, status: 'completed' }] }), thread: { id: 't-comum' }, providerThreads: [] } } };
  return d;
}
async function cliente({ d = dadosDespacho(), providers = [provider()], lerArquivadas = async () => ({ snapshotSequence: 7, threads: [] }) } = {}) {
  const porBase = { 'http://127.0.0.1:3773/': LOCAL.environmentId, 'http://127.0.0.1:43773/': REMOTO.environmentId };
  const chamarImpl = async ({ baseUrl }) => ({ environment: { environmentId: porBase[String(baseUrl)] }, providers: structuredClone(providers) });
  return conectarMcp(ambientesFalsos(d), { lerArquivadas }, { chamarImpl });
}
const launch = (extra = {}) => ({ projectId: LOCAL.projeto, title: 'Frente nova', modelSelection: ms, runtimeMode: 'full-access', workspaceStrategy: { type: 'root' }, text: 'Implemente.', ...extra });
const expectedRoot = { projectId: LOCAL.projeto, workspace: { type: 'root', path: ROOT, branch: null } };
const dup = { environments: ['local', 'remoto'], population: 'all', selector: { title: { value: 'Frente nova' } } };
async function preflight(c, args) {
  const r = await c.callTool({ name: 't3_dispatch_preflight', arguments: { controlPlaneContractVersion: 1, environment: 'local', ...args } });
  return r.isError ? r : dados(r);
}
const codigos = (r) => r.reasons.map((x) => x.code);

test('launch root admissível: digest, observationId, workspace e duplicata não encontrada com population all', async () => {
  const c = await cliente();
  const r = await preflight(c, { action: 'thread.launch', input: launch(), expected: expectedRoot, duplicateCheck: dup });
  assert.equal(r.admissible, true, JSON.stringify(r.reasons));
  assert.match(r.inputDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(r.observationId, /^dispatch1_[0-9a-f]{32}$/);
  assert.equal(r.writeAuthorization, 'not_checked');
  assert.deepEqual(r.workspace, { type: 'root', path: ROOT, pathVerification: 'on_apply', branch: null, branchKnowledge: 'not_required' });
  assert.equal(r.duplicateCheck.resolution, 'not_found');
  assert.deepEqual(r.duplicateCheck.domain, [LOCAL.environmentId, REMOTO.environmentId].sort());
  const de_novo = await preflight(c, { action: 'thread.launch', input: launch(), expected: expectedRoot, duplicateCheck: dup });
  assert.equal(de_novo.observationId, r.observationId, 'determinístico');
});

test('launch recusado: frente existente, criação de worktree, modo implícito, caminho não aprovado, binding diferente, branch', async () => {
  const d = dadosDespacho();
  d.remoto.shell.threads.push(thread({ id: 'existe', projectId: REMOTO.projeto, title: 'Frente nova' }));
  const existe = await preflight(await cliente({ d }), { action: 'thread.launch', input: launch(), expected: expectedRoot, duplicateCheck: dup });
  assert.equal(existe.admissible, false);
  assert.equal(existe.observationId, null);
  assert.ok(codigos(existe).includes('front_exists'));
  const c = await cliente();
  const wt = await preflight(c, { action: 'thread.launch', input: launch({ workspaceStrategy: { type: 'worktree', baseRef: 'main' } }), expected: { projectId: LOCAL.projeto, workspace: { type: 'worktree', path: null, branch: null } }, duplicateCheck: dup });
  assert.ok(codigos(wt).includes('workspace_creation_preflight_unsupported'));
  const { runtimeMode, ...semModo } = launch();
  const implicito = await preflight(c, { action: 'thread.launch', input: semModo, expected: expectedRoot, duplicateCheck: dup });
  assert.ok(implicito.reasons.some((x) => x.code === 'dispatch_guard_required_fields_missing' && x.field === 'runtimeMode'));
  const fora = await preflight(c, { action: 'thread.launch', input: launch({ workspaceStrategy: { type: 'existing_worktree', worktreePath: '/tmp/outro' } }), expected: { projectId: LOCAL.projeto, workspace: { type: 'existing_worktree', path: '/tmp/outro', branch: null } }, duplicateCheck: dup });
  assert.ok(codigos(fora).includes('workspace_scope_denied'));
  const outroBinding = await preflight(c, { action: 'thread.launch', input: launch(), expected: { projectId: LOCAL.projeto, workspace: { type: 'root', path: '/Users/dev/outro', branch: null } }, duplicateCheck: dup });
  assert.ok(codigos(outroBinding).includes('dispatch_workspace_changed'));
  const branch = await preflight(c, { action: 'thread.launch', input: launch({ workspaceStrategy: { type: 'root', branch: 'feat/x' } }), expected: { projectId: LOCAL.projeto, workspace: { type: 'root', path: ROOT, branch: 'feat/x' } }, duplicateCheck: dup });
  assert.ok(codigos(branch).includes('workspace_evidence_unavailable'));
  const semDup = await preflight(c, { action: 'thread.launch', input: launch(), expected: expectedRoot });
  assert.ok(semDup.reasons.some((x) => x.field === 'duplicateCheck'));
});

test('launch: provider sem modo declarado e descoberta sem arquivadas falham fechado', async () => {
  const semModo = await preflight(await cliente({ providers: [provider({ supportedRuntimeModes: undefined })] }), { action: 'thread.launch', input: launch(), expected: expectedRoot, duplicateCheck: dup });
  assert.ok(codigos(semModo).includes('capability_unknown'));
  const semArquivo = await preflight(await cliente({ lerArquivadas: null }), { action: 'thread.launch', input: launch(), expected: expectedRoot, duplicateCheck: dup });
  assert.equal(semArquivo.complete, false);
  assert.ok(codigos(semArquivo).includes('front_discovery_incomplete'));
});

const send = (extra = {}) => ({ threadId: 't-comum', text: 'Continue.', clientRequestId: 'cont-1', delivery: 'start_immediately', ...extra });
const expectedSend = { projectId: LOCAL.projeto, workspace: { type: 'root', path: ROOT, branch: null } };

test('send: start_immediately ocioso é admissível; blockers de execution recusam; queue sem ativo; steer desconhecido; override proibido', async () => {
  const c = await cliente();
  const ok = await preflight(c, { action: 'thread.send', input: send(), expected: expectedSend });
  assert.equal(ok.admissible, true, JSON.stringify(ok.reasons));
  assert.equal(ok.expectedRunId, null);
  assert.match(ok.settlementObservationId, /^obs2_/);
  const fila = await preflight(c, { action: 'thread.send', input: send({ delivery: 'queue_after_active', deferUntilActiveCompletes: true }), expected: expectedSend });
  assert.ok(codigos(fila).includes('dispatch_no_active_run'));
  const steer = await preflight(c, { action: 'thread.send', input: send({ delivery: 'steer_active', targetRunId: 'run-1' }), expected: expectedSend });
  assert.ok(codigos(steer).includes('delivery_capability_unknown'));
  const override = await preflight(c, { action: 'thread.send', input: send({ onBackgroundWork: 'send' }), expected: expectedSend });
  assert.ok(codigos(override).includes('dispatch_override_unsupported'));
  const d = dadosDespacho();
  d.local.completo['t-comum'].projection.providerThreads = undefined;
  const desconhecido = await preflight(await cliente({ d }), { action: 'thread.send', input: send(), expected: expectedSend });
  assert.ok(desconhecido.reasons.some((x) => x.code === 'dispatch_unresolved_work' && x.blocker === 'background_work_unknown'));
  const outroProjeto = await preflight(c, { action: 'thread.send', input: send(), expected: { ...expectedSend, projectId: 'outro' } });
  assert.ok(codigos(outroProjeto).includes('dispatch_project_changed'));
});

test('preflight: dispatchGuard no input e duplicateCheck em send são entrada inválida', async () => {
  const c = await cliente();
  const comGuard = await preflight(c, { action: 'thread.send', input: send({ dispatchGuard: {} }), expected: expectedSend });
  assert.equal(comGuard.isError, true);
  const dupSend = await preflight(c, { action: 'thread.send', input: send(), expected: expectedSend, duplicateCheck: dup });
  assert.equal(dupSend.isError, true);
});

test('mesmo preflight pela fonte de escrita dá o mesmo inputDigest e observationId que a leitura', async () => {
  const d = dadosDespacho();
  const c = await cliente({ d });
  const leitura = await preflight(c, { action: 'thread.launch', input: launch(), expected: expectedRoot, duplicateCheck: dup });
  const conexao = (alias, environmentId, amb) => ({
    registro: { alias, environmentId, destination: `t3://${environmentId}` },
    cliente: async () => ({ shell: async () => structuredClone(d[amb].shell), threadCompleto: async (id) => d[amb].completo?.[id] }),
    adapter: { native: { rpc: async (tag) => (tag === 'server.getConfig' ? { environment: { environmentId }, providers: [provider()] } : { snapshotSequence: 7, threads: [] }) } },
  });
  const conexoes = [conexao('local', LOCAL.environmentId, 'local'), conexao('remoto', REMOTO.environmentId, 'remoto')];
  const scope = { environments: [{ environmentId: LOCAL.environmentId, projects: [{ id: LOCAL.projeto }] }, { environmentId: REMOTO.environmentId, projects: [{ id: REMOTO.projeto }] }] };
  const escrita = await preflightDespacho({ action: 'thread.launch', environment: LOCAL.environmentId, input: launch(), expected: expectedRoot, duplicateCheck: dup }, fontesEscrita(conexoes, scope));
  assert.equal(escrita.admissible, true, JSON.stringify(escrita.reasons));
  assert.equal(escrita.inputDigest, leitura.inputDigest);
  assert.equal(escrita.observationId, leitura.observationId);
  // Environment fora do grant: a descoberta não cobre o domínio pedido.
  const semRemoto = await preflightDespacho({ action: 'thread.launch', environment: LOCAL.environmentId, input: launch(), expected: expectedRoot, duplicateCheck: dup }, fontesEscrita(conexoes, { environments: [scope.environments[0]] }));
  assert.equal(semRemoto.admissible, false);
  assert.ok(codigos(semRemoto).includes('front_discovery_incomplete'));
});

// Dispatcher: o guard refaz o preflight injetado e recusa sem enviar.
async function dispatcher(preflightImpl) {
  const s = setup();
  const lease = await s.grant();
  const calls = [];
  const backgroundReads = [];
  const adapter = {
    verifyWorkspace: async () => true,
    projectForThread: async () => 'app',
    invoke: async (method, payload) => { calls.push({ method, payload }); return method === 'orchestration.launchThread' ? { threadId: payload.threadId, resumed: false } : { sequence: 5 }; },
    receipt: (r) => ('threadId' in r ? { threadId: r.threadId, resumed: r.resumed } : { sequence: r.sequence }),
    executionSnapshot: async () => { backgroundReads.push(1); return { signals: { backgroundWorkHoldsThread: false } }; },
  };
  const pedidos = [];
  const d = new Dispatcher({ gate: s.gate, adapter, journal: memoryJournal(), environmentId: s.env.environmentId, destination: s.env.destination,
    ...(preflightImpl ? { dispatchPreflight: async (p, o) => { pedidos.push({ p, o }); return preflightImpl(p); } } : {}) });
  const go = (operationId, action, input) => d.dispatch(s.caller, lease.leaseId, { operationId, action, input });
  return { go, calls, pedidos, backgroundReads };
}
const ok = (extra = {}) => ({ admissible: true, inputDigest: 'sha256:x', observationId: 'dispatch1_a', reasons: [], expectedRunId: null, ...extra });
const guardL = (extra = {}) => ({ version: 1, expectedInputDigest: 'sha256:x', expectedObservationId: 'dispatch1_a', expected: { projectId: 'app', workspace: { type: 'root', path: '/workspace/app', branch: null } }, duplicateCheck: dup, ...extra });
const launchApp = (guard) => ({ projectId: 'app', title: 'Nova', modelSelection: ms, runtimeMode: 'full-access', workspaceStrategy: { type: 'root' }, dispatchGuard: guard });

test('dispatcher: guard ok envia uma vez sem o guard no payload; devolve e repete createdThread no replay', async () => {
  const { go, calls, pedidos } = await dispatcher(async () => ok());
  const r = await go('l-1', 'thread.launch', launchApp(guardL()));
  assert.equal(r.state, 'completed');
  assert.equal(calls.length, 1);
  assert.equal('dispatchGuard' in calls[0].payload, false);
  assert.equal(r.createdThread.threadId, calls[0].payload.threadId);
  assert.equal(r.createdThread.projectId, 'app');
  assert.equal(r.workspacePostCheck, 'pending');
  assert.equal('dispatchGuard' in pedidos[0].p.input, false, 'preflight refeito sobre o input sem guard');
  assert.ok(pedidos[0].o.scope.environments.length > 0);
  const replay = await go('l-1', 'thread.launch', launchApp(guardL()));
  assert.deepEqual(replay.createdThread, r.createdThread);
  assert.equal(calls.length, 1);
});

test('dispatcher: digest, admissão, observação, run e versão diferentes recusam sem enviar; replay é resultado conhecido', async () => {
  const casos = [
    [ok({ inputDigest: 'sha256:y' }), 'dispatch_input_changed'],
    [ok({ admissible: false, observationId: null, reasons: [{ code: 'front_exists' }] }), 'dispatch_front_exists'],
    [ok({ observationId: 'dispatch1_b' }), 'dispatch_observation_changed'],
  ];
  for (const [resposta, code] of casos) {
    const { go, calls } = await dispatcher(async () => resposta);
    await assert.rejects(go(`op-${code}`, 'thread.launch', launchApp(guardL())), new RegExp(code));
    assert.equal(calls.length, 0, code);
    const replay = await go(`op-${code}`, 'thread.launch', launchApp(guardL()));
    assert.deepEqual({ state: replay.state, sent: replay.sent, reconciliationRequired: replay.reconciliationRequired, error: replay.error }, { state: 'rejected', sent: false, reconciliationRequired: false, error: code });
  }
  const run = await dispatcher(async () => ok({ expectedRunId: 'run-9' }));
  const sendG = { version: 1, expectedInputDigest: 'sha256:x', expectedObservationId: 'dispatch1_a', expected: { projectId: 'app', workspace: { type: 'root', path: '/workspace/app', branch: null } }, expectedRunId: null };
  await assert.rejects(run.go('s-1', 'thread.send', { threadId: 't', text: 'oi', clientRequestId: 's-1', delivery: 'start_immediately', dispatchGuard: sendG }), /dispatch_run_changed/);
  assert.equal(run.calls.length, 0);
  const v2 = await dispatcher(async () => ok());
  await assert.rejects(v2.go('v2', 'thread.launch', launchApp(guardL({ version: 2 }))), /dispatch_guard_version_unsupported/);
  const sem = await dispatcher(null);
  await assert.rejects(sem.go('sem', 'thread.launch', launchApp(guardL())), /dispatch_guard_unavailable/);
  assert.equal(sem.calls.length, 0);
});

test('dispatcher: send protegido não usa o preflight legado de fundo; send legado continua igual', async () => {
  const p = await dispatcher(async () => ok());
  const sendG = { version: 1, expectedInputDigest: 'sha256:x', expectedObservationId: 'dispatch1_a', expected: { projectId: 'app', workspace: { type: 'root', path: '/workspace/app', branch: null } }, expectedRunId: null };
  const r = await p.go('s-2', 'thread.send', { threadId: 't', text: 'oi', clientRequestId: 's-2', delivery: 'start_immediately', dispatchGuard: sendG });
  assert.equal(r.state, 'completed');
  assert.equal(p.backgroundReads.length, 0);
  assert.equal(p.pedidos.length, 1);
  const legado = await p.go('s-3', 'thread.send', { threadId: 't', text: 'oi', clientRequestId: 's-3', delivery: 'start_immediately' });
  assert.equal(legado.state, 'completed');
  assert.equal(p.backgroundReads.length, 1);
  assert.equal(p.pedidos.length, 1);
});
