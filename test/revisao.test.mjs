// Control-plane v1: fila de revisão no workset e pacote de revisão no t3_thread (§6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao, LOCAL } from './apoio.mjs';
import { mensagem, projecao, thread } from './fixtures.mjs';

const agora = Date.parse('2026-10-05T12:00:00.000Z');
const completa = (id, updatedAt, extra = {}) => thread({ id, projectId: LOCAL.projeto, title: id, status: 'completed', updatedAt, ...extra });

async function workset(args, d) {
  const c = await conectarMcp(ambientesFalsos(d), undefined, undefined, { agora });
  const r = await c.callTool({ name: 't3_workset', arguments: { environments: ['local'], ...args } });
  return r.isError ? r : dados(r);
}

test('reviewQueue: grupo inteiro antes do corte por grupo, paginado, com a próxima leitura', async () => {
  const d = dadosPadrao();
  d.local.shell.snapshotSequence = 5;
  d.local.shell.threads = [completa('a', '2026-10-05T10:00:00.000Z'), completa('b', '2026-10-05T11:00:00.000Z'), completa('c', '2026-10-05T09:00:00.000Z'),
    completa('fundo', '2026-10-05T11:30:00.000Z', { pendingBackgroundTasks: [{ kind: 'monitor', taskId: 'm' }] }), completa('liquidada', '2026-10-05T11:40:00.000Z', { settledAt: '2026-10-05T11:41:00.000Z' })];
  const p1 = await workset({ limitPerGroup: 1, controlPlaneContractVersion: 1, reviewQueue: { group: 'completed_unsettled', limit: 2 } }, d);
  assert.equal(p1.groups.completed_unsettled.length, 1, 'limitPerGroup continua valendo para groups');
  assert.equal(p1.reviewQueue.total, 3);
  assert.deepEqual(p1.reviewQueue.items.map((x) => x.threadId), ['b', 'a']);
  assert.deepEqual(p1.reviewQueue.items[0].nextRead, { tool: 't3_thread', controlPlaneContractVersion: 1, settlementContractVersion: 2, review: true });
  assert.equal(p1.reviewQueue.items[0].environmentId, LOCAL.environmentId);
  const p2 = await workset({ controlPlaneContractVersion: 1, reviewQueue: { group: 'completed_unsettled', limit: 2, cursor: p1.reviewQueue.nextCursor } }, d);
  assert.deepEqual(p2.reviewQueue.items.map((x) => x.threadId), ['c']);
  assert.equal(p2.reviewQueue.truncated, false);
  // Mudou a sequence do environment entre as páginas: recomeçar.
  d.local.shell.snapshotSequence = 6;
  const mudou = await workset({ controlPlaneContractVersion: 1, reviewQueue: { group: 'completed_unsettled', limit: 2, cursor: p1.reviewQueue.nextCursor } }, d);
  assert.equal(mudou.isError, true);
  assert.match(mudou.content[0].text, /cursor_snapshot_changed/);
});

test('reviewQueue exige a versão; sem ela o workset é o legado', async () => {
  const semVersao = await workset({ reviewQueue: { group: 'completed_unsettled' } }, dadosPadrao());
  assert.equal(semVersao.isError, true);
  const legado = await workset({}, dadosPadrao());
  assert.equal('reviewQueue' in legado, false);
  assert.equal('controlPlaneContractVersion' in legado, false);
});

function dadosRevisao({ mensagens, runs = [{ id: 'run-1', ordinal: 1, status: 'completed' }], threadExtra = {} }) {
  const d = dadosPadrao();
  d.local.shell.threads = d.local.shell.threads.map((t) => (t.id === 't-comum' ? { ...t, worktreePath: '/Users/dev/app-wt', branch: 'feat/cp', ...threadExtra } : t));
  d.local.completo = { 't-comum': { snapshotSequence: 40, projection: { ...projecao({ mensagens, runs }), thread: { id: 't-comum' }, providerThreads: [] } } };
  return d;
}
async function pacote(args, d) {
  const c = await conectarMcp(ambientesFalsos(d));
  const r = await c.callTool({ name: 't3_thread', arguments: { threadId: 't-comum', controlPlaneContractVersion: 1, settlementContractVersion: 2, review: true, ...args } });
  return r.isError ? r : dados(r);
}

test('pacote de revisão: resposta do run esperado, workspace, evidência e o mesmo observationId do settlement', async () => {
  const r = await pacote({}, dadosRevisao({ mensagens: [mensagem({ id: 'msg-a', text: 'Implementado e testado.' })] }));
  assert.equal(r.review.complete, true);
  assert.equal(r.review.observationId, r.settlement.observationId);
  assert.match(r.review.observationId, /^obs2_/);
  assert.deepEqual(r.review.run, { runId: 'run-1', ordinal: 1, status: 'completed' });
  assert.equal(r.review.response.messageId, 'msg-a');
  assert.equal(r.review.response.relation, 'latest_executed_run');
  assert.deepEqual(r.review.workspace, { projectId: LOCAL.projeto, worktreePath: '/Users/dev/app-wt', branch: 'feat/cp', source: 'snapshot_metadata' });
  assert.deepEqual(r.review.availableEvidence, [{ kind: 'assistant_message', ref: { environmentId: LOCAL.environmentId, threadId: 't-comum', messageId: 'msg-a' }, runId: 'run-1' }]);
  assert.deepEqual(r.review.verification, { status: 'caller_required' });
});

test('pacote: resposta só de run anterior não vira entrega do run esperado; truncada ou em streaming é incompleta', async () => {
  const runs = [{ id: 'run-1', ordinal: 1, status: 'completed' }, { id: 'run-2', ordinal: 2, status: 'completed' }];
  const velha = await pacote({}, dadosRevisao({ mensagens: [mensagem({ id: 'msg-velha', runId: 'run-1' })], runs, threadExtra: { latestRunId: 'run-2' } }));
  assert.equal(velha.review.complete, false);
  assert.equal(velha.review.response, null);
  assert.equal(velha.review.olderResponse.messageId, 'msg-velha');
  assert.ok(velha.review.reasons.some((x) => x.code === 'review_response_missing_or_stale'));
  const longa = await pacote({ maxCharacters: 200 }, dadosRevisao({ mensagens: [mensagem({ text: 'x'.repeat(500) })] }));
  assert.equal(longa.review.complete, false);
  assert.equal(longa.review.response.truncated, true);
  assert.equal(longa.review.response.text.length, 200);
  const viva = await pacote({}, dadosRevisao({ mensagens: [mensagem({ streaming: true })] }));
  assert.equal(viva.review.complete, false);
  assert.ok(viva.review.reasons.some((x) => x.code === 'review_response_streaming'));
});

test('pacote: exige controlPlane 1 + settlement 2; observação incoerente não dá observationId', async () => {
  const d = dadosRevisao({ mensagens: [mensagem()] });
  const c = await conectarMcp(ambientesFalsos(d));
  for (const args of [{ review: true, settlementContractVersion: 2 }, { review: true, controlPlaneContractVersion: 1, settlementContractVersion: 1 }]) {
    const r = await c.callTool({ name: 't3_thread', arguments: { threadId: 't-comum', ...args } });
    assert.equal(r.isError, true);
  }
  const base = d.local.shell;
  let n = 0;
  d.local.shell = () => ({ ...base, threads: base.threads.map((t) => (t.id === 't-comum' ? { ...t, latestVisibleMessage: { id: `m-${n++}` } } : t)) });
  const r = await pacote({}, d);
  assert.equal(r.review.complete, false);
  assert.equal(r.review.observationId, null);
});
