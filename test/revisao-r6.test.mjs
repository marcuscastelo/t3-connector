// Regressões da revisão R6 (cfc410e): turn items dentro da fronteira de validação, coleções de
// que a ociosidade depende obrigatórias, o fallback "só projeção" sem apagar dado inválido, e
// catálogos (projetos, providers, modelos, descritores) sem escolha pela ordem.
import test from 'node:test';
import assert from 'node:assert/strict';
import { derivarExecucao } from '../src/execucao.mjs';
import { lerObservacao, lerExecucaoDaThread, avaliarGuard } from '../src/settlement.mjs';
import { problemasDaProjecao } from '../src/validacao.mjs';
import { Dispatcher } from '../src/escrita/adapters.mjs';
import { aguardarThread } from '../src/espera.mjs';
import { elegibilidadeProvider } from '../src/rota.mjs';
import { setup, memoryJournal } from './escrita-fixtures.mjs';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao, LOCAL, REMOTO } from './apoio.mjs';
import { mensagem, projecao, thread } from './fixtures.mjs';

const proj = (extra = {}) => ({ ...projecao({ runs: [{ id: 'run-1', ordinal: 1, status: 'completed' }], mensagens: [mensagem()] }), thread: { id: 'thread-1', activeProviderThreadId: 'pt' }, providerThreads: [{ id: 'pt', pendingBackgroundTasks: [] }], ...extra });
const ler = (threads, p) => lerObservacao({ environmentId: 'e', threadId: 'thread-1', version: 2, lerShell: async () => ({ threads }), lerCompleto: async () => ({ snapshotSequence: 3, projection: p }) });
const guard = (o) => ({ version: 2, expectedRunId: 'run-1', expectedObservationId: o.observationId ?? 'x', acceptance: { accepted: true, evidenceRef: 'r' } });
const item = (extra = {}) => ({ id: 'ti', type: 'command_execution', status: 'completed', runId: 'run-1', ...extra });
const sem = (p, ...chaves) => { const c = { ...p }; for (const k of chaves) delete c[k]; return c; };

async function sendLegado(execucao) {
  const s = setup();
  const lease = await s.grant();
  const calls = [];
  const adapter = { verifyWorkspace: async () => true, projectForThread: async () => 'app', invoke: async (m, p) => { calls.push(p); return { sequence: 1 }; }, receipt: (r) => r, executionSnapshot: async () => execucao };
  const d = new Dispatcher({ gate: s.gate, adapter, journal: memoryJournal(), environmentId: s.env.environmentId, destination: s.env.destination });
  const r = await d.dispatch(s.caller, lease.leaseId, { operationId: 'op', action: 'thread.send', input: { threadId: 't', text: 'oi', clientRequestId: 'op', delivery: 'start_immediately' } });
  return { r, calls };
}

const TURN_ITEMS_MALFORMADOS = {
  tipo_desconhecido: [item({ type: 'BAD', status: 'running' })],
  subagent_status: [item({ type: 'subagent', status: 'BAD' })],
  comando_status: [item({ status: 'BAD' })],
  sem_id: [item({ id: '' })],
  nao_objeto: ['x'],
  id_repetido: [item(), item({ status: 'running' })],
};

test('R6-1 turn item fora do contrato (tipo, status, id): evidência inválida em execution, settle v1/v2 e send legado', async () => {
  assert.deepEqual(problemasDaProjecao(proj({ turnItems: [item(), item({ id: 'ti2', type: 'todo_list', status: 'running' })] })), []);
  for (const [nome, turnItems] of Object.entries(TURN_ITEMS_MALFORMADOS)) {
    const p = proj({ turnItems });
    const e = derivarExecucao({ projecao: p, fonte: { historyComplete: true } });
    assert.equal(e.evidence.valid, false, nome);
    assert.ok(e.continuation.blockers.includes('execution_evidence_invalid'), nome);
    for (const version of [1, 2]) {
      const o = await lerObservacao({ environmentId: 'e', threadId: 'thread-1', version, lerShell: async () => ({ threads: [thread()] }), lerCompleto: async () => ({ snapshotSequence: 3, projection: p }) });
      assert.equal(o.complete, false, `${nome} v${version}`);
      assert.equal(avaliarGuard({ ...guard(o), version }, o), 'settle_observation_incomplete', `${nome} v${version}`);
    }
    const { r, calls } = await sendLegado(e);
    assert.equal(r.refusal?.code, 'execution_evidence_invalid', nome);
    assert.equal(calls.length, 0, nome);
  }
});

test('R6-2 fallback só-projeção carrega o dado inválido que a observação viu e confere o alvo', async () => {
  const fallback = (threads, p = proj()) => lerExecucaoDaThread({ environmentId: 'e', threadId: 'thread-1', lerShell: async () => ({ threads }), lerCompleto: async () => ({ snapshotSequence: 3, projection: p }) });
  const casos = {
    roster_nao_lista: [[thread({ pendingBackgroundTasks: 'BAD' })]],
    plano_nao_booleano: [[thread({ hasActionableProposedPlan: 'yes' })]],
    pedido_malformado: [[thread({ pendingRuntimeRequest: {} })]],
    status_desconhecido: [[thread({ status: 'BAD' })]],
    outra_thread: [[thread()], proj({ thread: { id: 'other', activeProviderThreadId: 'pt' } })],
    outra_thread_fora_da_shell: [[], proj({ thread: { id: 'other', activeProviderThreadId: 'pt' } })],
  };
  for (const [nome, [threads, p]] of Object.entries(casos)) {
    const { execucao } = await fallback(threads, p);
    assert.equal(execucao.evidence.valid, false, nome);
    assert.equal(execucao.signals.operationallyIdle, false, nome);
    const { r, calls } = await sendLegado(execucao);
    assert.equal(r.refusal?.code, 'execution_evidence_invalid', nome);
    assert.equal(calls.length, 0, nome);
  }
  // Corrida (a thread fora da shell) continua só-projeção, com evidência válida.
  const corrida = await fallback([]);
  assert.equal(corrida.execucao.coherence.status, 'projection_only');
  assert.equal(corrida.execucao.evidence.valid, true);
});

test('R6-3 coleções de que a ociosidade depende são obrigatórias: wait, settle e send não provam ociosidade sem elas', async () => {
  for (const chave of ['runs', 'runtimeRequests', 'turnItems', 'subagents', 'plans']) {
    const p = sem(proj(), chave);
    assert.ok(problemasDaProjecao(p).includes(`${chave}_missing`), chave);
    const e = derivarExecucao({ projecao: p, fonte: { historyComplete: true } });
    assert.equal(e.signals.operationallyIdle, false, chave);
    const o = await ler([thread()], p);
    assert.equal(o.complete, false, chave);
    const { execucao } = await lerExecucaoDaThread({ environmentId: 'e', threadId: 'thread-1', lerShell: async () => ({ threads: [] }), lerCompleto: async () => ({ snapshotSequence: 3, projection: p }) });
    const { r, calls } = await sendLegado(execucao);
    assert.equal(r.refusal?.code, 'execution_evidence_invalid', chave);
    assert.equal(calls.length, 0, chave);
  }
  const assinar = (projection) => async ({ aoReceber }) => { const t = setTimeout(() => aoReceber([{ kind: 'snapshot', snapshotSequence: 5, projection }, { kind: 'synchronized' }]), 5); return { fim: new Promise(() => {}), encerrar() { clearTimeout(t); } }; };
  for (const chave of ['runs', 'runtimeRequests']) {
    const r = await aguardarThread(ambientesFalsos(), { environment: 'local', threadId: 't-comum', timeoutMs: 400, until: 'execution_idle' }, { assinarImpl: assinar({ ...sem(proj(), chave), thread: { id: 't-comum' } }) });
    assert.equal(r.returnReason, 'timeout', chave);
    assert.equal(r.executionIdle, false, chave);
  }
});

test('R6-3 plano: shell ou projeção bastam para bloquear; nenhuma apaga a outra', () => {
  const comPlano = derivarExecucao({ projecao: proj(), shellThread: thread({ hasActionableProposedPlan: true }), fonte: { historyComplete: true } });
  assert.ok(comPlano.continuation.blockers.includes('proposed_plan'));
  const daProjecao = derivarExecucao({ projecao: proj({ plans: [{ id: 'pl', kind: 'proposed_plan', status: 'active' }] }), shellThread: thread({ hasActionableProposedPlan: false }), fonte: { historyComplete: true } });
  assert.ok(daProjecao.continuation.blockers.includes('proposed_plan'));
});

// --- Catálogos ---
const modelo = (extra = {}) => ({ slug: 'gpt-6.1-sol', capabilities: { optionDescriptors: [{ id: 'reasoningEffort', type: 'select', options: [{ id: 'high' }] }] }, ...extra });
const provider = (extra = {}) => ({ instanceId: 'codex', enabled: true, installed: true, status: 'ready', auth: { status: 'authenticated' }, supportedRuntimeModes: ['full-access'], models: [modelo()], ...extra });
const ms = { instanceId: 'codex', model: 'gpt-6.1-sol', options: [{ id: 'reasoningEffort', value: 'high' }] };
const pedido = { model: ms.model, options: ms.options, runtimeMode: 'full-access' };
const codigos = (r) => r.reasons.map((x) => x.code);

test('R6-4 modelo e descritor repetidos e divergentes: capability_unknown nas duas ordens; repetição idêntica é uma só', () => {
  const ruim = modelo({ capabilities: { optionDescriptors: [] } });
  for (const models of [[modelo(), ruim], [ruim, modelo()]]) {
    const el = elegibilidadeProvider(provider({ models }), pedido);
    assert.equal(el.eligible, false);
    assert.ok(el.reasons.some((x) => x.code === 'capability_unknown' && x.reason === 'catalog_conflict'));
  }
  assert.equal(elegibilidadeProvider(provider({ models: [modelo(), modelo()] }), pedido).eligible, true);
  const dBom = { id: 'reasoningEffort', type: 'select', options: [{ id: 'high' }] };
  const dRuim = { id: 'reasoningEffort', type: 'select', options: [{ id: 'low' }] };
  for (const optionDescriptors of [[dBom, dRuim], [dRuim, dBom]]) {
    const el = elegibilidadeProvider(provider({ models: [modelo({ capabilities: { optionDescriptors } })] }), pedido);
    assert.equal(el.eligible, false);
    assert.ok(el.reasons.some((x) => x.code === 'capability_unknown' && x.reason === 'catalog_conflict'));
  }
});

function dadosCatalogo() {
  const d = dadosPadrao();
  d.local.shell.snapshotSequence = 7;
  d.remoto.shell.snapshotSequence = 7;
  d.local.completo = { 't-comum': { snapshotSequence: 30, projection: { ...projecao({ mensagens: [mensagem()], runs: [{ id: 'run-1', ordinal: 1, status: 'completed' }] }), thread: { id: 't-comum' }, providerThreads: [] } } };
  return d;
}
async function cliente({ d = dadosCatalogo(), providers = [provider()] } = {}) {
  const porBase = { 'http://127.0.0.1:3773/': LOCAL.environmentId, 'http://127.0.0.1:43773/': REMOTO.environmentId };
  const chamarImpl = async ({ baseUrl }) => ({ environment: { environmentId: porBase[String(baseUrl)] }, providers: structuredClone(providers) });
  return conectarMcp(ambientesFalsos(d), { lerArquivadas: async () => ({ snapshotSequence: 7, threads: [] }) }, { chamarImpl });
}
const ROOT = '/Users/dev/app';
const launch = { projectId: LOCAL.projeto, title: 'Frente nova', modelSelection: ms, runtimeMode: 'full-access', workspaceStrategy: { type: 'root' }, text: 'Implemente.' };
const expected = { projectId: LOCAL.projeto, workspace: { type: 'root', path: ROOT, branch: null } };
const dup = { environments: ['local', 'remoto'], population: 'all', selector: { title: { value: 'Frente nova' } } };
const preflight = async (c, args) => dados(await c.callTool({ name: 't3_dispatch_preflight', arguments: { controlPlaneContractVersion: 1, environment: 'local', ...args } }));
const rota = async (c) => dados(await c.callTool({ name: 't3_ambientes', arguments: { check: false, controlPlaneContractVersion: 1, route: { candidates: [{ environment: 'local', projectId: LOCAL.projeto, modelSelection: ms, runtimeMode: 'full-access' }] } } })).route;

test('R6-4 provider repetido e divergente: launch e rota recusam nas duas ordens; idêntico admite', async () => {
  const ruim = provider({ status: 'error' });
  for (const providers of [[provider(), ruim], [ruim, provider()]]) {
    const c = await cliente({ providers });
    const pre = await preflight(c, { action: 'thread.launch', input: launch, expected, duplicateCheck: dup });
    assert.equal(pre.admissible, false);
    assert.ok(pre.reasons.some((x) => x.code === 'capability_unknown' && x.reason === 'catalog_conflict'), JSON.stringify(pre.reasons));
    const r = await rota(c);
    assert.equal(r.candidates[0].eligible, false);
    assert.ok(codigos(r.candidates[0]).includes('capability_unknown'));
  }
  const c = await cliente({ providers: [provider(), provider()] });
  assert.equal((await preflight(c, { action: 'thread.launch', input: launch, expected, duplicateCheck: dup })).admissible, true);
});

test('R6-4 projeto repetido e divergente: launch, rota e send recusam nas duas ordens', async () => {
  const outro = { id: LOCAL.projeto, title: 'app', workspaceRoot: '/Users/dev/outro' };
  const apagado = { id: LOCAL.projeto, title: 'app', workspaceRoot: ROOT, deletedAt: '2026-10-01T00:00:00.000Z' };
  for (const extra of [outro, apagado]) {
    for (const primeiro of [true, false]) {
      const d = dadosCatalogo();
      const base = d.local.shell.projects.find((p) => p.id === LOCAL.projeto);
      d.local.shell.projects = primeiro ? [base, extra, ...d.local.shell.projects.filter((p) => p !== base)] : [extra, ...d.local.shell.projects];
      const c = await cliente({ d });
      const pre = await preflight(c, { action: 'thread.launch', input: launch, expected, duplicateCheck: dup });
      assert.equal(pre.admissible, false);
      assert.ok(pre.reasons.some((x) => x.code === 'project_unavailable' && x.reason === 'catalog_conflict'), JSON.stringify(pre.reasons));
      assert.ok(codigos((await rota(c)).candidates[0]).includes('project_unavailable'));
      const send = await preflight(c, { action: 'thread.send', input: { threadId: 't-comum', text: 'x', clientRequestId: 'c', delivery: 'start_immediately' }, expected });
      assert.equal(send.admissible, false);
      assert.ok(send.reasons.some((x) => x.code === 'project_unavailable' && x.reason === 'catalog_conflict'), JSON.stringify(send.reasons));
    }
  }
});

test('R6-2 linha inválida vista em qualquer leitura e snapshot sem sequência válida não viram só-projeção', async () => {
  let n = 0;
  const alternando = await lerExecucaoDaThread({ environmentId: 'e', threadId: 'thread-1', lerShell: async () => ({ threads: [n++ % 2 ? thread() : thread({ pendingBackgroundTasks: 'BAD' })] }), lerCompleto: async () => ({ snapshotSequence: 3, projection: proj() }) });
  assert.equal(alternando.execucao.evidence.valid, false);
  assert.ok(alternando.execucao.evidence.problems.includes('shell_background_roster_invalid'));
  let m = 0;
  const depoisInvalido = await lerExecucaoDaThread({ environmentId: 'e', threadId: 'thread-1', lerShell: async () => ({ threads: [m++ % 2 ? thread({ hasActionableProposedPlan: 'yes' }) : thread()] }), lerCompleto: async () => ({ snapshotSequence: 3, projection: proj() }) });
  assert.ok(depoisInvalido.execucao.evidence.problems.includes('shell_plan_flag_invalid'));
  const semSequencia = await lerExecucaoDaThread({ environmentId: 'e', threadId: 'thread-1', lerShell: async () => ({ threads: [thread()] }), lerCompleto: async () => ({ snapshotSequence: 'x', projection: proj() }) });
  assert.equal(semSequencia.execucao.evidence.valid, false);
  assert.ok(semSequencia.execucao.evidence.problems.includes('snapshot_sequence_invalid'));
  assert.equal((await sendLegado(semSequencia.execucao)).calls.length, 0);
});
