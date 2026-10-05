// Contrato só em inglês (docs/adr/0004): os nomes antigos não são aceitos e também não
// são descartados em silêncio; a chamada falha antes de consultar o T3 ou o relay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { criarPonteEscrita } from '../src/escrita/ponte-mcp.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { carregarConfig, validarConfig } from '../src/config.mjs';
import { validarConfigEscrita } from '../src/escrita/config.mjs';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao, REMOTO } from './apoio.mjs';
import { thread } from './fixtures.mjs';

const LEGADOS = ['ambiente', 'busca', 'limite', 'estado', 'incluirSemExecucao', 'correspondencia', 'maxCaracteres', 'incluirUltimaResposta', 'verificar'];

async function ponte(relay) {
  const server = criarPonteEscrita({ relay, aliases: ['local', 'remoto'], approvalOrigin: 'http://localhost:7433' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const c = new Client({ name: 't', version: '0' });
  await c.connect(a);
  return c;
}

test('tools/list: só nomes em inglês e nenhum parâmetro extra aceito, na leitura e na escrita', async () => {
  const leitura = await conectarMcp(ambientesFalsos());
  const escrita = await ponte(async () => ({}));
  for (const { tools } of [await leitura.listTools(), await escrita.listTools()]) {
    for (const t of tools) {
      assert.deepEqual(Object.keys(t.inputSchema.properties ?? {}).filter((n) => LEGADOS.includes(n)), [], t.name);
      assert.equal(t.inputSchema.additionalProperties, false, t.name);
    }
  }
});

test('leitura: nome antigo é recusado, sem cair no environment padrão nem consultar o T3', async () => {
  const chamadas = [];
  const c = await conectarMcp(ambientesFalsos(dadosPadrao(), { chamadas }));
  const casos = [
    ['t3_projetos', { ambiente: 'remoto' }],
    ['t3_threads', { busca: 'comum' }],
    ['t3_threads', { limite: 1 }],
    ['t3_threads', { estado: 'rodando' }],
    ['t3_threads', { incluirSemExecucao: true }],
    ['t3_buscar_threads', { search: 'comum', correspondencia: 'exata' }],
    ['t3_thread', { environment: 'remoto', threadId: 't-llm', maxCaracteres: 200 }],
    ['t3_aguardar_thread', { environment: 'remoto', threadId: 't-llm', timeoutMs: 100, incluirUltimaResposta: true }],
    ['t3_ambientes', { verificar: false }],
  ];
  for (const [name, args] of casos) {
    const r = await c.callTool({ name, arguments: args });
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, /-32602.*Unrecognized key/s, name);
  }
  assert.deepEqual(chamadas, []);
  // Valor antigo no nome novo também é recusado.
  const valor = await c.callTool({ name: 't3_threads', arguments: { state: 'rodando' } });
  assert.equal(valor.isError, true);
  const correspondencia = await c.callTool({ name: 't3_buscar_threads', arguments: { search: 'x', match: 'exata' } });
  assert.equal(correspondencia.isError, true);
});

test('leitura: cursor de t3_threads filtrado por estado continua na página seguinte', async () => {
  const d = dadosPadrao();
  d.remoto.shell.threads.push(thread({ id: 't-run2', projectId: REMOTO.projeto, title: 'Outra rodando', status: 'running', latestRunId: 'run-s9' }));
  const c = await conectarMcp(ambientesFalsos(d));
  const p1 = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', state: 'running', limit: 1 } }));
  assert.equal(p1.total, 2);
  const p2 = dados(await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', state: 'running', limit: 1, cursor: p1.nextCursor } }));
  assert.notEqual(p2.threads[0].threadId, p1.threads[0].threadId);
  const outro = await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', state: 'failed', limit: 1, cursor: p1.nextCursor } });
  assert.match(outro.content[0].text, /^invalid cursor/);
  // Cursor do formato anterior (v1), mesma consulta e mesma chave: recusado.
  const v1 = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p1.nextCursor, 'base64url').toString()), v: 1 })).toString('base64url');
  const antigo = await c.callTool({ name: 't3_threads', arguments: { environment: 'remoto', state: 'running', limit: 1, cursor: v1 } });
  assert.match(antigo.content[0].text, /^invalid cursor/);
});

test('busca: cursor v1 da mesma busca é cursor inválido, não mudança de cobertura', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const p1 = dados(await c.callTool({ name: 't3_buscar_threads', arguments: { threadId: 't-comum', limit: 1 } }));
  const v1 = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p1.nextCursor, 'base64url').toString()), v: 1 })).toString('base64url');
  const r = await c.callTool({ name: 't3_buscar_threads', arguments: { threadId: 't-comum', limit: 1, cursor: v1 } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^invalid cursor/);
});

test('escrita: `ambiente` ou falta de environment não chegam ao relay; leitura sob lease vai em inglês', async () => {
  const pedidos = [];
  const c = await ponte(async (req) => { pedidos.push(req); return req.op === 'read' ? { content: [{ type: 'text', text: '{}' }] } : { ambiente: { alias: req.ambiente }, state: 'completed' }; });
  const base = { leaseId: 'l', operationId: 'op', input: { threadId: 't' } };
  for (const args of [{ ...base, ambiente: 'remoto' }, base, { ...base, environment: 'remoto', ambiente: 'remoto' }]) {
    const r = await c.callTool({ name: 't3_escrever_thread_pin', arguments: args });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /-32602/);
  }
  const reconcile = await c.callTool({ name: 't3_reconciliar_escrita', arguments: { leaseId: 'l', operationId: 'op', ambiente: 'local' } });
  assert.equal(reconcile.isError, true);
  assert.equal(pedidos.length, 0);
  await c.callTool({ name: 't3_escrever_thread_pin', arguments: { ...base, environment: 'remoto' } });
  assert.deepEqual(pedidos[0], { op: 'dispatch', action: 'thread.pin', leaseId: 'l', ambiente: 'remoto', operationId: 'op', input: { threadId: 't' } });
  await c.callTool({ name: 't3_threads', arguments: { leaseId: 'l', environment: 'local', state: 'needs_intervention', includeNoRun: true, search: 'x', limit: 2 } });
  assert.deepEqual(pedidos[1].input, { state: 'needs_intervention', includeNoRun: true, search: 'x', limit: 2 });
  const antigo = await c.callTool({ name: 't3_threads', arguments: { leaseId: 'l', environment: 'local', estado: 'rodando' } });
  assert.equal(antigo.isError, true);
  assert.equal(pedidos.length, 2);
});

test('escrita: pedido de aprovação não aceita parâmetro nenhum e não chama o relay com um', async () => {
  const pedidos = [];
  const c = await ponte(async (req) => { pedidos.push(req); return { active: true, leaseId: 'L', ambientes: [] }; });
  for (const args of [{ ambiente: 'remoto' }, { environment: 'remoto' }, { qualquer: 1 }]) {
    const r = await c.callTool({ name: 't3_pedir_aprovacao', arguments: args });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /-32602.*Unrecognized key/s);
  }
  assert.equal(pedidos.length, 0);
  const ok = await c.callTool({ name: 't3_pedir_aprovacao', arguments: {} });
  assert.equal(ok.isError, undefined);
  assert.equal(pedidos.length, 1);
});

test('escrita: respostas e códigos do gate saem com os nomes em inglês', async () => {
  let resposta = { ambiente: { alias: 'remoto', environmentId: 'env-s' }, state: 'completed', operationId: 'op', receipt: { sequence: 1 } };
  const c = await ponte(async (req) => {
    if (req.op === 'request') return resposta;
    if (req.leaseId === 'velha') throw new Error('ambiente_fora_da_lease');
    return resposta;
  });
  const base = { leaseId: 'l', operationId: 'op', environment: 'remoto' };
  const escrita = JSON.parse((await c.callTool({ name: 't3_escrever_thread_pin', arguments: { ...base, input: { threadId: 't' } } })).content[0].text);
  assert.deepEqual(escrita, { environment: { alias: 'remoto', environmentId: 'env-s' }, state: 'completed', operationId: 'op', receipt: { sequence: 1 } });
  const reconcile = JSON.parse((await c.callTool({ name: 't3_reconciliar_escrita', arguments: base })).content[0].text);
  assert.equal(reconcile.environment.alias, 'remoto');
  assert.equal('ambiente' in reconcile, false);
  const fora = await c.callTool({ name: 't3_escrever_thread_pin', arguments: { ...base, leaseId: 'velha', input: { threadId: 't' } } });
  assert.match(fora.content[0].text, /^environment_not_in_lease: /);
  resposta = { active: true, leaseId: 'L', expiresAt: 1, remainingMs: 2, scopeHash: 'h', ambientes: [{ alias: 'local', environmentId: 'p', projetos: 3, acoes: 42 }] };
  const ativa = JSON.parse((await c.callTool({ name: 't3_pedir_aprovacao', arguments: {} })).content[0].text);
  assert.deepEqual(ativa, { authorized: true, active: true, leaseId: 'L', expiresAt: 1, remainingMs: 2, scopeHash: 'h',
    environments: [{ alias: 'local', environmentId: 'p', projectCount: 3, actionCount: 42 }], channelIdentity: true, individualIdentity: false });
});

test('config de leitura: só chaves em inglês; chave antiga é recusada com o nome novo', () => {
  const ambiente = { environmentId: 'e1', ssh: { host: 'remoto', remotePort: 4000 }, tokenFile: '/t', allowedProjects: ['p'] };
  const c = validarConfig({ default: 'local', environments: { local: ambiente } });
  assert.equal(c.padrao, 'local');
  assert.equal(c.ambientes[0].ssh.portaRemota, 4000);
  assert.deepEqual(c.ambientes[0].projetosPermitidos, ['p']);
  const casos = [
    [{ padrao: 'local', environments: { local: ambiente } }, /"padrao" foi renomeado para "default"/],
    [{ ambientes: { local: ambiente } }, /"ambientes" foi renomeado para "environments"/],
    [{ environments: { local: { ...ambiente, projetosPermitidos: ['p'] } } }, /local: "projetosPermitidos" foi renomeado para "allowedProjects"/],
    [{ environments: { local: { ...ambiente, ssh: { host: 'remoto', portaRemota: 4000 } } } }, /local: ssh\."portaRemota" foi renomeado para "remotePort"/],
  ];
  for (const [bruta, erro] of casos) assert.throws(() => validarConfig(bruta), erro);
});

test('config de leitura: o exemplo publicado e um arquivo no formato instalado carregam sem tradução', async () => {
  const exemplo = await carregarConfig(fileURLToPath(new URL('../examples/config.json', import.meta.url)));
  assert.deepEqual(exemplo.ambientes.map((a) => a.alias), ['local', 'remoto']);
  assert.equal(exemplo.ambientes[1].ssh.portaRemota, 3773);
  // Aliases quaisquer, como numa máquina real; nenhum nome de environment é especial.
  const dir = await mkdtemp(path.join(tmpdir(), 't3-connector-config-'));
  try {
    const arquivo = path.join(dir, 'config.json');
    await writeFile(arquivo, JSON.stringify({
      default: 'mesa',
      environments: {
        mesa: { environmentId: 'env-mesa', url: 'http://127.0.0.1:3773', tokenFile: '~/.config/t3-connector/tokens/mesa.token', allowedProjects: ['p1'] },
        servidor: { environmentId: 'env-servidor', ssh: { host: 'servidor', remotePort: 3774 }, tokenFile: '~/.config/t3-connector/tokens/servidor.token', allowedProjects: ['p2'] },
      },
    }));
    const c = await carregarConfig(arquivo);
    assert.equal(c.padrao, 'mesa');
    assert.deepEqual(c.ambientes.map((a) => [a.alias, a.ssh?.portaRemota ?? null, a.projetosPermitidos]), [['mesa', null, ['p1']], ['servidor', 3774, ['p2']]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('config de escrita: só chaves em inglês; allowlists continuam recusadas em qualquer idioma', () => {
  const ambiente = { environmentId: 'env-s', ssh: { host: 'remoto' }, tokenFile: '/t' };
  const base = { port: 7433, stateDir: '/x', channel: { organization: 'o', tunnelId: 'tunnel_abc' }, environments: { remoto: ambiente } };
  const c = validarConfigEscrita(base);
  assert.equal(c.porta, 7433);
  assert.equal(c.canal.tunnelId, 'tunnel_abc');
  for (const [legado, novo] of [['porta', 'port'], ['estado', 'stateDir'], ['canal', 'channel'], ['ambientes', 'environments']]) {
    assert.throws(() => validarConfigEscrita({ ...base, [legado]: base[novo] }), new RegExp(`"${legado}" foi renomeado para "${novo}"`));
  }
  for (const campo of ['allowedProjects', 'projects', 'actions', 'projetosPermitidos', 'projetos', 'acoes']) {
    assert.throws(() => validarConfigEscrita({ ...base, environments: { remoto: { ...ambiente, [campo]: ['x'] } } }), /não é suportado/);
  }
});
