// Regressões dos cinco bloqueantes da revisão R3 (aacaf76), por classe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nsIso, msIso, mesmoInstante } from '../src/instante.mjs';
import { compararShell, derivarExecucao } from '../src/execucao.mjs';
import { lerObservacao, avaliarGuard } from '../src/settlement.mjs';
import { validRow } from '../src/escrita/project-admin.mjs';
import { buscarThreadsEmLote } from '../src/busca-threads.mjs';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao, LOCAL } from './apoio.mjs';
import { mensagem, projecao, thread } from './fixtures.mjs';

const guardV2 = { version: 2, expectedRunId: 'run-1', expectedObservationId: 'x', acceptance: { accepted: true, evidenceRef: 'r' } };
const proj = (extra = {}) => ({ ...projecao({ runs: [{ id: 'run-1', ordinal: 1, status: 'completed' }], mensagens: [mensagem()] }), thread: { id: 'thread-1' }, providerThreads: [], ...extra });

test('R3-1 instantes distintos nunca provam a mesma versão (nanossegundos e anos 00–99)', async () => {
  assert.notEqual(nsIso('2026-10-03T10:05:00.000000001Z'), nsIso('2026-10-03T10:05:00.000000002Z'));
  assert.notEqual(nsIso('0099-10-03T10:05:00Z'), nsIso('1999-10-03T10:05:00Z'));
  assert.equal(mesmoInstante('2026-10-03T07:05:00-03:00', '2026-10-03T10:05:00.000Z'), true);
  assert.equal(msIso('0099-10-03T10:05:00Z') < msIso('1999-10-03T10:05:00Z'), true);
  for (const [a, b] of [['2026-10-03T10:05:00.000000001Z', '2026-10-03T10:05:00.000000002Z'], ['0099-10-03T10:05:00Z', '1999-10-03T10:05:00Z']]) {
    assert.equal(compararShell(thread({ updatedAt: a }), proj({ updatedAt: b })).mesmaVersao, false, `${a} ${b}`);
    const o = await lerObservacao({ environmentId: 'e', threadId: 'thread-1', version: 2, lerShell: async () => ({ threads: [thread({ updatedAt: a })] }), lerCompleto: async () => ({ snapshotSequence: 3, projection: proj({ updatedAt: b }) }) });
    assert.equal(o.complete, false);
    assert.equal(avaliarGuard(guardV2, o), 'settle_observation_incomplete');
  }
});

test('R3-2 deletedAt/archivedAt malformado não prova exclusão (linha inválida, população incompleta)', async () => {
  for (const campo of ['deletedAt', 'archivedAt']) assert.equal(validRow(thread({ id: 'x', [campo]: 'bad' })), false, campo);
  assert.equal(validRow(thread({ id: 'x', deletedAt: '2026-10-03T10:05:00.000Z' })), true);
  const d = dadosPadrao();
  d.local.shell.snapshotSequence = 9; d.remoto.shell.snapshotSequence = 9;
  d.local.shell.threads.push(thread({ id: 'x', projectId: LOCAL.projeto, title: 'Target', deletedAt: 'bad' }));
  const c = await conectarMcp(ambientesFalsos(d), { lerArquivadas: async () => ({ snapshotSequence: 9, threads: [] }) });
  const r = dados(await c.callTool({ name: 't3_thread_find_batch', arguments: { controlPlaneContractVersion: 1, population: 'all', queries: [{ key: 't', selector: { title: { value: 'Target' } } }] } })).results[0];
  assert.equal(r.launchDisposition, 'inconclusive');
  assert.ok(r.reasons.some((x) => x.code === 'active_source_invalid'));
});

test('R3-3 linhas repetidas e divergentes dentro da mesma fonte são conflito, não a primeira', async () => {
  const d = dadosPadrao();
  d.local.shell.snapshotSequence = 9; d.remoto.shell.snapshotSequence = 9;
  const arq = (title) => thread({ id: 'x', projectId: LOCAL.projeto, title, archivedAt: '2026-10-01T00:00:00.000Z' });
  const c = await conectarMcp(ambientesFalsos(d), { lerArquivadas: async (_c, r) => ({ snapshotSequence: 9, threads: r.alias === 'local' ? [arq('Other'), arq('Target')] : [] }) });
  const r = dados(await c.callTool({ name: 't3_thread_find_batch', arguments: { controlPlaneContractVersion: 1, population: 'all', queries: [{ key: 't', selector: { title: { value: 'Target' } } }] } })).results[0];
  assert.equal(r.launchDisposition, 'inconclusive');
  assert.ok(r.reasons.some((x) => x.code === 'population_conflict'));
  // Repetidas idênticas contam uma vez.
  const igual = await conectarMcp(ambientesFalsos(d), { lerArquivadas: async (_c, r2) => ({ snapshotSequence: 9, threads: r2.alias === 'local' ? [arq('Target'), arq('Target')] : [] }) });
  const r2 = dados(await igual.callTool({ name: 't3_thread_find_batch', arguments: { controlPlaneContractVersion: 1, population: 'all', queries: [{ key: 't', selector: { title: { value: 'Target' } } }] } })).results[0];
  assert.equal(r2.launchDisposition, 'continue_existing');
  assert.equal(r2.total, 1);
});

test('R3-4 mesma tarefa em várias fontes preserva a evidência que segura a thread', () => {
  const p = proj({ thread: { id: 'thread-1', activeProviderThreadId: 'pt' }, providerThreads: [{ id: 'pt', pendingBackgroundTasks: [{ taskId: 'x', kind: 'command' }] }], subagents: [{ id: 'x', runId: 'run-1', status: 'running' }] });
  const e = derivarExecucao({ projecao: p, fonte: { historyComplete: true } });
  const t = e.background.pending.find((x) => x.taskId === 'x');
  assert.equal(t.holdsThread, true);
  assert.equal(t.kind, 'subagent');
  assert.deepEqual(t.alsoSeenIn, ['provider_roster']);
  assert.ok(e.continuation.blockers.includes('background_work_active'));
  // A ordem das fontes não muda nada: o roster que segura vence o turn item que não segura.
  const q = proj({ thread: { id: 'thread-1', activeProviderThreadId: 'pt' }, providerThreads: [{ id: 'pt', pendingBackgroundTasks: [{ taskId: 'y', kind: 'monitor' }] }], turnItems: [{ id: 'y', type: 'command_execution', status: 'running', runId: 'run-1' }] });
  assert.equal(derivarExecucao({ projecao: q, fonte: { historyComplete: true } }).background.pending.find((x) => x.taskId === 'y').holdsThread, true);
});

test('R3-5 busca legada não prova ausência com título desconhecido nem com linha malformada', async () => {
  const d = dadosPadrao();
  d.local.shell.threads.push(thread({ id: 'sem-titulo', projectId: LOCAL.projeto, title: null }));
  const amb = ambientesFalsos(d);
  const r = await buscarThreadsEmLote(amb, { queries: [{ key: 'x', search: 'Target', match: 'exact' }] }, { resumir: (t) => ({ threadId: t.id, title: t.title }) });
  assert.equal(r.results[0].resolution, 'inconclusive');
  assert.equal(r.results[0].complete, false);
  const c = await conectarMcp(ambientesFalsos(d));
  const s = dados(await c.callTool({ name: 't3_buscar_threads', arguments: { search: 'Target', match: 'exact' } }));
  assert.equal(s.total, 0);
  assert.equal(s.complete, false);
  // Busca por ID exato continua resolvendo (não depende do título).
  const id = await buscarThreadsEmLote(ambientesFalsos(d), { queries: [{ key: 'i', threadId: 't-local' }] }, { resumir: (t) => ({ threadId: t.id, title: t.title }) });
  assert.equal(id.results[0].resolution, 'resolved');
});
