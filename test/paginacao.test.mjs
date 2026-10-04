import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { criarPonteEscrita } from '../src/escrita/ponte-mcp.mjs';
import { leituraProtegida } from '../src/escrita/read-guarded.mjs';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao, REMOTO } from './apoio.mjs';
import { thread } from './fixtures.mjs';

/** Remoto com `n` threads concluídas, uma por minuto; a mais antiga é a 'Alvo da busca'. */
function remotoCom(n, extras = []) {
  const d = dadosPadrao();
  const base = Date.parse('2026-10-03T00:00:00.000Z');
  d.remoto.shell.threads = [
    ...Array.from({ length: n }, (_, i) => thread({
      id: `t-${String(i).padStart(3, '0')}`,
      projectId: REMOTO.projeto,
      title: i === 0 ? 'Revisão do Conector ChatGPT' : `Thread ${i}`,
      status: 'completed',
      updatedAt: new Date(base + i * 60000).toISOString(),
    })),
    ...extras,
  ];
  return d;
}

async function todasAsPaginas(c, args) {
  const paginas = [];
  let cursor;
  do {
    const p = dados(await c.callTool({ name: 't3_threads', arguments: { ...args, ...(cursor ? { cursor } : {}) } }));
    paginas.push(p);
    cursor = p.nextCursor;
  } while (cursor);
  return paginas;
}

test('t3_threads sem parâmetros novos mantém lista e total, e diz que não truncou', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const r = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto' } }));
  assert.equal(r.total, 2);
  assert.deepEqual(r.threads.map((t) => t.title).sort(), ['Comum no Remoto', 'Thread remota']);
  assert.equal(r.returned, 2);
  assert.equal(r.truncated, false);
  assert.equal('nextCursor' in r, false);
  assert.equal('search' in r, false);
});

test('schema de t3_threads e t3_projetos: parâmetros em inglês, todos opcionais', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const { tools } = await c.listTools();
  const threads = tools.find((t) => t.name === 't3_threads').inputSchema;
  assert.deepEqual(Object.keys(threads.properties).sort(), ['cursor', 'environment', 'includeNoRun', 'limit', 'projectId', 'search', 'state']);
  assert.deepEqual(threads.required ?? [], []);
  assert.equal(threads.properties.limit.maximum, 50);
  assert.deepEqual(threads.properties.state.enum, ['running', 'needs_intervention', 'completed', 'failed', 'cancelled', 'no_run', 'unknown']);
  const projetos = tools.find((t) => t.name === 't3_projetos').inputSchema;
  assert.deepEqual(Object.keys(projetos.properties).sort(), ['cursor', 'environment', 'limit', 'search']);
  assert.deepEqual(projetos.required ?? [], []);
});

test('busca acha pelo título a thread que fica fora da primeira página, sem diferenciar caixa e acento', async () => {
  const c = await conectarMcp(ambientesFalsos(remotoCom(120)));
  const primeira = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', limit: 50 } }));
  assert.equal(primeira.total, 120);
  assert.equal(primeira.truncated, true);
  assert.ok(!primeira.threads.some((t) => t.threadId === 't-000'));
  const achada = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', search: 'revisao do conector chatgpt' } }));
  assert.equal(achada.total, 1);
  assert.equal(achada.search, 'revisao do conector chatgpt');
  assert.equal(achada.truncated, false);
  assert.deepEqual(achada.threads.map((t) => t.threadId), ['t-000']);
  const porId = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', search: 'T-000' } }));
  assert.deepEqual(porId.threads.map((t) => t.title), ['Revisão do Conector ChatGPT']);
});

test('cursor percorre mais que o limite sem perder nem repetir, com total estável', async () => {
  const c = await conectarMcp(ambientesFalsos(remotoCom(120)));
  const paginas = await todasAsPaginas(c, { environment: 'remoto', limit: 50 });
  assert.deepEqual(paginas.map((p) => p.returned), [50, 50, 20]);
  assert.deepEqual(paginas.map((p) => p.truncated), [true, true, false]);
  assert.ok(paginas.every((p) => p.total === 120));
  const ids = paginas.flatMap((p) => p.threads.map((t) => t.threadId));
  assert.equal(new Set(ids).size, 120);
  const datas = paginas.flatMap((p) => p.threads.map((t) => t.updatedAt));
  assert.deepEqual(datas, [...datas].sort().reverse(), 'da mais recente para a mais antiga');
});

test('empate de updatedAt é desempatado pelo threadId, sem perda na fronteira da página', async () => {
  const d = dadosPadrao();
  d.remoto.shell.threads = Array.from({ length: 7 }, (_, i) => thread({ id: `t-${i}`, projectId: REMOTO.projeto, status: 'completed' }));
  const c = await conectarMcp(ambientesFalsos(d));
  const paginas = await todasAsPaginas(c, { environment: 'remoto', limit: 3 });
  assert.deepEqual(paginas.flatMap((p) => p.threads.map((t) => t.threadId)), ['t-0', 't-1', 't-2', 't-3', 't-4', 't-5', 't-6']);
});

test('thread atualizada entre páginas não some em silêncio', async () => {
  const d = remotoCom(10);
  const c = await conectarMcp(ambientesFalsos(d));
  const p1 = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', limit: 4 } }));
  // A t-001 ainda não foi lida; ela sobe para o topo antes da página 2.
  const t = d.remoto.shell.threads.find((x) => x.id === 't-001');
  t.updatedAt = '2026-10-03T23:00:00.000Z';
  const p2 = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', limit: 4, cursor: p1.nextCursor } }));
  assert.equal(p2.changedSinceStart, 1);
  assert.ok(!p2.threads.some((x) => x.threadId === 't-001'));
  const releitura = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', limit: 1 } }));
  assert.equal(releitura.threads[0].threadId, 't-001');
});

test('cursor de outra consulta ou malformado é recusado com mensagem clara', async () => {
  const c = await conectarMcp(ambientesFalsos(remotoCom(30)));
  const p1 = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', limit: 5 } }));
  for (const args of [
    { environment: 'remoto', search: 'Thread', cursor: p1.nextCursor },
    { environment: 'remoto', includeNoRun: true, cursor: p1.nextCursor },
    { environment: 'local', cursor: p1.nextCursor },
    { environment: 'remoto', cursor: 'nao-e-cursor' },
  ]) {
    const r = await c.callTool({ name: 't3_threads', arguments: args });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0].text, /^invalid cursor/);
  }
});

test('limite muda entre páginas sem invalidar o cursor', async () => {
  const c = await conectarMcp(ambientesFalsos(remotoCom(30)));
  const p1 = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', limit: 5 } }));
  const p2 = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', limit: 50, cursor: p1.nextCursor } }));
  assert.equal(p1.returned + p2.returned, 30);
  assert.equal(p2.truncated, false);
});

test('busca avisa quantas threads sem execução ficaram ocultas', async () => {
  const extra = thread({ id: 't-importada', projectId: REMOTO.projeto, title: 'Revisão antiga importada', status: 'idle', latestRunId: null });
  const c = await conectarMcp(ambientesFalsos(remotoCom(3, [extra])));
  const sem = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', search: 'revisão' } }));
  assert.equal(sem.total, 1);
  assert.equal(sem.hiddenNoRun, 1);
  const com = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', search: 'revisão', includeNoRun: true } }));
  assert.equal(com.total, 2);
  assert.equal('hiddenNoRun' in com, false);
});

test('t3_projetos pagina em ordem de título com cursor e sinaliza truncamento', async () => {
  const d = dadosPadrao();
  d.remoto.shell.projects.push(...Array.from({ length: 5 }, (_, i) => ({ id: `mcp-project:issue-${i}`, title: `app.example-issue-${4 - i}`, workspaceRoot: `/h/i${i}` })));
  const base = ambientesFalsos(d);
  const r = base.resolver('remoto');
  for (let i = 0; i < 5; i++) r.escopo.permitidos.add(`mcp-project:issue-${i}`);
  const c = await conectarMcp(base);
  const p1 = dados(await c.callTool({ name: 't3_projetos', arguments: { environment: 'remoto', limit: 4 } }));
  assert.equal(p1.total, 6);
  assert.equal(p1.returned, 4);
  assert.equal(p1.truncated, true);
  const p2 = dados(await c.callTool({ name: 't3_projetos', arguments: { environment: 'remoto', limit: 4, cursor: p1.nextCursor } }));
  assert.equal(p2.truncated, false);
  assert.equal('nextCursor' in p2, false);
  assert.deepEqual([...p1.projects, ...p2.projects].map((p) => p.title),
    ['app', 'app.example-issue-0', 'app.example-issue-1', 'app.example-issue-2', 'app.example-issue-3', 'app.example-issue-4']);
  const sem = dados(await c.callTool({ name: 't3_projetos', arguments: { environment: 'remoto' } }));
  assert.equal(sem.truncated, false);
  assert.equal(sem.returned, 6);
});

test('ponte de escrita expõe os mesmos parâmetros de leitura que a ponte de leitura', async () => {
  const leitura = await conectarMcp(ambientesFalsos());
  const server = criarPonteEscrita({ relay: async () => ({}), aliases: ['local', 'remoto'], approvalOrigin: 'http://localhost:7433' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const escrita = new Client({ name: 't', version: '0' });
  await escrita.connect(a);
  const deLeitura = (await leitura.listTools()).tools;
  const deEscrita = (await escrita.listTools()).tools;
  for (const nome of ['t3_projetos', 't3_threads', 't3_thread', 't3_mensagens', 't3_atencao']) {
    const l = Object.keys(deLeitura.find((t) => t.name === nome).inputSchema.properties ?? {}).filter((k) => k !== 'environment').sort();
    const e = Object.keys(deEscrita.find((t) => t.name === nome).inputSchema.properties ?? {}).filter((k) => k !== 'environment' && k !== 'leaseId').sort();
    assert.deepEqual(e, l, nome);
  }
});

test('leitura sob lease busca e pagina só dentro do grant', async () => {
  const threads = [
    ...Array.from({ length: 4 }, (_, i) => thread({ id: `g-${i}`, projectId: 'one', title: `Conector ${i}`, updatedAt: `2026-10-03T10:0${i}:00.000Z` })),
    thread({ id: 'fora', projectId: 'future', title: 'Conector fora do grant' }),
  ];
  const cliente = { shell: async () => ({ projects: [{ id: 'one', title: 'one' }, { id: 'future', title: 'f' }], threads }), thread: async () => ({ projection: {} }) };
  const ler = (input) => leituraProtegida({ verificar: () => ({ readProjectIds: ['one'] }), cliente, ambiente: { alias: 'remoto', environmentId: 'env-s' }, operation: 't3_threads', input })
    .then((r) => JSON.parse(r.content[0].text));
  const p1 = await ler({ search: 'conector', limit: 3 });
  assert.equal(p1.total, 4);
  assert.equal(p1.truncated, true);
  const p2 = await ler({ search: 'conector', limit: 3, cursor: p1.nextCursor });
  assert.deepEqual([...p1.threads, ...p2.threads].map((t) => t.threadId), ['g-3', 'g-2', 'g-1', 'g-0']);
});
