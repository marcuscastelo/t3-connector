import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErroT3 } from '../src/t3.mjs';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao, LOCAL, REMOTO } from './apoio.mjs';
import { thread } from './fixtures.mjs';

const nunca = () => new Promise(() => {});
const recusa = (status) => () => Promise.reject(new ErroT3(`T3 respondeu ${status}`, { status }));

async function lote(args, { d = dadosPadrao(), chamadas = [], opcoes } = {}) {
  const c = await conectarMcp(ambientesFalsos(d, { chamadas }), opcoes);
  return c.callTool({ name: 't3_thread_find_batch', arguments: args });
}
const pares = (r) => r.candidates.map((t) => `${t.environment.alias}:${t.threadId}`);
const porChave = (r) => Object.fromEntries(r.results.map((x) => [x.key, x]));

test('várias consultas numa chamada: uma leitura de shell por environment, resultado por chave na ordem pedida', async () => {
  const chamadas = [];
  const r = dados(await lote({
    queries: [
      { key: 'remota', search: 'Thread remota', match: 'exact' },
      { key: 'comum', threadId: 't-comum' },
      { key: 'sumida', threadId: 't-nao-existe' },
      { key: 'pendente', search: 't-local' },
    ],
  }, { chamadas }));
  assert.deepEqual(chamadas.filter((c) => c.endsWith(':shell')).sort(), ['local:shell', 'remoto:shell']);
  assert.deepEqual(r.results.map((x) => x.key), ['remota', 'comum', 'sumida', 'pendente']);
  assert.equal(r.complete, true);
  assert.deepEqual(r.summary, { resolved: 2, ambiguous: 1, not_found: 1, inconclusive: 0, error: 0 });
  const x = porChave(r);
  assert.equal(x.remota.resolution, 'resolved');
  assert.deepEqual(pares(x.remota), ['remoto:t-llm']);
  assert.deepEqual(x.remota.candidates[0].project, { projectId: REMOTO.projeto, title: 'app' });
  assert.equal(x.remota.match, 'exact');
  // Mesmo ID em dois environments: ambígua, com os dois pares e sem escolher.
  assert.equal(x.comum.resolution, 'ambiguous');
  assert.deepEqual(pares(x.comum), ['local:t-comum', 'remoto:t-comum']);
  assert.equal(x.sumida.resolution, 'not_found');
  assert.equal(x.sumida.total, 0);
  assert.equal(x.pendente.candidates[0].state, 'needs_intervention');
  for (const q of r.results) {
    assert.equal(q.complete, true);
    assert.deepEqual(q.environmentFailures, []);
    assert.deepEqual(q.queriedEnvironments.map((a) => a.alias), ['local', 'remoto']);
  }
  assert.deepEqual(x.comum.queriedEnvironments.map((a) => a.found), [1, 1]);
});

test('título ambíguo: mesmo título exato em projetos e environments diferentes nunca vira resolved', async () => {
  const d = dadosPadrao();
  d.local.shell.threads.push(thread({ id: 't-dup-l', projectId: LOCAL.projeto, title: 'Revisar PR' }));
  d.remoto.shell.threads.push(thread({ id: 't-dup-r', projectId: REMOTO.projeto, title: 'revisar pr' }));
  const r = dados(await lote({ queries: [{ key: 'pr', search: 'Revisar PR', match: 'exact', limit: 1 }] }, { d }));
  const [q] = r.results;
  assert.equal(q.resolution, 'ambiguous');
  // A página mostra um só, mas total e resolution contam todos.
  assert.equal(q.total, 2);
  assert.equal(q.returned, 1);
  assert.equal(q.truncated, true);
  assert.ok(q.nextCursor);
});

test('cursor por consulta traz a próxima página só daquela consulta', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const queries = [{ key: 'a', threadId: 't-comum', limit: 1 }, { key: 'b', threadId: 't-llm' }];
  const p1 = dados(await c.callTool({ name: 't3_thread_find_batch', arguments: { queries } }));
  assert.deepEqual(pares(p1.results[0]), ['local:t-comum']);
  const p2 = dados(await c.callTool({ name: 't3_thread_find_batch', arguments: { queries: [{ ...queries[0], cursor: p1.results[0].nextCursor }] } }));
  assert.deepEqual(pares(p2.results[0]), ['remoto:t-comum']);
  assert.equal(p2.results[0].resolution, 'ambiguous');
});

test('cursor inválido falha só a sua consulta; as outras respondem', async () => {
  const r = dados(await lote({ queries: [{ key: 'ruim', threadId: 't-comum', cursor: 'lixo' }, { key: 'boa', threadId: 't-llm' }] }));
  const x = porChave(r);
  assert.equal(x.ruim.status, 'error');
  assert.equal(x.ruim.error.code, 'cursor_invalid');
  assert.equal(x.boa.status, 'ok');
  assert.equal(x.boa.resolution, 'resolved');
  assert.equal(r.summary.error, 1);
});

test('cursor de outra cobertura vira cursor_coverage_changed na sua consulta', async () => {
  const d = dadosPadrao();
  const c = await conectarMcp(ambientesFalsos(d));
  const q = { key: 'a', threadId: 't-comum', limit: 1 };
  const p1 = dados(await c.callTool({ name: 't3_thread_find_batch', arguments: { queries: [q] } }));
  d.remoto.shell = recusa(500);
  const p2 = dados(await c.callTool({ name: 't3_thread_find_batch', arguments: { queries: [{ ...q, cursor: p1.results[0].nextCursor }] } }));
  assert.equal(p2.results[0].error.code, 'cursor_coverage_changed');
});

test('environment que falha: complete e environmentFailures por consulta; zero ou um candidato vira inconclusive', async () => {
  const d = dadosPadrao();
  d.remoto.shell = recusa(401);
  d.local.shell.threads.push(thread({ id: 't-dup', projectId: LOCAL.projeto, title: 'Comum no Local' }));
  const r = dados(await lote({
    queries: [
      { key: 'so-remota', threadId: 't-llm' },
      { key: 'uma-local', threadId: 't-local' },
      { key: 'duas-locais', search: 'Comum no Local', match: 'exact' },
    ],
  }, { d }));
  assert.equal(r.complete, false);
  assert.deepEqual(r.environmentFailures.map((f) => [f.alias, f.code]), [['remoto', 'http_401']]);
  const x = porChave(r);
  assert.equal(x['so-remota'].resolution, 'inconclusive');
  assert.equal(x['uma-local'].resolution, 'inconclusive', 'one candidate with a failed environment is not proof of uniqueness');
  assert.equal(x['duas-locais'].resolution, 'ambiguous');
  for (const q of r.results) {
    assert.equal(q.complete, false);
    assert.deepEqual(q.environmentFailures.map((f) => f.alias), ['remoto']);
    assert.deepEqual(q.queriedEnvironments.map((a) => a.alias), ['local']);
  }
});

test('environment que não responde vira timeout sem segurar as consultas', async () => {
  const d = dadosPadrao();
  d.remoto.shell = nunca;
  const r = dados(await lote({ queries: [{ key: 'a', threadId: 't-local' }] }, { d, opcoes: { prazoAmbienteMs: 50 } }));
  assert.equal(r.results[0].environmentFailures[0].code, 'timeout');
  assert.equal(r.results[0].resolution, 'inconclusive');
});

test('environments restringe a busca e deduplica alias e environmentId', async () => {
  const chamadas = [];
  const r = dados(await lote({ environments: ['remoto', REMOTO.environmentId], queries: [{ key: 'a', threadId: 't-comum' }] }, { chamadas }));
  assert.deepEqual(chamadas.filter((c) => c.endsWith(':shell')), ['remoto:shell']);
  assert.equal(r.results[0].resolution, 'resolved');
  assert.deepEqual(pares(r.results[0]), ['remoto:t-comum']);
});

test('consultas repetidas com chaves diferentes respondem cada uma; chave repetida recusa a chamada antes de ler', async () => {
  const r = dados(await lote({ queries: [{ key: 'a', threadId: 't-llm' }, { key: 'b', threadId: 't-llm' }] }));
  assert.deepEqual(r.results.map((x) => [x.key, x.resolution]), [['a', 'resolved'], ['b', 'resolved']]);
  const chamadas = [];
  const dup = await lote({ queries: [{ key: 'a', threadId: 't-llm' }, { key: 'a', search: 'remota' }] }, { chamadas });
  assert.equal(dup.isError, true);
  assert.match(dup.content[0].text, /duplicate query key "a"/);
  assert.equal(chamadas.length, 0);
});

test('consulta estruturalmente inválida recusa a chamada inteira', async () => {
  for (const queries of [
    [{ key: 'a', search: 'x', threadId: 't-llm' }],
    [{ key: 'a', threadId: 't-llm', match: 'exact' }],
    [{ key: 'a' }],
    [],
  ]) {
    const chamadas = [];
    const r = await lote({ queries }, { chamadas });
    assert.equal(r.isError, true, JSON.stringify(queries));
    assert.equal(chamadas.length, 0);
  }
  const branco = await lote({ queries: [{ key: 'ok', threadId: 't-llm' }, { key: 'b', search: '   ' }] });
  assert.equal(branco.isError, true);
  assert.match(branco.content[0].text, /query "b": `search` is empty/);
  const desconhecido = await lote({ environments: ['marte'], queries: [{ key: 'a', threadId: 't-llm' }] });
  assert.equal(desconhecido.isError, true);
  assert.match(desconhecido.content[0].text, /not configured/);
});
