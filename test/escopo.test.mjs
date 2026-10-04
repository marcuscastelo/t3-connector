import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarEscopo } from '../src/ambientes.mjs';
import { ambientesFalsos, conectarMcp, dados, LOCAL, REMOTO, PROJETO_ALHEIO } from './apoio.mjs';

const FERRAMENTAS = ['t3_aguardar_thread', 't3_ambientes', 't3_atencao', 't3_buscar_threads', 't3_mensagens', 't3_projetos', 't3_thread', 't3_threads'];

test('sem projetos permitidos o ambiente não sobe', () => {
  assert.throws(() => criarEscopo('local', []), /projetosPermitidos/);
});

test('ferramentas expostas são só as de leitura, marcadas readOnly', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), FERRAMENTAS);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false));
});

test('a espera exige environment e timeoutMs com teto de 5 s', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const { tools } = await c.listTools();
  const espera = tools.find((t) => t.name === 't3_aguardar_thread').inputSchema;
  assert.deepEqual(espera.required.sort(), ['environment', 'threadId', 'timeoutMs']);
  assert.equal(espera.properties.timeoutMs.maximum, 5000);
  const r = await c.callTool({ name: 't3_aguardar_thread', arguments: { ambiente: 'remoto', threadId: 't-llm', timeoutMs: 60000 } });
  assert.equal(r.isError, true);
});

test('sem ambiente vale o padrão local, e a resposta diz qual foi', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const p = dados(await c.callTool({ name: 't3_projetos', arguments: {} }));
  assert.deepEqual(p.ambiente, { alias: 'local', environmentId: LOCAL.environmentId });
  assert.deepEqual(p.projetos.map((x) => x.projectId), [LOCAL.projeto]);
  assert.equal(p.projetos[0].threadsPrecisandoIntervencao, 1);
});

test('ambiente explícito remoto lê o projeto e as threads do Remoto', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const p = dados(await c.callTool({ name: 't3_projetos', arguments: { ambiente: 'remoto' } }));
  assert.deepEqual(p.ambiente, { alias: 'remoto', environmentId: REMOTO.environmentId });
  assert.deepEqual(p.projetos.map((x) => x.projectId), [REMOTO.projeto]);
  const t = dados(await c.callTool({ name: 't3_thread', arguments: { ambiente: 'remoto', threadId: 't-llm' } }));
  assert.equal(t.titulo, 'Thread remota');
  assert.equal(t.estado, 'cancelada');
  assert.equal(t.ultimaResposta.texto, 'Resposta no Remoto.');
  assert.deepEqual(t.historico, { completo: false, orcamentoExcedido: true });
  const porId = dados(await c.callTool({ name: 't3_thread', arguments: { ambiente: REMOTO.environmentId, threadId: 't-llm' } }));
  assert.equal(porId.ambiente.alias, 'remoto');
});

test('o mesmo threadId nos dois environments não se mistura', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const pol = dados(await c.callTool({ name: 't3_thread', arguments: { threadId: 't-comum' } }));
  const sir = dados(await c.callTool({ name: 't3_threads', arguments: { ambiente: 'remoto' } }));
  assert.equal(pol.titulo, 'Comum no Local');
  assert.equal(pol.projeto.projectId, LOCAL.projeto);
  assert.equal(sir.threads.find((t) => t.threadId === 't-comum').titulo, 'Comum no Remoto');
});

test('thread do Remoto pedida no Local é recusada sem procurar no Remoto', async () => {
  const chamadas = [];
  const c = await conectarMcp(ambientesFalsos(undefined, { chamadas }));
  const r = await c.callTool({ name: 't3_thread', arguments: { threadId: 't-llm' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /não encontrada nos projetos autorizados do ambiente local/);
  assert.ok(!chamadas.some((x) => x.startsWith('remoto:')), 'não deve consultar outro environment');
});

test('projectId do Local não vale no Remoto', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const r = await c.callTool({ name: 't3_threads', arguments: { ambiente: 'remoto', projectId: LOCAL.projeto } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /fora dos projetos autorizados no ambiente remoto/);
});

test('ambiente inexistente é recusado com a lista dos configurados', async () => {
  const c = await conectarMcp(ambientesFalsos());
  for (const [name, args] of [['t3_projetos', {}], ['t3_aguardar_thread', { threadId: 'x', timeoutMs: 100 }]]) {
    const r = await c.callTool({ name, arguments: { ...args, ambiente: 'inexistente' } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /ambiente "inexistente" não configurado; disponíveis: local, remoto/);
  }
});

test('thread e projeto fora do escopo são recusados sem revelar existência', async () => {
  const chamadas = [];
  const c = await conectarMcp(ambientesFalsos(undefined, { chamadas }));
  const fora = await c.callTool({ name: 't3_thread', arguments: { threadId: 't-alheia' } });
  const inexistente = await c.callTool({ name: 't3_thread', arguments: { threadId: 'nao-existe' } });
  assert.equal(fora.isError, true);
  assert.equal(fora.content[0].text.replace('t-alheia', 'X'), inexistente.content[0].text.replace('nao-existe', 'X'));
  assert.ok(!chamadas.includes('local:thread:t-alheia'), 'não deve ler o snapshot de thread fora do escopo');
  const proj = await c.callTool({ name: 't3_threads', arguments: { projectId: PROJETO_ALHEIO } });
  assert.equal(proj.isError, true);
});

test('t3_thread informa motivo, identificador, detalhe e última resposta', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const d = dados(await c.callTool({ name: 't3_thread', arguments: { threadId: 't-local' } }));
  assert.equal(d.estado, 'precisa_intervencao');
  assert.deepEqual(d.identificador, { runtimeRequestId: 'req-1' });
  assert.equal(d.pedidosPendentes[0].detalhe, 'rm -rf build');
  assert.equal(d.ultimaResposta.texto, 'Vou rodar o build.');
  assert.deepEqual(d.ultimoRun, { runId: 'run-1', ordinal: 1, status: 'waiting' });
});

test('t3_atencao traz intervenções do escopo e ignora falha de outro projeto', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const d = dados(await c.callTool({ name: 't3_atencao', arguments: {} }));
  assert.deepEqual(d.threads.map((t) => t.threadId), ['t-local']);
});

test('t3_ambientes lista os dois, com padrão e transporte, sem tokens', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const r = await c.callTool({ name: 't3_ambientes', arguments: {} });
  const d = dados(r);
  assert.equal(d.padrao, 'local');
  assert.deepEqual(d.ambientes.map((a) => [a.alias, a.padrao, a.transporte, a.disponivel]), [
    ['local', true, 'url', true],
    ['remoto', false, 'ssh remoto', true],
  ]);
  assert.doesNotMatch(r.content[0].text, /token|tokenFile|\/tmp\//i);
});

test('environment que responde com outro environmentId falha fechado', async () => {
  const d = (await import('./apoio.mjs')).dadosPadrao();
  d.remoto.descritor = { ...d.remoto.descritor, environmentId: LOCAL.environmentId };
  const c = await conectarMcp(ambientesFalsos(d));
  const r = await c.callTool({ name: 't3_projetos', arguments: { ambiente: 'remoto' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /esperado env-remoto/);
});

test('token com escrita é recusado no environment', async () => {
  const d = (await import('./apoio.mjs')).dadosPadrao();
  d.remoto.escopos = ['orchestration:read', 'orchestration:operate'];
  const c = await conectarMcp(ambientesFalsos(d));
  const r = await c.callTool({ name: 't3_projetos', arguments: { ambiente: 'remoto' } });
  assert.match(r.content[0].text, /além de leitura \(orchestration:operate\)/);
  const ok = await c.callTool({ name: 't3_projetos', arguments: {} });
  assert.equal(ok.isError, undefined, 'o Local segue funcionando');
});

test('t3_projetos traz total antes da lista e aceita busca e limite', async () => {
  const d = (await import('./apoio.mjs')).dadosPadrao();
  d.remoto.shell.projects.push(...Array.from({ length: 5 }, (_, i) => ({ id: `mcp-project:issue-${i}`, title: `app.example-issue-${i}`, workspaceRoot: `/h/i${i}` })));
  const base = ambientesFalsos(d);
  // ACL do Remoto ampliada só neste teste para incluir os projetos issue.
  const r = base.resolver('remoto');
  for (let i = 0; i < 5; i++) r.escopo.permitidos.add(`mcp-project:issue-${i}`);
  const c = await conectarMcp(base);
  const todos = await c.callTool({ name: 't3_projetos', arguments: { ambiente: 'remoto' } });
  assert.match(todos.content[0].text, /^\{\n "ambiente".*\n "total": 6,/s);
  const busca = dados(await c.callTool({ name: 't3_projetos', arguments: { ambiente: 'remoto', busca: 'APP.EXAMPLE-ISSUE', limite: 2 } }));
  assert.equal(busca.total, 5);
  assert.equal(busca.projetos.length, 2);
});

test('leitura repete uma vez quando o transporte caiu', async () => {
  const { ErroT3 } = await import('../src/t3.mjs');
  const chamadas = [];
  const base = ambientesFalsos(undefined, { chamadas });
  const r = base.resolver('remoto');
  let falhar = true;
  let conexoes = 0;
  const usar = base.usar;
  const res = await usar(r, async (cliente) => { conexoes++; if (falhar) { falhar = false; throw new ErroT3('T3 indisponível', { codigo: 'indisponivel' }); } return 'ok'; });
  assert.equal(res, 'ok');
  assert.equal(conexoes, 2);
  assert.ok(chamadas.includes('remoto:descartar'));
});
