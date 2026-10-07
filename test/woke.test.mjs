// Marcador Woke: derivação igual à do T3 (threadWokeAt + regra do indicador da sidebar,
// nightly 3e6b4502) e exposição read-only em t3_threads/t3_thread.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estadoDaThread, marcadorWoke } from '../src/estado.mjs';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao, REMOTO } from './apoio.mjs';
import { projecao, thread } from './fixtures.mjs';

const AGORA = '2026-10-06T12:00:00.000Z';
const ANTES = '2026-10-06T11:00:00.000Z';
const DEPOIS = '2026-10-06T13:00:00.000Z';
const SNOOZE = { snoozedAt: '2026-10-06T09:00:00.000Z', snoozedUntil: ANTES };

const marcador = (campos, agora = AGORA) => marcadorWoke(thread(campos), agora);
const semChave = (campos, ...chaves) => {
  const t = thread(campos);
  for (const k of chaves) delete t[k];
  return t;
};

test('sem snooze ou ainda dormindo: não está woke e não tem wokeAt', () => {
  assert.deepEqual(marcador({}), { woke: false, wokeAt: null });
  assert.deepEqual(marcador({ ...SNOOZE, snoozedUntil: DEPOIS }), { woke: false, wokeAt: null });
});

test('prazo vencido acorda sem evento: updatedAt anterior ao prazo não importa', () => {
  const t = { ...SNOOZE, updatedAt: '2026-10-06T08:00:00.000Z' };
  assert.deepEqual(marcador(t), { woke: true, wokeAt: ANTES });
  // Exatamente no prazo já acordou.
  assert.deepEqual(marcador(t, ANTES), { woke: true, wokeAt: ANTES });
});

test('visita: anterior ao wake mantém, igual ou posterior reconhece, ilegível conta como nunca visitada', () => {
  assert.equal(marcador({ ...SNOOZE, lastVisitedAt: '2026-10-06T10:00:00.000Z' }).woke, true);
  assert.deepEqual(marcador({ ...SNOOZE, lastVisitedAt: ANTES }), { woke: false, wokeAt: ANTES });
  assert.deepEqual(marcador({ ...SNOOZE, lastVisitedAt: '2026-10-06T11:30:00.000Z' }), { woke: false, wokeAt: ANTES });
  assert.equal(marcador({ ...SNOOZE, lastVisitedAt: 'lixo' }).woke, true);
});

test('run concluído depois do snooze acorda antes do prazo, com o instante da conclusão', () => {
  const cedo = { ...SNOOZE, snoozedUntil: DEPOIS, status: 'completed', latestRunCompletedAt: '2026-10-06T10:00:00.000Z' };
  assert.deepEqual(marcador(cedo), { woke: true, wokeAt: '2026-10-06T10:00:00.000Z' });
  // Conclusão anterior ao snooze não acorda.
  assert.deepEqual(marcador({ ...cedo, latestRunCompletedAt: '2026-10-06T08:00:00.000Z' }), { woke: false, wokeAt: null });
  // Wake antecipado reconhecido não volta quando o prazo vence depois.
  assert.deepEqual(marcador({ ...cedo, lastVisitedAt: '2026-10-06T10:30:00.000Z' }, '2026-10-06T14:00:00.000Z'), { woke: false, wokeAt: '2026-10-06T10:00:00.000Z' });
  // Servidor sem latestRunCompletedAt: run terminal usa updatedAt (models.ts:215-220).
  const t = semChave({ ...cedo, updatedAt: '2026-10-06T10:10:00.000Z' }, 'latestRunCompletedAt');
  assert.deepEqual(marcadorWoke(t, AGORA), { woke: true, wokeAt: '2026-10-06T10:10:00.000Z' });
});

test('pedido de aprovação ou pergunta acorda; auth_refresh não', () => {
  const dormindo = { ...SNOOZE, snoozedUntil: DEPOIS, status: 'waiting', updatedAt: '2026-10-06T10:20:00.000Z' };
  const pedido = (kind) => ({ ...dormindo, pendingRuntimeRequest: { id: 'r', kind, createdAt: '2026-10-06T10:20:00.000Z' } });
  assert.deepEqual(marcador(pedido('command')), { woke: true, wokeAt: '2026-10-06T10:20:00.000Z' });
  assert.deepEqual(marcador(pedido('user_input')), { woke: true, wokeAt: '2026-10-06T10:20:00.000Z' });
  assert.deepEqual(marcador(pedido('auth_refresh')), { woke: false, wokeAt: null });
  // Sem run nem provider thread não há runtime: o instante cai no snoozedAt.
  assert.deepEqual(marcador({ ...pedido('command'), latestRunId: null, activeProviderThreadId: null }).wokeAt, SNOOZE.snoozedAt);
});

test('só falha nova acorda; snooze sobre falha já vista continua dormindo', () => {
  const falha = { ...SNOOZE, snoozedUntil: DEPOIS, status: 'failed' };
  assert.deepEqual(marcador({ ...falha, updatedAt: '2026-10-06T10:00:00.000Z' }), { woke: true, wokeAt: '2026-10-06T10:00:00.000Z' });
  assert.deepEqual(marcador({ ...falha, updatedAt: '2026-10-06T08:00:00.000Z' }), { woke: false, wokeAt: null });
});

test('settle explícito suprime o marcador; settledAt sozinho não', () => {
  assert.deepEqual(marcador({ ...SNOOZE, settledOverride: 'settled' }), { woke: false, wokeAt: ANTES });
  assert.equal(marcador({ ...SNOOZE, settledAt: AGORA }).woke, true);
  assert.equal(marcador({ ...SNOOZE, settledOverride: 'active' }).woke, true);
});

test('servidor antigo: sem snooze ou sem watermark de visita compartilhado, woke é null', () => {
  assert.deepEqual(marcadorWoke(semChave({}, 'snoozedUntil', 'snoozedAt'), AGORA), { woke: null, wokeAt: null });
  assert.deepEqual(marcadorWoke(semChave(SNOOZE, 'lastVisitedAt'), AGORA), { woke: null, wokeAt: ANTES });
  // Sem wake, a ausência da visita não importa.
  assert.deepEqual(marcadorWoke(semChave({}, 'lastVisitedAt'), AGORA), { woke: false, wokeAt: null });
});

test('woke não altera o state', () => {
  for (const status of ['running', 'completed', 'failed']) {
    assert.deepEqual(estadoDaThread(thread({ ...SNOOZE, status })), estadoDaThread(thread({ status })));
  }
});

// --- Superfície MCP. O relógio é o real: prazos bem no passado ou no futuro.

const PASSADO = { snoozedAt: '2020-01-01T00:00:00.000Z', snoozedUntil: '2020-01-02T00:00:00.000Z' };
const FUTURO = { snoozedAt: '2020-01-01T00:00:00.000Z', snoozedUntil: '2999-01-01T00:00:00.000Z' };

function remotoComSnooze() {
  const d = dadosPadrao();
  const r = (id, campos) => thread({ id, projectId: REMOTO.projeto, title: id, status: 'completed', latestRunId: `run-${id}`, ...campos });
  d.remoto.shell.threads = [
    r('t-acordou', { ...PASSADO, updatedAt: '2026-10-03T10:01:00.000Z' }),
    r('t-acordou-2', { ...PASSADO, updatedAt: '2026-10-03T10:02:00.000Z' }),
    r('t-vista', { ...PASSADO, lastVisitedAt: '2020-01-03T00:00:00.000Z', updatedAt: '2026-10-03T10:03:00.000Z' }),
    r('t-dormindo', { ...FUTURO, updatedAt: '2026-10-03T10:04:00.000Z' }),
    r('t-normal', { updatedAt: '2026-10-03T10:05:00.000Z' }),
    r('t-sem-run', { ...PASSADO, status: 'idle', latestRunId: null }),
  ];
  d.remoto.bounded['t-acordou'] = { projection: projecao({ runs: [{ id: 'run-t-acordou', ordinal: 1, status: 'completed' }] }), hasMoreHistory: false };
  return d;
}

test('t3_threads: cada thread traz woke/wokeAt e `woke` filtra antes da paginação, só com a shell', async () => {
  const chamadas = [];
  const c = await conectarMcp(ambientesFalsos(remotoComSnooze(), { chamadas }));
  const todas = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto' } }));
  const porId = Object.fromEntries(todas.threads.map((t) => [t.threadId, t]));
  assert.deepEqual(porId['t-acordou'], { ...porId['t-acordou'], woke: true, wokeAt: PASSADO.snoozedUntil, state: 'completed' });
  assert.deepEqual([porId['t-vista'].woke, porId['t-vista'].wokeAt], [false, PASSADO.snoozedUntil]);
  assert.deepEqual([porId['t-dormindo'].woke, porId['t-dormindo'].wokeAt], [false, null]);
  assert.deepEqual([porId['t-normal'].woke, porId['t-normal'].wokeAt], [false, null]);

  const acordadas = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', woke: true, limit: 1 } }));
  assert.equal(acordadas.total, 2);
  assert.equal(acordadas.truncated, true);
  assert.equal('hiddenNoRun' in acordadas, true, 'a sem run woke continua contada como oculta');
  assert.equal(acordadas.hiddenNoRun, 1);
  const p2 = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', woke: true, limit: 1, cursor: acordadas.nextCursor } }));
  assert.deepEqual([...acordadas.threads, ...p2.threads].map((t) => t.threadId), ['t-acordou-2', 't-acordou']);
  const comSemRun = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', woke: true, includeNoRun: true } }));
  assert.deepEqual(comSemRun.threads.map((t) => t.threadId).sort(), ['t-acordou', 't-acordou-2', 't-sem-run']);

  const naoAcordadas = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', woke: false } }));
  assert.deepEqual(naoAcordadas.threads.map((t) => t.threadId).sort(), ['t-dormindo', 't-normal', 't-vista']);
  const combinada = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', woke: true, search: 'acordou-2' } }));
  assert.deepEqual(combinada.threads.map((t) => t.threadId), ['t-acordou-2']);

  // Leitura pura: nenhuma chamada além da shell (nada de visit, detalhe por thread ou dispatch).
  assert.deepEqual([...new Set(chamadas.filter((x) => x.startsWith('remoto:') && x !== 'remoto:ambiente' && x !== 'remoto:sessao'))], ['remoto:shell']);
});

test('t3_threads: cursor distingue woke omitido, true e false; sem woke continua o de antes', async () => {
  const c = await conectarMcp(ambientesFalsos(remotoComSnooze()));
  const sem = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', limit: 1 } }));
  const q = JSON.parse(Buffer.from(sem.nextCursor, 'base64url').toString()).q;
  // Filtros, depois environment pedido, selecionados e os que responderam (cobertura).
  assert.equal(q, JSON.stringify(['t3_threads', null, null, false, '', 'env-remoto', ['env-remoto'], ['env-remoto']]));
  const comTrue = await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', woke: true, limit: 1, cursor: sem.nextCursor } });
  assert.match(comTrue.content[0].text, /^invalid cursor/);
  const t = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', woke: true, limit: 1 } }));
  const comFalse = await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', woke: false, limit: 1, cursor: t.nextCursor } });
  assert.match(comFalse.content[0].text, /^invalid cursor/);
});

test('t3_threads: filtro woke recusado quando o servidor não permite decidir; sem filtro devolve null', async () => {
  const d = remotoComSnooze();
  for (const t of d.remoto.shell.threads) delete t.lastVisitedAt;
  const c = await conectarMcp(ambientesFalsos(d));
  const r = await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', woke: true } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /woke filter is unavailable/);
  const lista = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto' } }));
  assert.equal(lista.threads.find((t) => t.threadId === 't-acordou').woke, null);
  assert.equal(lista.threads.find((t) => t.threadId === 't-normal').woke, false);
});

test('t3_thread traz o mesmo marcador da listagem, e as descrições explicam o contrato', async () => {
  const c = await conectarMcp(ambientesFalsos(remotoComSnooze()));
  const r = dados(await c.callTool({ name: 't3_thread', arguments: { environment: 'remoto', threadId: 't-acordou' } }));
  assert.equal(r.woke, true);
  assert.equal(r.wokeAt, PASSADO.snoozedUntil);
  const { tools } = await c.listTools();
  for (const nome of ['t3_threads', 't3_thread']) {
    const descricao = tools.find((t) => t.name === nome).description;
    assert.match(descricao, /Woke contract/);
    assert.match(descricao, /completionWake/);
  }
});
