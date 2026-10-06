// Leituras sem `environment` não têm environment padrão (docs/adr/0005): listagens e
// descoberta varrem todos os environments configurados e cada item diz de onde veio; a
// leitura de thread por ID localiza o ID em todos. Nos fixtures, `local` faz o papel do
// Polaris (antigo padrão) e `remoto` o do Sirius.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForaDoEscopo } from '../src/ambientes.mjs';
import { ErroT3 } from '../src/t3.mjs';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao, LOCAL, PROJETO_ALHEIO, REMOTO } from './apoio.mjs';
import { mensagem, projecao, thread } from './fixtures.mjs';

const recusa = (status) => () => Promise.reject(new ErroT3(`T3 respondeu ${status}`, { status }));
const nunca = () => new Promise(() => {});
const pares = (lista, id = 'threadId') => lista.map((x) => `${x.environment.alias}:${x[id]}`);
const ACORDOU = { snoozedAt: '2020-01-01T00:00:00.000Z', snoozedUntil: '2020-01-02T00:00:00.000Z' };

/** Só o remoto tem uma thread woke; o local tem threads comuns (snooze decidível, nenhuma woke). */
function sóRemotoAcordou() {
  const d = dadosPadrao();
  d.remoto.shell.threads.push(thread({ id: 't-acordada', projectId: REMOTO.projeto, title: 'Acordou no Remoto', status: 'completed', latestRunId: 'run-w', ...ACORDOU, updatedAt: '2026-10-05T10:00:00.000Z' }));
  return d;
}

test('regressão: thread woke só no remoto é encontrada sem environment e não aparece pedindo o local', async () => {
  const chamadas = [];
  const c = await conectarMcp(ambientesFalsos(sóRemotoAcordou(), { chamadas }));
  const todas = dados(await c.callTool({ name: 't3_threads', arguments: { woke: true } }));
  assert.equal(todas.isError, undefined);
  assert.equal(todas.complete, true);
  assert.equal(todas.total, 1);
  assert.deepEqual(pares(todas.threads), ['remoto:t-acordada']);
  assert.deepEqual(todas.threads[0].environment, { alias: 'remoto', environmentId: REMOTO.environmentId, name: 'remoto' });
  assert.equal(todas.threads[0].woke, true);
  assert.deepEqual(todas.queriedEnvironments.map((a) => [a.alias, a.found]), [['local', 0], ['remoto', 1]]);
  assert.ok(chamadas.includes('local:shell') && chamadas.includes('remoto:shell'), 'os dois environments foram lidos');

  // O antigo padrão, pedido explicitamente, não a encontra: ela não está lá.
  const local = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'local', woke: true } }));
  assert.equal(local.total, 0);
  assert.deepEqual(local.threads, []);
  assert.deepEqual(local.environment, { alias: 'local', environmentId: LOCAL.environmentId });
  assert.equal(local.complete, true);
});

test('resolver sem chave é erro: nenhum caminho de leitura cai num environment padrão', () => {
  const a = ambientesFalsos();
  assert.throws(() => a.resolver(undefined), ForaDoEscopo);
  assert.throws(() => a.resolver(undefined), /environment is required here.*available: local, remoto/);
  assert.equal(a.resolver('remoto').alias, 'remoto');
});

test('t3_threads sem environment junta os dois por updatedAt, desempata por environment e pagina com cursor amarrado à cobertura', async () => {
  const d = dadosPadrao();
  // Mesmo updatedAt e mesmo ID nos dois environments: a ordem total ainda é estável.
  for (const t of [...d.local.shell.threads, ...d.remoto.shell.threads]) t.updatedAt = '2026-10-03T10:05:00.000Z';
  const c = await conectarMcp(ambientesFalsos(d));
  const tudo = dados(await c.callTool({ name: 't3_threads', arguments: {} }));
  assert.equal(tudo.total, 4);
  assert.deepEqual(pares(tudo.threads), ['local:t-comum', 'local:t-local', 'remoto:t-comum', 'remoto:t-llm']);
  assert.deepEqual(tudo.threads.map((t) => t.title).slice(0, 3), ['Comum no Local', 'Thread de teste', 'Comum no Remoto']);

  const vistos = [];
  let cursor;
  do {
    const p = dados(await c.callTool({ name: 't3_threads', arguments: { limit: 1, ...(cursor ? { cursor } : {}) } }));
    assert.equal(p.total, 4);
    vistos.push(...pares(p.threads));
    cursor = p.nextCursor;
  } while (cursor);
  assert.deepEqual(vistos, pares(tudo.threads));

  // Cursor de uma varredura não vale para um environment só, e vice-versa.
  const p1 = dados(await c.callTool({ name: 't3_threads', arguments: { limit: 1 } }));
  const soLocal = await c.callTool({ name: 't3_threads', arguments: { environment: 'local', limit: 1, cursor: p1.nextCursor } });
  assert.match(soLocal.content[0].text, /^invalid cursor/);
  const l1 = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'local', limit: 1 } }));
  const varrida = await c.callTool({ name: 't3_threads', arguments: { limit: 1, cursor: l1.nextCursor } });
  assert.match(varrida.content[0].text, /^invalid cursor/);

  // Entre páginas o remoto caiu: o cursor deixa de valer dizendo por quê.
  d.remoto.shell = recusa(500);
  const mudou = await c.callTool({ name: 't3_threads', arguments: { limit: 1, cursor: p1.nextCursor } });
  assert.equal(mudou.isError, true);
  assert.match(mudou.content[0].text, /environments that answered changed/);
});

test('falha parcial na varredura: itens dos que responderam, falha sanitizada e complete false; environment explícito segue sendo erro', async () => {
  const d = dadosPadrao();
  d.remoto.shell = recusa(401);
  const c = await conectarMcp(ambientesFalsos(d));
  for (const [name, lista] of [['t3_threads', 'threads'], ['t3_projetos', 'projects'], ['t3_atencao', 'threads']]) {
    const r = await c.callTool({ name, arguments: {} });
    assert.equal(r.isError, undefined, name);
    const x = dados(r);
    assert.equal(x.complete, false, name);
    assert.deepEqual(x.environmentFailures, [{ alias: 'remoto', environmentId: REMOTO.environmentId, code: 'http_401', reason: 'T3 refused the token of this environment' }], name);
    assert.deepEqual(x.queriedEnvironments.map((a) => a.alias), ['local'], name);
    assert.ok(x[lista].every((i) => i.environment.alias === 'local'), name);
    const explicito = await c.callTool({ name, arguments: { environment: 'remoto' } });
    assert.equal(explicito.isError, true, name);
  }
});

test('environment que não responde vira timeout sem segurar a listagem; todos falhando é envelope vazio e incompleto, não erro', async () => {
  const d = dadosPadrao();
  d.remoto.shell = nunca;
  const c = await conectarMcp(ambientesFalsos(d), { prazoAmbienteMs: 50 });
  const inicio = Date.now();
  const x = dados(await c.callTool({ name: 't3_atencao', arguments: {} }));
  assert.ok(Date.now() - inicio < 2000);
  assert.equal(x.complete, false);
  assert.deepEqual(pares(x.threads), ['local:t-local']);
  assert.deepEqual(x.environmentFailures.map((f) => [f.alias, f.code]), [['remoto', 'timeout']]);

  const d2 = dadosPadrao();
  d2.local.shell = recusa(403);
  d2.remoto.shell = recusa(500);
  const c2 = await conectarMcp(ambientesFalsos(d2));
  const r = await c2.callTool({ name: 't3_projetos', arguments: {} });
  assert.equal(r.isError, undefined);
  const vazio = dados(r);
  assert.equal(vazio.total, 0);
  assert.equal(vazio.complete, false);
  assert.deepEqual(vazio.queriedEnvironments, []);
  assert.deepEqual(vazio.environmentFailures.map((f) => f.code), ['http_403', 'http_500']);
});

test('t3_projetos sem environment ordena por título e desempata por environment; a busca vale nos dois', async () => {
  const d = dadosPadrao();
  d.remoto.shell.projects.push({ id: 'mcp-project:fleet', title: 'fleet', workspaceRoot: '/home/dev/fleet' });
  const base = ambientesFalsos(d);
  base.resolver('remoto').escopo.permitidos.add('mcp-project:fleet');
  const c = await conectarMcp(base);
  const p = dados(await c.callTool({ name: 't3_projetos', arguments: {} }));
  // Os dois "app" vêm juntos (local antes de remoto por environmentId), depois "fleet".
  assert.deepEqual(pares(p.projects, 'projectId'), [`local:${LOCAL.projeto}`, `remoto:${REMOTO.projeto}`, 'remoto:mcp-project:fleet']);
  assert.deepEqual(p.queriedEnvironments.map((a) => [a.alias, a.found]), [['local', 1], ['remoto', 2]]);
  const busca = dados(await c.callTool({ name: 't3_projetos', arguments: { search: 'FLEET' } }));
  assert.equal(busca.total, 1);
  assert.deepEqual(pares(busca.projects, 'projectId'), ['remoto:mcp-project:fleet']);
  assert.deepEqual(busca.queriedEnvironments.map((a) => a.found), [0, 1]);
});

test('t3_atencao sem environment traz intervenções e falhas não resolvidas dos dois, cada uma com o seu environment', async () => {
  const d = dadosPadrao();
  d.remoto.shell.threads.push(thread({ id: 't-falhou', projectId: REMOTO.projeto, title: 'Falhou no Remoto', status: 'failed', latestRunId: 'run-f' }));
  const c = await conectarMcp(ambientesFalsos(d));
  const x = dados(await c.callTool({ name: 't3_atencao', arguments: {} }));
  assert.equal(x.total, 2);
  assert.deepEqual(pares(x.threads), ['local:t-local', 'remoto:t-falhou']);
  assert.deepEqual(x.threads.map((t) => t.state), ['needs_intervention', 'failed']);
  // Falha de projeto alheio continua fora, nos dois.
  assert.ok(!x.threads.some((t) => t.threadId === 't-alheia'));
});

test('projectId sem environment: só o environment que autoriza o projeto contribui; projeto de nenhum é recusado', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const x = dados(await c.callTool({ name: 't3_threads', arguments: { projectId: REMOTO.projeto, includeNoRun: true } }));
  assert.equal(x.complete, true);
  assert.deepEqual(pares(x.threads), ['remoto:t-comum', 'remoto:t-llm']);
  assert.deepEqual(x.queriedEnvironments.map((a) => [a.alias, a.found]), [['local', 0], ['remoto', 2]]);
  const nenhum = await c.callTool({ name: 't3_threads', arguments: { projectId: PROJETO_ALHEIO } });
  assert.equal(nenhum.isError, true);
  assert.match(nenhum.content[0].text, /project proj-alheio is not among the authorized projects of any environment that answered \(env-local, env-remoto\)/);
  // Com environment explícito, a recusa é a de sempre.
  const explicito = await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', projectId: LOCAL.projeto } });
  assert.match(explicito.content[0].text, /is not among the authorized projects of environment remoto/);
});

test('filtro woke indecidível num environment vira recusa daquele environment, não uma lista que parece completa', async () => {
  const d = sóRemotoAcordou();
  // Servidor do local anterior ao snooze: não dá para decidir o marcador lá.
  for (const t of d.local.shell.threads) { delete t.snoozedUntil; delete t.snoozedAt; }
  const c = await conectarMcp(ambientesFalsos(d));
  const x = dados(await c.callTool({ name: 't3_threads', arguments: { woke: true } }));
  assert.equal(x.complete, false);
  assert.deepEqual(pares(x.threads), ['remoto:t-acordada']);
  assert.equal(x.environmentFailures.length, 1);
  assert.equal(x.environmentFailures[0].alias, 'local');
  assert.equal(x.environmentFailures[0].code, 'refused');
  assert.match(x.environmentFailures[0].reason, /woke filter is unavailable/);
  // Sem o filtro, o local responde normalmente (woke null).
  const sem = dados(await c.callTool({ name: 't3_threads', arguments: {} }));
  assert.equal(sem.complete, true);
  assert.equal(sem.threads.find((t) => t.environment.alias === 'local').woke, null);
});

test('t3_thread e t3_mensagens sem environment localizam a thread onde ela existe e dizem o que foi varrido', async () => {
  const chamadas = [];
  const c = await conectarMcp(ambientesFalsos(undefined, { chamadas }));
  const t = dados(await c.callTool({ name: 't3_thread', arguments: { threadId: 't-llm' } }));
  assert.deepEqual(t.environment, { alias: 'remoto', environmentId: REMOTO.environmentId });
  assert.equal(t.title, 'Thread remota');
  assert.equal(t.latestResponse.text, 'Resposta no Remoto.');
  assert.deepEqual(t.environmentDiscovery, {
    complete: true,
    queriedEnvironments: [{ alias: 'local', environmentId: LOCAL.environmentId, name: 'local', found: 0 }, { alias: 'remoto', environmentId: REMOTO.environmentId, name: 'remoto', found: 1 }],
    environmentFailures: [],
  });
  // Só a shell de cada environment, e o /bounded apenas onde ela vive.
  assert.ok(!chamadas.includes('local:thread:t-llm'));
  assert.ok(chamadas.includes('remoto:thread:t-llm'));

  const m = dados(await c.callTool({ name: 't3_mensagens', arguments: { threadId: 't-llm', limit: 1 } }));
  assert.equal(m.environment.alias, 'remoto');
  assert.equal(m.messages[0].text, 'Resposta no Remoto.');

  // Com environment explícito, nada de descoberta na resposta.
  const direto = dados(await c.callTool({ name: 't3_thread', arguments: { environment: 'remoto', threadId: 't-llm' } }));
  assert.equal('environmentDiscovery' in direto, false);
});

test('thread por ID em nenhum environment: recusa que distingue "não achou" de "alguém não respondeu"', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const nada = await c.callTool({ name: 't3_thread', arguments: { threadId: 'nao-existe' } });
  assert.equal(nada.isError, true);
  assert.match(nada.content[0].text, /not found in the authorized projects of any environment \(environments queried: local, remoto\)$/);

  const d = dadosPadrao();
  d.remoto.shell = recusa(401);
  const c2 = await conectarMcp(ambientesFalsos(d));
  const talvez = await c2.callTool({ name: 't3_thread', arguments: { threadId: 't-llm' } });
  assert.equal(talvez.isError, true);
  assert.match(talvez.content[0].text, /environments queried: local; environments that did not answer: remoto \(http_401\); the thread may live in one of them/);
  // Achada no que respondeu, com a varredura incompleta registrada.
  const achada = dados(await c2.callTool({ name: 't3_thread', arguments: { threadId: 't-local' } }));
  assert.equal(achada.environment.alias, 'local');
  assert.equal(achada.environmentDiscovery.complete, false);
  assert.equal(achada.environmentDiscovery.environmentFailures[0].code, 'http_401');
});

test('thread arquivada conta na localização por ID, como em exigirThread', async () => {
  const d = dadosPadrao();
  d.remoto.shell.threads.push(thread({ id: 't-arq', projectId: REMOTO.projeto, title: 'Arquivada', archivedAt: '2026-10-03T11:00:00.000Z' }));
  d.remoto.bounded['t-arq'] = { projection: projecao({ mensagens: [mensagem({ text: 'antiga' })], runs: [] }), hasMoreHistory: false };
  const c = await conectarMcp(ambientesFalsos(d));
  const t = dados(await c.callTool({ name: 't3_thread', arguments: { threadId: 't-arq' } }));
  assert.equal(t.environment.alias, 'remoto');
  assert.equal(t.title, 'Arquivada');
});

test('descrições: nenhuma ferramenta promete environment padrão; as de listagem declaram o contrato de escopo', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const { tools } = await c.listTools();
  for (const t of tools) {
    assert.doesNotMatch(t.description, /[Dd]efault when omitted/, t.name);
    const env = t.inputSchema.properties?.environment;
    if (env) assert.doesNotMatch(env.description, /[Dd]efault/, t.name);
  }
  for (const nome of ['t3_threads', 't3_projetos', 't3_atencao', 't3_providers']) {
    assert.match(tools.find((t) => t.name === nome).description, /Scope contract: without `environment` every configured environment is queried/, nome);
  }
  for (const nome of ['t3_thread', 't3_mensagens']) {
    assert.match(tools.find((t) => t.name === nome).inputSchema.properties.environment.description, /located across every configured environment/, nome);
  }
  assert.deepEqual(tools.find((t) => t.name === 't3_aguardar_thread').inputSchema.required.sort(), ['environment', 'threadId', 'timeoutMs']);
});
