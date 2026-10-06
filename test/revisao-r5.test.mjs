// Regressões da revisão R5 (5846005): uma fronteira de validação para a projeção
// (execution_evidence_invalid) e linhas da shell conferidas antes da ACL e em todo consumidor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { derivarExecucao } from '../src/execucao.mjs';
import { lerObservacao, lerExecucaoDaThread, avaliarGuard } from '../src/settlement.mjs';
import { problemasDaProjecao } from '../src/validacao.mjs';
import { Dispatcher } from '../src/escrita/adapters.mjs';
import { clienteFiltrado } from '../src/escrita/read-guarded.mjs';
import { aguardarThread } from '../src/espera.mjs';
import { setup, memoryJournal } from './escrita-fixtures.mjs';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao, LOCAL, PROJETO_ALHEIO } from './apoio.mjs';
import { mensagem, projecao, thread } from './fixtures.mjs';

const proj = (extra = {}) => ({ ...projecao({ runs: [{ id: 'run-1', ordinal: 1, status: 'completed' }], mensagens: [mensagem()] }), thread: { id: 'thread-1', activeProviderThreadId: 'pt' }, providerThreads: [{ id: 'pt', pendingBackgroundTasks: [] }], subagents: [], plans: [], ...extra });
const ler = (threads, p) => lerObservacao({ environmentId: 'e', threadId: 'thread-1', version: 2, lerShell: async () => ({ threads }), lerCompleto: async () => ({ snapshotSequence: 3, projection: p }) });
const guard = (o) => ({ version: 2, expectedRunId: 'run-1', expectedObservationId: o.observationId ?? 'x', acceptance: { accepted: true, evidenceRef: 'r' } });

const MALFORMADAS = {
  plan_status: proj({ plans: [{ id: 'pl', kind: 'proposed_plan', status: 'BAD', markdown: '' }] }),
  plan_kind: proj({ plans: [{ id: 'pl', kind: 'BAD', status: 'active' }] }),
  run_status: proj({ runs: [{ id: 'run-1', ordinal: 1, status: 'completed' }, { id: 'run-2', ordinal: 2, status: 'BAD' }] }),
  request_status: proj({ runtimeRequests: [{ id: 'q', status: 'BAD' }] }),
  subagent_status: proj({ subagents: [{ id: 's', status: 'BAD' }] }),
  binding_missing: proj({ providerThreads: [{ id: 'outro', pendingBackgroundTasks: [{ taskId: 'm', kind: 'monitor' }] }] }),
  duplicate_run: proj({ runs: [{ id: 'run-1', ordinal: 1, status: 'completed' }, { id: 'run-1', ordinal: 1, status: 'running' }] }),
};

test('R5-5/6/7 projeção fora do contrato: execution_evidence_invalid, sem ociosidade, settle incompleto', async () => {
  assert.deepEqual(problemasDaProjecao(proj()), []);
  assert.equal(derivarExecucao({ projecao: proj(), fonte: { historyComplete: true } }).continuation.canStartNow, true);
  for (const [nome, p] of Object.entries(MALFORMADAS)) {
    const e = derivarExecucao({ projecao: p, fonte: { historyComplete: true } });
    assert.ok(e.continuation.blockers.includes('execution_evidence_invalid'), nome);
    assert.equal(e.signals.operationallyIdle, false, nome);
    assert.equal(e.evidence.valid, false);
    const o = await ler([thread()], p);
    assert.equal(o.complete, false, nome);
    assert.equal(avaliarGuard(guard(o), o), 'settle_observation_incomplete', nome);
  }
});

test('R5-6 wait execution_idle nunca declara ociosa uma projeção fora do contrato', async () => {
  const assinar = (projection) => async ({ aoReceber }) => { const t = setTimeout(() => aoReceber([{ kind: 'snapshot', snapshotSequence: 5, projection }, { kind: 'synchronized' }]), 5); return { fim: new Promise(() => {}), encerrar() { clearTimeout(t); } }; };
  for (const nome of ['run_status', 'request_status']) {
    const r = await aguardarThread(ambientesFalsos(), { environment: 'local', threadId: 't-comum', timeoutMs: 400, until: 'execution_idle' }, { assinarImpl: assinar({ ...MALFORMADAS[nome], updatedAt: '2026-10-03T10:05:00.000Z' }) });
    assert.equal(r.returnReason, 'timeout', nome);
    assert.equal(r.executionIdle, false, nome);
  }
});

test('R5-3/4 send legado recusa evidência inválida (projeção ou linhas em conflito), nada enviado', async () => {
  const s = setup();
  const lease = await s.grant();
  const calls = [];
  const conflito = await lerExecucaoDaThread({ environmentId: 'e', threadId: 'thread-1', lerShell: async () => ({ threads: [thread(), thread({ status: 'running', activeRunId: 'run-2', latestRunId: 'run-2' })] }), lerCompleto: async () => ({ snapshotSequence: 3, projection: proj() }) });
  assert.ok(conflito.execucao.continuation.blockers.includes('execution_evidence_invalid'), 'fallback não apaga o conflito');
  for (const execucao of [conflito.execucao, derivarExecucao({ projecao: MALFORMADAS.subagent_status, fonte: { historyComplete: true } })]) {
    const adapter = { verifyWorkspace: async () => true, projectForThread: async () => 'app', invoke: async (m, p) => { calls.push(p); return { sequence: 1 }; }, receipt: (r) => r, executionSnapshot: async () => execucao };
    const d = new Dispatcher({ gate: s.gate, adapter, journal: memoryJournal(), environmentId: s.env.environmentId, destination: s.env.destination });
    const id = `s-${calls.length}-${Math.random()}`;
    const r = await d.dispatch(s.caller, lease.leaseId, { operationId: id, action: 'thread.send', input: { threadId: 't', text: 'oi', clientRequestId: id, delivery: 'start_immediately' } });
    assert.equal(r.state, 'rejected');
    assert.equal(r.refusal.code, 'execution_evidence_invalid');
  }
  assert.equal(calls.length, 0);
});

test('R5-2 linha do alvo em outro projeto (fora da ACL) ainda conta como conflito', async () => {
  const d = dadosPadrao();
  const base = d.local.shell.threads.find((t) => t.id === 't-comum');
  d.local.shell.threads.push({ ...base, projectId: PROJETO_ALHEIO, status: 'running', activeRunId: 'run-2', latestRunId: 'run-2' });
  d.local.completo = { 't-comum': { snapshotSequence: 30, projection: { ...d.local.bounded['t-comum'].projection, thread: { id: 't-comum' }, providerThreads: [] } } };
  const c = await conectarMcp(ambientesFalsos(d));
  const pre = await c.callTool({ name: 't3_dispatch_preflight', arguments: { controlPlaneContractVersion: 1, environment: 'local', action: 'thread.send', input: { threadId: 't-comum', text: 'x', clientRequestId: 'c', delivery: 'start_immediately' }, expected: { projectId: LOCAL.projeto, workspace: { type: 'root', path: '/Users/dev/app', branch: null } } } });
  assert.equal(pre.isError ? false : dados(pre).admissible, false);
  const t = await c.callTool({ name: 't3_thread', arguments: { threadId: 't-comum', settlementContractVersion: 2 } });
  assert.equal(t.isError ? false : dados(t).settlement.complete, false);
});

test('R5-1 título que parece data não é normalizado: conflito de títulos detectado', async () => {
  const d = dadosPadrao();
  d.local.shell.snapshotSequence = 9; d.remoto.shell.snapshotSequence = 9;
  d.local.shell.threads.push(thread({ id: 'x', projectId: LOCAL.projeto, title: '2026-10-03T10:05:00.000Z' }));
  const c = await conectarMcp(ambientesFalsos(d), { lerArquivadas: async (_c, r) => ({ snapshotSequence: 9, threads: r.alias === 'local' ? [thread({ id: 'x', projectId: LOCAL.projeto, title: '2026-10-03T07:05:00-03:00', archivedAt: '2026-10-01T00:00:00.000Z' })] : [] }) });
  const r = dados(await c.callTool({ name: 't3_thread_find_batch', arguments: { controlPlaneContractVersion: 1, population: 'all', queries: [{ key: 't', selector: { title: { value: '2026-10-03T07:05:00-03:00' } } }] } })).results[0];
  assert.equal(r.launchDisposition, 'inconclusive');
  assert.ok(r.reasons.some((x) => x.code === 'population_conflict'));
});

test('R5 consumidores por ID: clienteFiltrado recusa linhas divergentes; workset mostra uma vez, em unknown', async () => {
  const cliente = { shell: async () => ({ threads: [thread({ id: 't', projectId: 'one' }), thread({ id: 't', projectId: 'one', status: 'running' })] }), thread: async () => ({}), threadCompleto: async () => ({}) };
  const f = clienteFiltrado(cliente, new Set(['one']));
  await assert.rejects(f.thread('t'), /thread_not_found/);
  await assert.rejects(f.threadCompleto('t'), /thread_not_found/);
  const d = dadosPadrao();
  d.local.shell.threads.push(thread({ id: 'dup', projectId: LOCAL.projeto, status: 'completed' }), thread({ id: 'dup', projectId: LOCAL.projeto, status: 'running', activeRunId: 'r', activityRunStatus: 'running' }));
  const c = await conectarMcp(ambientesFalsos(d));
  const w = dados(await c.callTool({ name: 't3_workset', arguments: { environments: ['local'] } }));
  const refs = [...w.actionable, ...w.inFlight].filter((x) => x.threadId === 'dup');
  assert.deepEqual(refs.map((x) => x.group), ['unknown']);
});
