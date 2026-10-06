// Paridade control-plane v1 na ponte com lease (§1, commit 7): mesmas definições da leitura,
// leituras multi-environment sob a ACL de cada grant, e preflight calculado com o grant da lease,
// igual ao dispatchGuard do apply (preflight → dispatch protegido de ponta a ponta).

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { controller } from '../src/escrita/controller.mjs';
import { criarPonteEscrita } from '../src/escrita/ponte-mcp.mjs';
import { setup, memoryJournal, ORIGIN } from './escrita-fixtures.mjs';
import { ambientesFalsos, conectarMcp } from './apoio.mjs';

const modelo = { slug: 'gpt-6.1-sol', capabilities: { optionDescriptors: [] } };
const provider = { instanceId: 'codex', enabled: true, installed: true, status: 'ready', auth: { status: 'authenticated' }, supportedRuntimeModes: ['full-access'], models: [modelo] };

function conexao(alias, environmentId, estado) {
  const calls = [];
  const shell = () => ({ snapshotSequence: estado.seq, projects: [{ id: 'app', title: 'app', workspaceRoot: `/${alias}/app` }], threads: estado.threads[alias].map((t) => ({ status: 'completed', latestRunId: 'r1', modelSelection: null, ...t })) });
  return {
    calls,
    registro: { alias, environmentId, destination: `t3://${environmentId}`, acoes: ['thread.launch', 'thread.send'] },
    inventario: async () => [{ id: 'app', name: 'app', directory: `/${alias}/app` }],
    cliente: async () => ({ shell: async () => shell(), thread: async () => ({ projection: { messages: [], runs: [] }, hasMoreHistory: false }), threadCompleto: async () => { throw new Error('404'); } }),
    adapter: {
      prepare: async () => {},
      projectForThread: async (id) => (estado.threads[alias].some((t) => t.id === id) ? 'app' : undefined),
      invoke: async (m, p) => { calls.push({ m, p }); return m === 'orchestration.launchThread' ? { threadId: p.threadId, resumed: false } : { sequence: 9 }; },
      receipt: (r) => ('threadId' in r ? { threadId: r.threadId, resumed: r.resumed } : { sequence: r.sequence }),
      reconcile: async () => ({ found: false, state: 'unknown' }),
      native: { rpc: async (tag) => (tag === 'server.getConfig' ? { environment: { environmentId }, providers: [provider] } : { snapshotSequence: estado.seq, threads: [] }) },
    },
    fechar() {},
  };
}

async function montar() {
  const estado = { seq: 4, threads: { local: [{ id: 'dona', projectId: 'app', title: 'Frente A' }], remoto: [{ id: 'dona', projectId: 'app', title: 'Frente A remota' }] } };
  const s = setup();
  const local = conexao('local', 'env-p', estado);
  const remoto = conexao('remoto', 'env-s', estado);
  const c = controller({ conexoes: [local, remoto], passkeys: s.passkeys, journal: { ...memoryJournal(), audit: () => {} }, organization: 'my-org', tunnelId: 'tunnel_fixture' });
  const r = await c.relay(c.capability, { op: 'request' });
  const ch = c.gate.challenge(r.requestId, ORIGIN);
  const l = await c.gate.approve(r.requestId, { response: s.auth.assertion(ch), origin: ORIGIN });
  return { estado, local, remoto, l, c, relay: (req) => c.relay(c.capability, req) };
}

test('ponte: as 6 tools novas têm exatamente os parâmetros da leitura (mais leaseId; environment obrigatório nas de um environment)', async () => {
  const leitura = await conectarMcp(ambientesFalsos());
  const server = criarPonteEscrita({ relay: async () => ({}), aliases: ['local', 'remoto'], approvalOrigin: 'http://localhost:7433' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const escrita = new Client({ name: 't', version: '0' });
  await escrita.connect(a);
  const deLeitura = (await leitura.listTools()).tools;
  const deEscrita = (await escrita.listTools()).tools;
  for (const nome of ['t3_providers', 't3_aguardar_thread', 't3_ambientes', 't3_thread_find_batch', 't3_workset', 't3_dispatch_preflight']) {
    const l = deLeitura.find((t) => t.name === nome);
    const e = deEscrita.find((t) => t.name === nome);
    assert.ok(e, nome);
    assert.deepEqual(Object.keys(e.inputSchema.properties).filter((k) => k !== 'leaseId').sort(), Object.keys(l.inputSchema.properties).sort(), nome);
    for (const k of Object.keys(l.inputSchema.properties).filter((k) => k !== 'environment')) assert.deepEqual(e.inputSchema.properties[k], l.inputSchema.properties[k], `${nome}.${k}`);
    assert.equal(e.annotations?.readOnlyHint, true, nome);
  }
  assert.ok(deEscrita.find((t) => t.name === 't3_aguardar_thread').inputSchema.required.includes('environment'));
  assert.equal(deEscrita.some((t) => t.name === 't3_buscar_threads'), false, 'busca singular fica fora da ponte');
  await escrita.close();
});

test('readMulti: find_batch e workset atravessam os environments da lease; sem lease nada sai', async () => {
  const { l, relay } = await montar();
  const r = await relay({ op: 'readMulti', leaseId: l.leaseId, operation: 't3_thread_find_batch', input: { controlPlaneContractVersion: 1, queries: [{ key: 'a', selector: { title: { value: 'Frente A', match: 'partial' } } }] } });
  const d = JSON.parse(r.content[0].text);
  assert.deepEqual(d.results[0].candidates.map((c) => `${c.environment.alias}:${c.threadId}`), ['local:dona', 'remoto:dona']);
  const w = JSON.parse((await relay({ op: 'readMulti', leaseId: l.leaseId, operation: 't3_workset', input: {} })).content[0].text);
  assert.deepEqual(w.queriedEnvironments.map((e) => e.alias), ['local', 'remoto']);
  const amb = JSON.parse((await relay({ op: 'readMulti', leaseId: l.leaseId, operation: 't3_ambientes', input: { check: false } })).content[0].text);
  assert.deepEqual(amb.environments.map((e) => [e.alias, e.transport]), [['local', 'lease'], ['remoto', 'lease']]);
  await assert.rejects(relay({ op: 'readMulti', leaseId: 'outra', operation: 't3_workset', input: {} }), /lease_closed/);
  await assert.rejects(relay({ op: 'readMulti', leaseId: l.leaseId, operation: 't3_projetos', input: {} }), /action_unavailable/);
});

test('readMulti: lease encerrada durante a leitura não libera o resultado já buscado', async () => {
  const { l, c, remoto, relay } = await montar();
  let soltar;
  const parado = new Promise((r) => { soltar = r; });
  const original = remoto.cliente;
  remoto.cliente = async () => { const cl = await original(); return { ...cl, shell: async () => { const s = await cl.shell(); await parado; return s; } }; };
  const leitura = relay({ op: 'readMulti', leaseId: l.leaseId, operation: 't3_workset', input: {} });
  await new Promise((r) => setTimeout(r, 20));
  c.gate.close();
  soltar();
  await assert.rejects(leitura, /lease_closed/);
});

const launch = (title) => ({ projectId: 'app', title, modelSelection: { instanceId: 'codex', model: 'gpt-6.1-sol' }, runtimeMode: 'full-access', workspaceStrategy: { type: 'root' } });
const expected = { projectId: 'app', workspace: { type: 'root', path: '/local/app', branch: null } };
const dup = (title) => ({ environments: ['local', 'remoto'], population: 'all', selector: { title: { value: title } } });

test('preflight pela ponte → dispatch protegido: o mesmo cálculo admite; frente que apareceu depois recusa sem enviar', async () => {
  const { estado, local, l, relay } = await montar();
  const pre = await relay({ op: 'preflight', leaseId: l.leaseId, input: { action: 'thread.launch', environment: 'local', input: launch('Frente B'), expected, duplicateCheck: dup('Frente B') } });
  assert.equal(pre.admissible, true, JSON.stringify(pre.reasons));
  const guard = { version: 1, expectedInputDigest: pre.inputDigest, expectedObservationId: pre.observationId, expected, duplicateCheck: dup('Frente B') };
  const ok = await relay({ op: 'dispatch', ambiente: 'local', leaseId: l.leaseId, action: 'thread.launch', operationId: 'launch-b', input: { ...launch('Frente B'), dispatchGuard: guard } });
  assert.equal(ok.state, 'completed');
  assert.equal(ok.createdThread.threadId, local.calls.find((c) => c.m === 'orchestration.launchThread').p.threadId);
  assert.equal('dispatchGuard' in local.calls[0].p, false);
  // Outro cliente criou a frente C no Remoto entre o preflight e o apply.
  const preC = await relay({ op: 'preflight', leaseId: l.leaseId, input: { action: 'thread.launch', environment: 'local', input: launch('Frente C'), expected, duplicateCheck: dup('Frente C') } });
  assert.equal(preC.admissible, true);
  estado.threads.remoto.push({ id: 'c-remota', projectId: 'app', title: 'Frente C' });
  const antes = local.calls.length;
  await assert.rejects(relay({ op: 'dispatch', ambiente: 'local', leaseId: l.leaseId, action: 'thread.launch', operationId: 'launch-c', input: { ...launch('Frente C'), dispatchGuard: { version: 1, expectedInputDigest: preC.inputDigest, expectedObservationId: preC.observationId, expected, duplicateCheck: dup('Frente C') } } }), /dispatch_front_exists/);
  assert.equal(local.calls.length, antes);
  const agora = await relay({ op: 'preflight', leaseId: l.leaseId, input: { action: 'thread.launch', environment: 'local', input: launch('Frente C'), expected, duplicateCheck: dup('Frente C') } });
  assert.equal(agora.admissible, false);
  assert.deepEqual(agora.duplicateCheck.candidates.map((c) => c.threadId), ['c-remota']);
  await assert.rejects(relay({ op: 'preflight', leaseId: 'outra', input: { action: 'thread.launch', environment: 'local', input: launch('x'), expected, duplicateCheck: dup('x') } }), /lease_closed/);
  await assert.rejects(relay({ op: 'preflight', leaseId: l.leaseId, input: { action: 'thread.launch', environment: 'local', input: { ...launch('x'), dispatchGuard: {} }, expected } }), /invalid_input/);
});
