import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao, LOCAL, REMOTO } from './apoio.mjs';
import { ErroT3 } from '../src/t3.mjs';

const lote = (c, args) => c.callTool({ name: 't3_thread_read_batch', arguments: args });
const semAmbiente = ({ environment, ...resto }) => resto;

test('lote misto: cada alvo bom traz o mesmo detalhe de t3_thread e os quebrados falham só no próprio item', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const r = dados(await lote(c, {
    items: [
      { environment: 'local', threadId: 't-local' },
      { environment: 'remoto', threadId: 't-llm' },
      { environment: 'local', threadId: 't-alheia' }, // projeto fora do escopo
      { environment: 'remoto', threadId: 't-local' }, // só existe no Local: sem fallback
      { environment: 'nenhum', threadId: 't-local' },
      { environment: REMOTO.environmentId, threadId: 't-comum' }, // projeção falha
    ],
  }));
  assert.deepEqual(r.items.map((x) => [x.index, x.status, x.error?.code ?? null]), [
    [0, 'ok', null],
    [1, 'ok', null],
    [2, 'error', 'thread_not_found'],
    [3, 'error', 'thread_not_found'],
    [4, 'error', 'environment_not_allowed'],
    [5, 'error', 'failed'],
  ]);
  assert.deepEqual(r.summary, { ok: 2, error: 4 });
  assert.equal(r.returned, 6);
  assert.equal(r.allSucceeded, false);
  assert.equal(r.complete, false, 'a projeção que falhou pode dar certo numa releitura');

  for (const [i, environment, threadId] of [[0, 'local', 't-local'], [1, 'remoto', 't-llm']]) {
    const unica = dados(await c.callTool({ name: 't3_thread', arguments: { environment, threadId } }));
    assert.deepEqual(r.items[i].thread, semAmbiente(unica), `${environment}/${threadId}`);
    assert.deepEqual(r.items[i].environment, unica.environment);
    assert.equal(r.items[i].threadId, threadId);
    assert.ok(r.items[i].observedAt);
  }
  const local = r.items[0].thread;
  assert.equal(local.state, 'needs_intervention');
  assert.equal(local.pendingRequests[0].requestId, 'req-1');
  assert.ok(local.pendingRequests[0].nextAction);
  assert.equal(local.latestResponse.text, 'Vou rodar o build.');
  assert.equal(r.items[1].thread.latestRun.runId, 'run-s3');

  assert.deepEqual(r.items[4], {
    index: 4, environment: null, requestedEnvironment: 'nenhum', threadId: 't-local', status: 'error',
    error: { code: 'environment_not_allowed', reason: r.items[4].error.reason },
  });
  assert.match(r.items[4].error.reason, /not configured/);
  // Mesma resposta para inexistente e fora do escopo: o item não revela threads de outros projetos.
  assert.equal(r.items[2].error.reason, 'thread t-alheia not found in the authorized projects of environment local');
  assert.deepEqual(r.environments.map((e) => [e.alias, e.status]), [['local', 'ok'], ['remoto', 'ok']]);
});

test('uma shell por environment por chamada, e alvo repetido é lido uma vez e respondido nas duas posições', async () => {
  const chamadas = [];
  const c = await conectarMcp(ambientesFalsos(dadosPadrao(), { chamadas }));
  const r = dados(await lote(c, {
    items: [
      { environment: 'local', threadId: 't-local' },
      { environment: 'local', threadId: 't-comum' },
      { environment: LOCAL.environmentId, threadId: 't-local' },
      { environment: 'remoto', threadId: 't-llm' },
    ],
  }));
  assert.ok(r.allSucceeded);
  assert.ok(r.complete);
  assert.deepEqual(r.items.map((x) => x.index), [0, 1, 2, 3]);
  assert.deepEqual(r.items[2].thread, r.items[0].thread);
  assert.equal(chamadas.filter((x) => x === 'local:shell').length, 1);
  assert.equal(chamadas.filter((x) => x === 'remoto:shell').length, 1);
  assert.equal(chamadas.filter((x) => x === 'local:thread:t-local').length, 1);
  // Os itens de um environment carregam o instante da mesma observação da shell.
  assert.equal(r.items[0].observedAt, r.items[1].observedAt);
  assert.equal(r.items[0].observedAt, r.environments.find((e) => e.alias === 'local').observedAt);
});

test('environment fora do ar falha só nos seus itens; os do outro seguem', async () => {
  const d = dadosPadrao();
  d.remoto.shell = () => { throw new ErroT3('T3 unavailable', { codigo: 'indisponivel' }); };
  const chamadas = [];
  const c = await conectarMcp(ambientesFalsos(d, { chamadas }));
  const r = dados(await lote(c, {
    items: [
      { environment: 'remoto', threadId: 't-llm' },
      { environment: 'local', threadId: 't-comum' },
      { environment: 'remoto', threadId: 't-comum' },
    ],
  }));
  assert.deepEqual(r.items.map((x) => [x.status, x.error?.code ?? null]), [['error', 'unavailable'], ['ok', null], ['error', 'unavailable']]);
  assert.equal(r.items[1].thread.title, 'Comum no Local');
  assert.deepEqual(r.items[0].environment, { alias: 'remoto', environmentId: REMOTO.environmentId });
  const remoto = r.environments.find((e) => e.alias === 'remoto');
  assert.equal(remoto.status, 'error');
  assert.equal(remoto.error.code, 'unavailable');
  assert.equal(r.complete, false);
  assert.ok(chamadas.includes('remoto:descartar'), 'a conexão caída é descartada para a próxima chamada');
});

test('projeção com transporte caído falha só naquele item e descarta a conexão para a próxima chamada', async () => {
  const chamadas = [];
  const amb = ambientesFalsos(dadosPadrao(), { chamadas });
  const c = await conectarMcp(amb);
  const { cliente } = await amb.conectar(amb.resolver('remoto'));
  const thread = cliente.thread;
  cliente.thread = async (id, o) => {
    if (id === 't-llm') throw new ErroT3('T3 unavailable', { codigo: 'indisponivel' });
    return thread(id, o);
  };
  const r = dados(await lote(c, { items: [{ environment: 'remoto', threadId: 't-llm' }, { environment: 'local', threadId: 't-comum' }] }));
  assert.deepEqual(r.items.map((x) => [x.status, x.error?.code ?? null]), [['error', 'unavailable'], ['ok', null]]);
  assert.equal(r.environments.find((e) => e.alias === 'remoto').status, 'ok', 'a shell do Remoto foi lida');
  assert.ok(chamadas.includes('remoto:descartar'));
});

test('prazo da chamada inteira: o environment lento vira global_timeout e o rápido responde', async () => {
  const d = dadosPadrao();
  d.remoto.shell = () => new Promise(() => {});
  const c = await conectarMcp(ambientesFalsos(d));
  const inicio = Date.now();
  const r = dados(await lote(c, {
    timeoutMs: 1000,
    items: [{ environment: 'remoto', threadId: 't-llm' }, { environment: 'local', threadId: 't-local' }],
  }));
  assert.ok(Date.now() - inicio < 5000);
  assert.deepEqual(r.items.map((x) => [x.status, x.error?.code ?? null]), [['error', 'global_timeout'], ['ok', null]]);
  assert.equal(r.complete, false);
});

test('projeção que passa do prazo vira global_timeout sem segurar os outros itens', async () => {
  const d = dadosPadrao();
  const amb = ambientesFalsos(d);
  const c = await conectarMcp(amb);
  // A projeção de t-local só responde depois do prazo da chamada.
  let liberar;
  const lento = new Promise((ok) => { liberar = ok; });
  const { cliente } = await amb.conectar(amb.resolver('local'));
  const thread = cliente.thread;
  cliente.thread = async (id, o) => (id === 't-local' ? (await lento, thread(id, o)) : thread(id, o));
  const r = dados(await lote(c, { timeoutMs: 1000, items: [{ environment: 'local', threadId: 't-local' }, { environment: 'local', threadId: 't-comum' }] }));
  liberar();
  assert.equal(r.items[0].status, 'error');
  assert.equal(r.items[0].error.code, 'global_timeout');
  assert.equal(r.items[1].status, 'ok');
});

test('entrada: environment por item obrigatório, chaves estritas e no máximo 20 alvos', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const { tools } = await c.listTools();
  const schema = tools.find((t) => t.name === 't3_thread_read_batch').inputSchema;
  assert.deepEqual(schema.required, ['items']);
  assert.equal(schema.properties.items.maxItems, 20);
  assert.deepEqual(schema.properties.items.items.required.sort(), ['environment', 'threadId']);
  for (const items of [
    [],
    [{ threadId: 't-local' }],
    [{ environment: 'local', threadId: 't-local', ambiente: 'remoto' }],
    Array.from({ length: 21 }, (_, i) => ({ environment: 'local', threadId: `t-${i}` })),
  ]) {
    assert.equal((await lote(c, { items })).isError, true, JSON.stringify(items).slice(0, 80));
  }
  assert.equal((await lote(c, { items: [{ environment: 'local', threadId: 't-local' }], environment: 'local' })).isError, true);
});
