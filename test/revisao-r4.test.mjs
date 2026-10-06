// Regressões da revisão R4 (c357eae): evidência de fundo malformada, linhas repetidas do alvo
// na shell, e timestamps equivalentes na união (não bloqueante).
import test from 'node:test';
import assert from 'node:assert/strict';
import { derivarExecucao } from '../src/execucao.mjs';
import { lerObservacao, avaliarGuard } from '../src/settlement.mjs';
import { criarEscopo } from '../src/ambientes.mjs';
import { chaveCanonica, linhaUnica } from '../src/linhas.mjs';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao, LOCAL } from './apoio.mjs';
import { mensagem, projecao, thread } from './fixtures.mjs';

const proj = (extra = {}) => ({ ...projecao({ runs: [{ id: 'run-1', ordinal: 1, status: 'completed' }], mensagens: [mensagem()] }), thread: { id: 'thread-1', activeProviderThreadId: 'pt' }, providerThreads: [{ id: 'pt', pendingBackgroundTasks: [] }], ...extra });
const ler = (shellThreads, p) => lerObservacao({ environmentId: 'e', threadId: 'thread-1', version: 2, lerShell: async () => ({ threads: shellThreads }), lerCompleto: async () => ({ snapshotSequence: 3, projection: p }) });
const guardV2 = (o) => ({ version: 2, expectedRunId: o.expectedRunId ?? 'run-1', expectedObservationId: o.observationId ?? 'x', acceptance: { accepted: true, evidenceRef: 'r' } });

test('R4-1 fundo malformado nunca prova ociosidade (tarefa sem taskId, status fora do contrato, roster não lista)', async () => {
  assert.equal(derivarExecucao({ projecao: proj(), fonte: { historyComplete: true } }).background.knowledge, 'complete');
  const casos = [
    proj({ providerThreads: [{ id: 'pt', pendingBackgroundTasks: [{ kind: 'monitor' }] }] }),
    proj({ providerThreads: [{ id: 'pt', pendingBackgroundTasks: [{ taskId: '  ', kind: 'monitor' }] }] }),
    proj({ providerThreads: [{ id: 'pt', pendingBackgroundTasks: 'x' }] }),
    proj({ subagents: [{ id: 'sub-1', runId: 'run-1', status: 'BAD' }] }),
    proj({ subagents: [{ runId: 'run-1', status: 'running' }] }),
    proj({ turnItems: [{ id: 'ti', type: 'command_execution', status: 'BAD', runId: 'run-1' }] }),
  ];
  for (const p of casos) {
    const e = derivarExecucao({ projecao: p, fonte: { historyComplete: true } });
    assert.equal(e.background.knowledge, 'unknown', JSON.stringify(p.providerThreads ?? p.subagents ?? p.turnItems));
    assert.ok(e.continuation.blockers.includes('background_work_unknown'));
    const o = await ler([thread()], p);
    assert.ok(!o.complete || o.blockers.some((b) => b.code === 'background_work_unknown'));
    assert.equal(o.eligibleMechanically, false);
    assert.notEqual(avaliarGuard(guardV2(o), o), null);
  }
});

test('R4-2 linhas repetidas e divergentes do alvo na shell: settlement incompleto e leitura recusada', async () => {
  const igual = await ler([thread(), thread()], proj());
  assert.equal(igual.complete, true, 'linhas idênticas contam uma vez');
  const o = await ler([thread(), thread({ status: 'running', activeRunId: 'run-2', latestRunId: 'run-2' })], proj());
  assert.equal(o.complete, false);
  assert.equal(o.blockers[0].reason, 'thread_rows_conflict');
  assert.equal(avaliarGuard(guardV2(o), o), 'settle_observation_incomplete');
  const escopo = criarEscopo('local', ['proj-ok']);
  assert.throws(() => escopo.exigirThread({ threads: [thread(), thread({ status: 'running' })] }, 'thread-1'), /conflicting rows/);
  // t3_thread e o preflight de send não decidem sobre a primeira linha.
  const d = dadosPadrao();
  const base = d.local.shell.threads.find((t) => t.id === 't-comum');
  d.local.shell.threads.push({ ...base, status: 'running', activeRunId: 'run-2', latestRunId: 'run-2' });
  const c = await conectarMcp(ambientesFalsos(d));
  assert.equal((await c.callTool({ name: 't3_thread', arguments: { threadId: 't-comum' } })).isError, true);
  const pre = await c.callTool({ name: 't3_dispatch_preflight', arguments: { controlPlaneContractVersion: 1, environment: 'local', action: 'thread.send', input: { threadId: 't-comum', text: 'x', clientRequestId: 'c', delivery: 'start_immediately' }, expected: { projectId: LOCAL.projeto, workspace: { type: 'root', path: '/Users/dev/app', branch: null } } } });
  assert.equal(pre.isError ? false : dados(pre).admissible, false);
});

test('R4-3 (não bloqueante) instantes equivalentes não são conflito na união; diferentes são', async () => {
  assert.equal(chaveCanonica({ updatedAt: '2026-10-03T10:05:00.000Z' }), chaveCanonica({ updatedAt: '2026-10-03T07:05:00-03:00' }));
  assert.notEqual(chaveCanonica({ updatedAt: '2026-10-03T10:05:00.000Z' }), chaveCanonica({ updatedAt: '2026-10-03T10:05:00.001Z' }));
  // Texto livre que parece data não é instante (revisão R5, P1).
  assert.notEqual(chaveCanonica({ title: '2026-10-03T10:05:00.000Z' }), chaveCanonica({ title: '2026-10-03T07:05:00-03:00' }));
  assert.equal(linhaUnica([thread({ updatedAt: '2026-10-03T10:05:00.000Z' }), thread({ updatedAt: '2026-10-03T07:05:00-03:00' })], 'thread-1').conflito, false);
  const d = dadosPadrao();
  d.local.shell.snapshotSequence = 9; d.remoto.shell.snapshotSequence = 9;
  d.local.shell.threads.push(thread({ id: 'x', projectId: LOCAL.projeto, title: 'Target', updatedAt: '2026-10-03T10:05:00.000Z' }));
  const c = await conectarMcp(ambientesFalsos(d), { lerArquivadas: async (_c, r) => ({ snapshotSequence: 9, threads: r.alias === 'local' ? [thread({ id: 'x', projectId: LOCAL.projeto, title: 'Target', updatedAt: '2026-10-03T07:05:00-03:00', archivedAt: '2026-10-01T00:00:00.000Z' })] : [] }) });
  const r = dados(await c.callTool({ name: 't3_thread_find_batch', arguments: { controlPlaneContractVersion: 1, population: 'all', queries: [{ key: 't', selector: { title: { value: 'Target' } } }] } })).results[0];
  assert.equal(r.launchDisposition, 'continue_existing');
});
