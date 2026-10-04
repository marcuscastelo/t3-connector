// Parâmetros em inglês com os nomes antigos aceitos como aliases ocultos (docs/adr/0004).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { criarPonteEscrita } from '../src/escrita/ponte-mcp.mjs';
import { validarConfig } from '../src/config.mjs';
import { validarConfigEscrita } from '../src/escrita/config.mjs';
import { ambientesFalsos, conectarMcp, dados } from './apoio.mjs';

const LEGADOS = ['ambiente', 'busca', 'limite', 'estado', 'incluirSemExecucao', 'correspondencia', 'maxCaracteres', 'incluirUltimaResposta', 'verificar'];

async function ponte(relay) {
  const server = criarPonteEscrita({ relay, aliases: ['local', 'remoto'], approvalOrigin: 'http://localhost:7433' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const c = new Client({ name: 't', version: '0' });
  await c.connect(a);
  return c;
}

test('tools/list anuncia só os nomes em inglês, na leitura e na escrita', async () => {
  const leitura = await conectarMcp(ambientesFalsos());
  const escrita = await ponte(async () => ({}));
  for (const { tools } of [await leitura.listTools(), await escrita.listTools()]) {
    for (const t of tools) {
      const nomes = [...Object.keys(t.inputSchema.properties ?? {}), ...(t.inputSchema.required ?? [])];
      assert.deepEqual(nomes.filter((n) => LEGADOS.includes(n)), [], t.name);
    }
  }
});

test('leitura: chamada com os nomes antigos dá o mesmo resultado que com os novos', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const casos = [
    ['t3_threads', { ambiente: 'remoto', limite: 1, busca: 'comum', estado: 'rodando' }, { environment: 'remoto', limit: 1, search: 'comum', state: 'running' }],
    ['t3_threads', { incluirSemExecucao: true }, { includeNoRun: true }],
    ['t3_projetos', { ambiente: 'remoto', busca: 'app', limite: 1 }, { environment: 'remoto', search: 'app', limit: 1 }],
    ['t3_buscar_threads', { busca: 'Comum no Local', correspondencia: 'exata' }, { search: 'Comum no Local', match: 'exact' }],
    ['t3_thread', { ambiente: 'remoto', threadId: 't-llm', maxCaracteres: 200 }, { environment: 'remoto', threadId: 't-llm', maxCharacters: 200 }],
    ['t3_mensagens', { ambiente: 'remoto', threadId: 't-llm', limite: 1, maxCaracteres: 100 }, { environment: 'remoto', threadId: 't-llm', limit: 1, maxCharacters: 100 }],
    ['t3_ambientes', { verificar: false }, { check: false }],
  ];
  for (const [name, antigo, novo] of casos) {
    const a = await c.callTool({ name, arguments: antigo });
    const b = await c.callTool({ name, arguments: novo });
    assert.equal(a.isError, undefined, `${name}: ${a.content[0].text}`);
    assert.deepEqual(dados(a), dados(b), name);
  }
  // O alias não é ignorado: o resultado muda de fato com ele.
  const remoto = dados(await c.callTool({ name: 't3_atencao', arguments: { ambiente: 'remoto' } }));
  assert.equal(remoto.ambiente.alias, 'remoto');
});

test('leitura: nome antigo e novo com valores diferentes falham; iguais passam', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const conflito = await c.callTool({ name: 't3_projetos', arguments: { ambiente: 'remoto', environment: 'local' } });
  assert.equal(conflito.isError, true);
  assert.match(conflito.content[0].text, /`environment` and its deprecated alias `ambiente` have different values/);
  const estado = await c.callTool({ name: 't3_threads', arguments: { estado: 'concluida', state: 'running' } });
  assert.equal(estado.isError, true);
  const iguais = await c.callTool({ name: 't3_threads', arguments: { ambiente: 'remoto', environment: 'remoto', estado: 'rodando', state: 'running' } });
  assert.equal(iguais.isError, undefined);
  assert.equal(dados(iguais).ambiente.alias, 'remoto');
});

test('leitura: valores antigos só no nome antigo, e o valor do alias é validado', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const portuguesNoNovo = await c.callTool({ name: 't3_threads', arguments: { state: 'rodando' } });
  assert.equal(portuguesNoNovo.isError, true);
  const inglesNoAntigo = await c.callTool({ name: 't3_threads', arguments: { estado: 'running' } });
  assert.equal(inglesNoAntigo.isError, true);
  assert.match(inglesNoAntigo.content[0].text, /invalid `estado` \(deprecated alias of `state`\)/);
  const limite = await c.callTool({ name: 't3_threads', arguments: { limite: 51 } });
  assert.equal(limite.isError, true);
  assert.match(limite.content[0].text, /invalid `limite`/);
  const espera = await c.callTool({ name: 't3_aguardar_thread', arguments: { threadId: 't-llm', timeoutMs: 100 } });
  assert.equal(espera.isError, true);
  assert.match(espera.content[0].text, /`environment` is required/);
});

test('leitura: cursor de uma chamada antiga continua na chamada nova', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const p1 = dados(await c.callTool({ name: 't3_buscar_threads', arguments: { busca: 'comum', limite: 1 } }));
  assert.ok(p1.proximoCursor);
  const p2 = await c.callTool({ name: 't3_buscar_threads', arguments: { search: 'comum', limit: 1, cursor: p1.proximoCursor } });
  assert.equal(p2.isError, undefined, p2.content[0].text);
  assert.notEqual(dados(p2).threads[0].ambiente.environmentId, p1.threads[0].ambiente.environmentId);
});

test('escrita: ambiente antigo vai ao relay igual ao novo; conflito e ausência não chegam ao relay', async () => {
  const pedidos = [];
  const c = await ponte(async (req) => { pedidos.push(req); return { ambiente: { alias: req.ambiente }, state: 'completed' }; });
  const base = { leaseId: 'l', operationId: 'op', input: { threadId: 't' } };
  await c.callTool({ name: 't3_escrever_thread_pin', arguments: { ...base, ambiente: 'remoto' } });
  await c.callTool({ name: 't3_escrever_thread_pin', arguments: { ...base, environment: 'remoto' } });
  assert.deepEqual(pedidos[0], pedidos[1]);
  assert.deepEqual(pedidos[0], { op: 'dispatch', action: 'thread.pin', leaseId: 'l', ambiente: 'remoto', operationId: 'op', input: { threadId: 't' } });
  const conflito = await c.callTool({ name: 't3_escrever_thread_pin', arguments: { ...base, ambiente: 'remoto', environment: 'local' } });
  assert.equal(conflito.isError, true);
  assert.match(conflito.content[0].text, /^parameter_conflict: /);
  const sem = await c.callTool({ name: 't3_escrever_thread_pin', arguments: base });
  assert.equal(sem.isError, true);
  assert.match(sem.content[0].text, /^ambiente_obrigatorio: pass `environment`/);
  const reconcile = await c.callTool({ name: 't3_reconciliar_escrita', arguments: { leaseId: 'l', operationId: 'op', ambiente: 'local', environment: 'remoto' } });
  assert.equal(reconcile.isError, true);
  assert.equal(pedidos.length, 2);
});

test('escrita: leitura sob lease manda ao relay os nomes antigos, venha a chamada como vier', async () => {
  const pedidos = [];
  const c = await ponte(async (req) => { pedidos.push(req); return { content: [{ type: 'text', text: '{}' }] }; });
  await c.callTool({ name: 't3_threads', arguments: { leaseId: 'l', environment: 'local', state: 'needs_intervention', includeNoRun: true, search: 'x', limit: 2 } });
  await c.callTool({ name: 't3_threads', arguments: { leaseId: 'l', ambiente: 'local', estado: 'precisa_intervencao', incluirSemExecucao: true, busca: 'x', limite: 2 } });
  assert.deepEqual(pedidos[0], pedidos[1]);
  assert.deepEqual(pedidos[0].input, { estado: 'precisa_intervencao', incluirSemExecucao: true, busca: 'x', limite: 2 });
  await c.callTool({ name: 't3_mensagens', arguments: { leaseId: 'l', environment: 'local', threadId: 't', maxCharacters: 100 } });
  assert.deepEqual(pedidos[2].input, { threadId: 't', maxCaracteres: 100 });
});

test('config de leitura: nomes em inglês, antigos ou os dois iguais dão a mesma config; diferentes falham', () => {
  const ambiente = { environmentId: 'e1', ssh: { host: 'remoto', remotePort: 4000 }, tokenFile: '/t', allowedProjects: ['p'] };
  const ingles = validarConfig({ default: 'local', environments: { local: ambiente } });
  const antigo = validarConfig({ padrao: 'local', ambientes: { local: { environmentId: 'e1', ssh: { host: 'remoto', portaRemota: 4000 }, tokenFile: '/t', projetosPermitidos: ['p'] } } });
  assert.deepEqual(ingles, antigo);
  assert.equal(ingles.ambientes[0].ssh.portaRemota, 4000);
  assert.deepEqual(validarConfig({ default: 'local', padrao: 'local', environments: { local: ambiente } }), ingles);
  assert.throws(() => validarConfig({ environments: { local: { ...ambiente, projetosPermitidos: ['outro'] } } }), /"allowedProjects" e o nome antigo "projetosPermitidos"/);
  assert.throws(() => validarConfig({ environments: { local: ambiente }, ambientes: {} }), /"environments" e o nome antigo "ambientes"/);
});

test('config de escrita: nomes em inglês aceitos; allowlists continuam recusadas em qualquer idioma', () => {
  const ambiente = { environmentId: 'env-s', ssh: { host: 'remoto' }, tokenFile: '/t' };
  const ingles = validarConfigEscrita({ port: 7433, stateDir: '/x', channel: { organization: 'o', tunnelId: 'tunnel_abc' }, environments: { remoto: ambiente } });
  const antigo = validarConfigEscrita({ porta: 7433, estado: '/x', canal: { organization: 'o', tunnelId: 'tunnel_abc' }, ambientes: { remoto: ambiente } });
  assert.deepEqual(ingles, antigo);
  assert.throws(() => validarConfigEscrita({ port: 7433, porta: 7434, stateDir: '/x', channel: { organization: 'o', tunnelId: 'tunnel_abc' }, environments: { remoto: ambiente } }), /"port" e o nome antigo "porta"/);
  for (const campo of ['allowedProjects', 'projects', 'actions']) {
    assert.throws(() => validarConfigEscrita({ port: 7433, stateDir: '/x', channel: { organization: 'o', tunnelId: 'tunnel_abc' }, environments: { remoto: { ...ambiente, [campo]: ['x'] } } }), /não é suportado/);
  }
});
