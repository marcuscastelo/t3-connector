import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buscarThreads } from '../src/busca-threads.mjs';
import { criarPonteEscrita } from '../src/escrita/ponte-mcp.mjs';
import { resumoDaThread } from '../src/servidor.mjs';
import { Cancelada, ErroT3 } from '../src/t3.mjs';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao, LOCAL, PROJETO_ALHEIO, REMOTO } from './apoio.mjs';
import { thread } from './fixtures.mjs';

const nunca = () => new Promise(() => {});
const recusa = (status) => () => Promise.reject(new ErroT3(`T3 respondeu ${status} em /api/orchestration/shell`, { status }));

async function buscar(args, { d = dadosPadrao(), chamadas, opcoes } = {}) {
  const c = await conectarMcp(ambientesFalsos(d, { chamadas }), opcoes);
  return c.callTool({ name: 't3_buscar_threads', arguments: args });
}

const pares = (r) => r.threads.map((t) => `${t.ambiente.alias}:${t.threadId}`);

test('ID que só existe no remoto é encontrado sem informar ambiente, com o environment no item', async () => {
  const chamadas = [];
  const r = dados(await buscar({ threadId: 't-llm' }, { chamadas }));
  assert.equal(r.total, 1);
  assert.equal(r.completa, true);
  assert.deepEqual(r.falhasAmbientes, []);
  const [t] = r.threads;
  assert.deepEqual(t.ambiente, { alias: 'remoto', environmentId: REMOTO.environmentId, nome: 'remoto' });
  assert.equal(t.titulo, 'Thread remota');
  assert.deepEqual(t.projeto, { projectId: REMOTO.projeto, titulo: 'app' });
  assert.equal(t.arquivada, false);
  assert.equal(t.estado, 'cancelada');
  assert.deepEqual(r.ambientesConsultados.map((a) => [a.alias, a.encontradas]), [['local', 0], ['remoto', 1]]);
  // Descoberta lê só o shell: nenhum /bounded por candidato.
  assert.equal(chamadas.some((c) => c.includes(':thread:')), false);
});

test('mesmo ID em dois environments devolve os dois pares, sem deduplicar nem escolher', async () => {
  const r = dados(await buscar({ threadId: 't-comum' }));
  assert.equal(r.total, 2);
  assert.deepEqual(pares(r), ['local:t-comum', 'remoto:t-comum']);
  assert.deepEqual(r.threads.map((t) => t.titulo), ['Comum no Local', 'Comum no Remoto']);
});

test('limite 1 preserva o total da ambiguidade e o cursor traz o outro environment', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const p1 = dados(await c.callTool({ name: 't3_buscar_threads', arguments: { threadId: 't-comum', limite: 1 } }));
  assert.equal(p1.total, 2);
  assert.equal(p1.retornadas, 1);
  assert.equal(p1.truncado, true);
  assert.deepEqual(pares(p1), ['local:t-comum']);
  const p2 = dados(await c.callTool({ name: 't3_buscar_threads', arguments: { threadId: 't-comum', limite: 1, cursor: p1.proximoCursor } }));
  assert.deepEqual(pares(p2), ['remoto:t-comum']);
  assert.equal(p2.truncado, false);
  assert.equal('proximoCursor' in p2, false);
});

test('mesmo título em environments e projetos diferentes aparece inteiro em correspondência exata', async () => {
  const d = dadosPadrao();
  d.remoto.shell.threads.push(thread({ id: 't-dup', projectId: REMOTO.projeto, title: 'Comum no Local' }));
  d.local.shell.threads.push(thread({ id: 't-dup2', projectId: LOCAL.projeto, title: 'comum no local' }));
  const r = dados(await buscar({ busca: 'Comum no Local', correspondencia: 'exata' }, { d }));
  assert.equal(r.correspondencia, 'exata');
  assert.deepEqual(pares(r), ['local:t-comum', 'local:t-dup2', 'remoto:t-dup']);
});

test('parcial casa trecho, caixa e acento; exata exige o título inteiro', async () => {
  const d = dadosPadrao();
  d.remoto.shell.threads.push(thread({ id: 't-acento', projectId: REMOTO.projeto, title: 'Revisão do Conector' }));
  assert.deepEqual(pares(dados(await buscar({ busca: 'COMUM' }, { d }))), ['local:t-comum', 'remoto:t-comum']);
  assert.deepEqual(pares(dados(await buscar({ busca: 'revisao' }, { d }))), ['remoto:t-acento']);
  assert.equal(dados(await buscar({ busca: 'comum', correspondencia: 'exata' }, { d })).total, 0);
  assert.deepEqual(pares(dados(await buscar({ busca: 'revisao do conector', correspondencia: 'exata' }, { d }))), ['remoto:t-acento']);
  // busca por trecho também casa o ID, como em t3_threads.
  assert.deepEqual(pares(dados(await buscar({ busca: 't-com' }, { d }))), ['local:t-comum', 'remoto:t-comum']);
});

test('threadId é literal: nem prefixo nem outra caixa casam', async () => {
  assert.equal(dados(await buscar({ threadId: 't-com' })).total, 0);
  assert.equal(dados(await buscar({ threadId: 'T-COMUM' })).total, 0);
});

test('ACL e universo: projeto alheio e deletadas nunca aparecem; arquivadas e sem execução sim', async () => {
  const d = dadosPadrao();
  d.remoto.shell.threads.push(
    thread({ id: 't-arq', projectId: REMOTO.projeto, title: 'Alvo arquivado', archivedAt: '2026-10-03T11:00:00.000Z' }),
    thread({ id: 't-del', projectId: REMOTO.projeto, title: 'Alvo deletado', deletedAt: '2026-10-03T11:00:00.000Z' }),
    thread({ id: 't-sem', projectId: REMOTO.projeto, title: 'Alvo sem run', latestRunId: null, status: 'idle' }),
  );
  d.local.shell.threads.push(thread({ id: 't-proibida', projectId: PROJETO_ALHEIO, title: 'Alvo proibido' }));
  const chamadas = [];
  const r = dados(await buscar({ busca: 'alvo' }, { d, chamadas }));
  assert.deepEqual(pares(r), ['remoto:t-arq', 'remoto:t-sem']);
  assert.equal(r.threads[0].arquivada, true);
  assert.equal(r.threads[1].estado, 'sem_execucao');
  assert.equal(dados(await buscar({ threadId: 't-alheia' }, { d })).total, 0);
  assert.equal(chamadas.some((c) => c.includes(':thread:')), false);
  // A listagem antiga continua sem arquivadas.
  const c = await conectarMcp(ambientesFalsos(d));
  const antiga = dados(await c.callTool({ name: 't3_threads', arguments: { ambiente: 'remoto', busca: 'alvo', incluirSemExecucao: true } }));
  assert.deepEqual(antiga.threads.map((t) => t.threadId), ['t-sem']);
});

test('ambiente (alias ou ID) restringe a busca sem conectar nos outros', async () => {
  for (const ambiente of ['remoto', REMOTO.environmentId]) {
    const chamadas = [];
    const r = dados(await buscar({ threadId: 't-comum', ambiente }, { chamadas }));
    assert.deepEqual(pares(r), ['remoto:t-comum']);
    assert.deepEqual(r.ambientesConsultados.map((a) => a.alias), ['remoto']);
    assert.equal(chamadas.some((c) => c.startsWith('local:')), false);
  }
  const r = await buscar({ threadId: 't-comum', ambiente: 'inexistente' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /não configurado; disponíveis: local, remoto/);
});

test('cursor vale para alias e ID do mesmo environment', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const p1 = dados(await c.callTool({ name: 't3_buscar_threads', arguments: { busca: 'comum', ambiente: 'local', limite: 1 } }));
  assert.equal(p1.total, 1);
  const d = dadosPadrao();
  d.local.shell.threads.push(thread({ id: 't-comum2', projectId: LOCAL.projeto, title: 'Comum 2' }));
  const c2 = await conectarMcp(ambientesFalsos(d));
  const a = dados(await c2.callTool({ name: 't3_buscar_threads', arguments: { busca: 'comum', ambiente: 'local', limite: 1 } }));
  const b = dados(await c2.callTool({ name: 't3_buscar_threads', arguments: { busca: 'comum', ambiente: LOCAL.environmentId, limite: 1, cursor: a.proximoCursor } }));
  assert.deepEqual(pares(b), ['local:t-comum2']);
});

test('entrada inválida é erro: nenhum critério, os dois, busca vazia, correspondência com ID', async () => {
  for (const args of [{}, { busca: 'x', threadId: 'y' }, { busca: '   ' }, { threadId: 't-comum', correspondencia: 'exata' }]) {
    const r = await buscar(args);
    assert.equal(r.isError, true, JSON.stringify(args));
  }
});

test('falha parcial: environment que recusa o token sai em falhasAmbientes e os outros respondem', async () => {
  const d = dadosPadrao();
  d.remoto.shell = recusa(401);
  const r = await buscar({ threadId: 't-comum' }, { d });
  assert.equal(r.isError, undefined);
  const x = dados(r);
  assert.equal(x.completa, false);
  assert.deepEqual(pares(x), ['local:t-comum']);
  assert.deepEqual(x.falhasAmbientes, [{ alias: 'remoto', environmentId: REMOTO.environmentId, codigo: 'http_401', motivo: 'T3 recusou o token desse environment' }]);
  assert.deepEqual(x.ambientesConsultados.map((a) => a.alias), ['local']);
});

test('falha parcial: endpoint com outra identidade não contribui resultados', async () => {
  const d = dadosPadrao();
  d.remoto.descritor.environmentId = 'env-impostor';
  const x = dados(await buscar({ busca: 'comum' }, { d }));
  assert.deepEqual(pares(x), ['local:t-comum']);
  assert.equal(x.falhasAmbientes[0].codigo, 'environment_divergente');
});

test('erro sem código não vaza mensagem interna (caminho de token, ssh)', async () => {
  const d = dadosPadrao();
  d.remoto.shell = () => Promise.reject(new ErroT3('token ausente em /home/alguem/.config/segredo; rode `t3-connector pair`'));
  const x = dados(await buscar({ busca: 'comum' }, { d }));
  assert.equal(x.falhasAmbientes[0].codigo, 'conexao_recusada');
  assert.doesNotMatch(JSON.stringify(x), /segredo|\/home\//);
});

test('environment que não responde vira falha de prazo sem segurar a busca', async () => {
  const d = dadosPadrao();
  d.remoto.shell = nunca;
  const inicio = Date.now();
  const x = dados(await buscar({ busca: 'comum' }, { d, opcoes: { prazoAmbienteMs: 50 } }));
  assert.ok(Date.now() - inicio < 2000);
  assert.equal(x.completa, false);
  assert.deepEqual(pares(x), ['local:t-comum']);
  assert.deepEqual(x.falhasAmbientes.map((f) => [f.alias, f.codigo]), [['remoto', 'prazo']]);
});

test('prazo total: o pendente e os não iniciados entram nas falhas', async () => {
  const d = dadosPadrao();
  d.local.shell = nunca;
  const chamadas = [];
  const x = dados(await buscar({ busca: 'comum' }, { d, chamadas, opcoes: { prazoAmbienteMs: 5000, prazoTotalMs: 50, concorrencia: 1 } }));
  assert.equal(x.total, 0);
  assert.equal(x.completa, false);
  assert.deepEqual(x.falhasAmbientes.map((f) => [f.alias, f.codigo]), [['local', 'prazo_global'], ['remoto', 'prazo_global']]);
  assert.equal(chamadas.some((c) => c.startsWith('remoto:')), false);
});

test('todos falham: envelope incompleto, sem erro e sem afirmar que a thread não existe', async () => {
  const d = dadosPadrao();
  d.local.shell = recusa(403);
  d.remoto.shell = recusa(500);
  const r = await buscar({ threadId: 't-comum' }, { d });
  assert.equal(r.isError, undefined);
  const x = dados(r);
  assert.equal(x.total, 0);
  assert.equal(x.completa, false);
  assert.deepEqual(x.ambientesConsultados, []);
  assert.deepEqual(x.falhasAmbientes.map((f) => f.codigo), ['http_403', 'http_500']);
  // Distinto de "consultou tudo e não achou".
  const vazio = dados(await buscar({ threadId: 'inexistente' }));
  assert.equal(vazio.total, 0);
  assert.equal(vazio.completa, true);
});

test('cancelamento do cliente encerra a busca em vez de virar falha parcial', async () => {
  const d = dadosPadrao();
  d.remoto.shell = nunca;
  const ambientes = ambientesFalsos(d);
  const controle = new AbortController();
  const busca = buscarThreads(ambientes, { search: 'comum' }, { signal: controle.signal, resumir: resumoDaThread });
  setTimeout(() => controle.abort(), 20);
  await assert.rejects(busca, Cancelada);
});

test('paginação agregada: ordem por (environmentId, threadId) estável, IDs repetidos entre environments', async () => {
  const d = dadosPadrao();
  const lote = (projectId) => Array.from({ length: 30 }, (_, i) => thread({
    id: `lote-${String(i).padStart(2, '0')}`,
    projectId,
    title: `Lote ${i}`,
    updatedAt: new Date(Date.parse('2026-10-03T00:00:00.000Z') + i * 60000).toISOString(),
  }));
  d.local.shell.threads.push(...lote(LOCAL.projeto));
  d.remoto.shell.threads.push(...lote(REMOTO.projeto));
  const c = await conectarMcp(ambientesFalsos(d));
  const vistos = [];
  let cursor;
  let limite = 20;
  do {
    const p = dados(await c.callTool({ name: 't3_buscar_threads', arguments: { busca: 'lote', limite, ...(cursor ? { cursor } : {}) } }));
    assert.equal(p.total, 60);
    vistos.push(...pares(p));
    cursor = p.proximoCursor;
    limite = 25; // o limite pode mudar entre páginas
  } while (cursor);
  const esperado = [
    ...Array.from({ length: 30 }, (_, i) => `local:lote-${String(i).padStart(2, '0')}`),
    ...Array.from({ length: 30 }, (_, i) => `remoto:lote-${String(i).padStart(2, '0')}`),
  ];
  assert.deepEqual(vistos, esperado);

  const p1 = dados(await c.callTool({ name: 't3_buscar_threads', arguments: { busca: 'lote', limite: 10 } }));
  for (const outra of [{ busca: 'lot' }, { busca: 'lote', correspondencia: 'exata' }, { busca: 'lote', ambiente: 'local' }]) {
    const r = await c.callTool({ name: 't3_buscar_threads', arguments: { ...outra, limite: 10, cursor: p1.proximoCursor } });
    assert.equal(r.isError, true, JSON.stringify(outra));
    assert.match(r.content[0].text, /cursor inválido/);
  }
});

test('cursor deixa de valer quando muda o conjunto de environments que responderam', async () => {
  const d = dadosPadrao();
  const c = await conectarMcp(ambientesFalsos(d));
  const p1 = dados(await c.callTool({ name: 't3_buscar_threads', arguments: { threadId: 't-comum', limite: 1 } }));
  assert.equal(p1.completa, true);
  d.remoto.shell = recusa(403);
  const r = await c.callTool({ name: 't3_buscar_threads', arguments: { threadId: 't-comum', limite: 1, cursor: p1.proximoCursor } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /environments que responderam mudaram/);
});

test('ponte de escrita não ganhou a busca e ações continuam exigindo ambiente', async () => {
  const servidor = criarPonteEscrita({ relay: async () => ({}), aliases: ['local'], approvalOrigin: 'http://localhost:7433' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await servidor.connect(b);
  const c = new Client({ name: 'teste', version: '1' });
  await c.connect(a);
  try {
    const { tools } = await c.listTools();
    assert.equal(tools.some((t) => t.name === 't3_buscar_threads'), false);
    const comAmbiente = tools.filter((t) => t.inputSchema?.properties?.environment);
    assert.ok(comAmbiente.length > 0);
    for (const t of comAmbiente) assert.ok(t.inputSchema.required?.includes('environment'), t.name);
  } finally {
    await c.close();
    await servidor.close();
  }
});
