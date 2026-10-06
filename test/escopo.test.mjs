import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarEscopo } from '../src/ambientes.mjs';
import { ambientesFalsos, conectarMcp, dados, LOCAL, REMOTO, PROJETO_ALHEIO } from './apoio.mjs';

const FERRAMENTAS = ['t3_aguardar_thread', 't3_ambientes', 't3_atencao', 't3_buscar_threads', 't3_mensagens', 't3_projetos', 't3_providers', 't3_thread', 't3_threads', 't3_workset'];

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
  const r = await c.callTool({ name: 't3_aguardar_thread', arguments: { environment: 'remoto', threadId: 't-llm', timeoutMs: 60000 } });
  assert.equal(r.isError, true);
});

test('sem ambiente vale o padrão local, e a resposta diz qual foi', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const p = dados(await c.callTool({ name: 't3_projetos', arguments: {} }));
  assert.deepEqual(p.environment, { alias: 'local', environmentId: LOCAL.environmentId });
  assert.deepEqual(p.projects.map((x) => x.projectId), [LOCAL.projeto]);
  assert.equal(p.projects[0].threadsNeedingIntervention, 1);
});

test('ambiente explícito remoto lê o projeto e as threads do Remoto', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const p = dados(await c.callTool({ name: 't3_projetos', arguments: { environment: 'remoto' } }));
  assert.deepEqual(p.environment, { alias: 'remoto', environmentId: REMOTO.environmentId });
  assert.deepEqual(p.projects.map((x) => x.projectId), [REMOTO.projeto]);
  const t = dados(await c.callTool({ name: 't3_thread', arguments: { environment: 'remoto', threadId: 't-llm' } }));
  assert.equal(t.title, 'Thread remota');
  assert.equal(t.state, 'cancelled');
  assert.equal(t.latestResponse.text, 'Resposta no Remoto.');
  assert.deepEqual(t.history, { complete: false, payloadBudgetExceeded: true });
  const porId = dados(await c.callTool({ name: 't3_thread', arguments: { environment: REMOTO.environmentId, threadId: 't-llm' } }));
  assert.equal(porId.environment.alias, 'remoto');
});

test('o mesmo threadId nos dois environments não se mistura', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const pol = dados(await c.callTool({ name: 't3_thread', arguments: { threadId: 't-comum' } }));
  const sir = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto' } }));
  assert.equal(pol.title, 'Comum no Local');
  assert.equal(pol.project.projectId, LOCAL.projeto);
  assert.equal(sir.threads.find((t) => t.threadId === 't-comum').title, 'Comum no Remoto');
});

test('thread do Remoto pedida no Local é recusada sem procurar no Remoto', async () => {
  const chamadas = [];
  const c = await conectarMcp(ambientesFalsos(undefined, { chamadas }));
  const r = await c.callTool({ name: 't3_thread', arguments: { threadId: 't-llm' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not found in the authorized projects of environment local/);
  assert.ok(!chamadas.some((x) => x.startsWith('remoto:')), 'não deve consultar outro environment');
});

test('projectId do Local não vale no Remoto', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const r = await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', projectId: LOCAL.projeto } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /is not among the authorized projects of environment remoto/);
});

test('ambiente inexistente é recusado com a lista dos configurados', async () => {
  const c = await conectarMcp(ambientesFalsos());
  for (const [name, args] of [['t3_projetos', {}], ['t3_aguardar_thread', { threadId: 'x', timeoutMs: 100 }]]) {
    const r = await c.callTool({ name, arguments: { ...args, environment: 'inexistente' } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /environment "inexistente" is not configured; available: local, remoto/);
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
  assert.equal(d.state, 'needs_intervention');
  assert.deepEqual(d.identifier, { runtimeRequestId: 'req-1' });
  assert.equal(d.pendingRequests[0].detail, 'rm -rf build');
  assert.equal(d.latestResponse.text, 'Vou rodar o build.');
  assert.deepEqual(d.latestRun, { runId: 'run-1', ordinal: 1, status: 'waiting' });
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
  assert.equal(d.default, 'local');
  assert.deepEqual(d.environments.map((a) => [a.alias, a.default, a.transport, a.available]), [
    ['local', true, 'url', true],
    ['remoto', false, 'ssh remoto', true],
  ]);
  assert.doesNotMatch(r.content[0].text, /token|tokenFile|\/tmp\//i);
});

test('environment que responde com outro environmentId falha fechado', async () => {
  const d = (await import('./apoio.mjs')).dadosPadrao();
  d.remoto.descritor = { ...d.remoto.descritor, environmentId: LOCAL.environmentId };
  const c = await conectarMcp(ambientesFalsos(d));
  const r = await c.callTool({ name: 't3_projetos', arguments: { environment: 'remoto' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /expected env-remoto/);
});

test('token com escrita é recusado no environment', async () => {
  const d = (await import('./apoio.mjs')).dadosPadrao();
  d.remoto.escopos = ['orchestration:read', 'orchestration:operate'];
  const c = await conectarMcp(ambientesFalsos(d));
  const r = await c.callTool({ name: 't3_projetos', arguments: { environment: 'remoto' } });
  assert.match(r.content[0].text, /beyond read \(orchestration:operate\)/);
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
  const todos = await c.callTool({ name: 't3_projetos', arguments: { environment: 'remoto' } });
  assert.match(todos.content[0].text, /^\{\n "environment".*\n "total": 6,/s);
  const busca = dados(await c.callTool({ name: 't3_projetos', arguments: { environment: 'remoto', search: 'APP.EXAMPLE-ISSUE', limit: 2 } }));
  assert.equal(busca.total, 5);
  assert.equal(busca.projects.length, 2);
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
