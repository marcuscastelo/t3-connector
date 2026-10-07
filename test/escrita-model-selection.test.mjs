import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Dispatcher} from '../src/escrita/adapters.mjs';
import {problemasModelSelection, MODEL_SELECTION_ACTIONS} from '../src/escrita/model-selection.mjs';
import {criarConexaoEscrita} from '../src/escrita/conexao.mjs';
import {criarPonteEscrita, relayHttp} from '../src/escrita/ponte-mcp.mjs';
import {setup, memoryJournal} from './escrita-fixtures.mjs';

// ServerProvider as T3 8ed276c2 sends it (contracts model.ts): select and boolean descriptors.
const descritores = ({fast = true} = {}) => [
 {id: 'reasoningEffort', label: 'Reasoning', type: 'select', options: [{id: 'low', label: 'Low'}, {id: 'high', label: 'High', isDefault: true}]},
 ...(fast ? [{id: 'fastMode', label: 'Fast mode', type: 'boolean'}] : []),
];
const catalogo = (opcoes) => [
 {instanceId: 'codex', driver: 'codex', enabled: true, models: [{slug: 'gpt-6.1-sol', name: 'Sol', isCustom: false, capabilities: {optionDescriptors: [descritores()[0]]}}]},
 {instanceId: 'claudeAgent_custom', driver: 'claudeAgent', enabled: true, models: [
  {slug: 'claude-opus-5-5', name: 'Opus 5.5', isCustom: false, capabilities: {optionDescriptors: descritores(opcoes)}},
  {slug: 'meu-modelo', name: 'Custom', isCustom: true, capabilities: {}},
 ]},
];
const opus = (options) => ({instanceId: 'claudeAgent_custom', model: 'claude-opus-5-5', ...(options ? {options} : {})});

test('pure: supported selections, exact IDs, with or without options', () => {
 for (const s of [opus(), opus([{id: 'fastMode', value: true}]), opus([{id: 'fastMode', value: false}, {id: 'reasoningEffort', value: 'high'}]),
  {instanceId: 'claudeAgent_custom', model: 'meu-modelo'}, {instanceId: 'codex', model: 'gpt-6.1-sol', options: [{id: 'reasoningEffort', value: 'low'}]}])
  assert.deepEqual(problemasModelSelection(catalogo(), s), [], JSON.stringify(s));
});

test('pure: each unsupported option or value has its own code and names the offered values', () => {
 const casos = [
  [opus([{id: 'fastMode', value: true}]), {fast: false}, 'model_option_unsupported', /option "fastMode" is not offered by model "claude-opus-5-5" of instance "claudeAgent_custom"\. Offered options: "reasoningEffort" \(select\)\./],
  [opus([{id: 'fastMode', value: 'true'}]), {}, 'model_option_value_unsupported', /"fastMode" is a boolean; value "true" must be true or false/],
  [opus([{id: 'reasoningEffort', value: 'max'}]), {}, 'model_option_value_unsupported', /"reasoningEffort" is a select; value "max" is not one of: "low", "high"/],
  [opus([{id: 'reasoningEffort', value: true}]), {}, 'model_option_value_unsupported', /value true is not one of/],
  [opus([{id: 'fastMode', value: true}, {id: 'fastMode', value: false}]), {}, 'model_option_unsupported', /"fastMode" is repeated/],
  [{instanceId: 'claudeAgent_custom', model: 'meu-modelo', options: [{id: 'fastMode', value: true}]}, {}, 'model_capabilities_unknown', /declares no option descriptors/],
 ];
 for (const [selection, opcoes, code, message] of casos) {
  const [p] = problemasModelSelection(catalogo(opcoes), selection);
  assert.equal(p.code, code, JSON.stringify(selection));assert.match(p.message, message);
 }
 // Case and spelling are not normalized.
 assert.equal(problemasModelSelection(catalogo(), opus([{id: 'fastmode', value: true}]))[0].code, 'model_option_unsupported');
 const tipo = catalogo();tipo[1].models[0].capabilities.optionDescriptors.push({id: 'novo', label: 'n', type: 'slider'});
 assert.equal(problemasModelSelection(tipo, opus([{id: 'novo', value: 'x'}]))[0].code, 'model_capabilities_unknown');
 // Every problem is reported, not only the first.
 assert.equal(problemasModelSelection(catalogo({fast: false}), opus([{id: 'fastMode', value: true}, {id: 'reasoningEffort', value: 'max'}])).length, 2);
});

test('pure: missing provider instance or model lists what the environment offers', () => {
 const [i] = problemasModelSelection(catalogo(), {instanceId: 'claudeagent_custom', model: 'claude-opus-5-5'});
 assert.equal(i.code, 'provider_instance_unavailable');assert.match(i.message, /instanceId "claudeagent_custom" is not configured.*Configured instanceIds: "codex", "claudeAgent_custom"\./);
 const [m] = problemasModelSelection(catalogo(), {instanceId: 'codex', model: 'claude-opus-5-5'});
 assert.equal(m.code, 'provider_model_unavailable');assert.match(m.message, /model "claude-opus-5-5" is not offered by instance "codex"\. Offered models: "gpt-6.1-sol"\./);
 const semModelos = catalogo();delete semModelos[0].models;
 assert.equal(problemasModelSelection(semModelos, {instanceId: 'codex', model: 'gpt-6.1-sol'})[0].code, 'model_capabilities_unknown');
});

// Dispatcher with a mutable provider catalog: read on every write, nothing cached.
async function harness({providers} = {}) {
 const s = setup();s.env.actions = [...MODEL_SELECTION_ACTIONS];const lease = await s.grant();
 const calls = [], estado = {catalogo: catalogo(), leituras: 0};
 const adapter = {
  providers: providers ?? (async () => {estado.leituras++;return structuredClone(estado.catalogo);}),
  verifyWorkspace: async () => true, projectForThread: async () => 'app',
  invoke: async (method, payload) => {calls.push({method, payload});return method === 'orchestration.launchThread' ? {threadId: payload.threadId, resumed: false} : {sequence: calls.length};},
  receipt: (r) => r,
 };
 const journal = memoryJournal();
 const d = new Dispatcher({gate: s.gate, adapter, journal, environmentId: s.env.environmentId, destination: s.env.destination});
 const inputs = {
  'thread.launch': (modelSelection) => ({projectId: 'app', title: 't', modelSelection, workspaceStrategy: {type: 'root'}}),
  'thread.model-selection.set': (modelSelection) => ({threadId: 'thread', modelSelection}),
  'provider.switch': (modelSelection) => ({threadId: 'thread', modelSelection}),
  'delegated_task.request': (modelSelection) => ({parentThreadId: 'thread', parentRunId: 'run', parentNodeId: 'node', task: 'task', modelSelection}),
 };
 const dispatch = (action, operationId, modelSelection) => d.dispatch(s.caller, lease.leaseId, {operationId, action, input: inputs[action](modelSelection)});
 return {calls, estado, dispatch, journal, s};
}

for (const action of MODEL_SELECTION_ACTIONS) test(`${action}: fastMode accepted without a prior lookup and sent exactly as given`, async () => {
 const h = await harness(), selection = opus([{id: 'fastMode', value: true}]);
 const r = await h.dispatch(action, 'op-fast', selection);
 assert.equal(r.state, 'completed');assert.equal(h.estado.leituras, 1);assert.equal(h.calls.length, 1);
 // No option added, removed, reordered or defaulted (reasoningEffort is not filled in).
 assert.deepEqual(h.calls[0].payload.modelSelection, selection);
});

for (const action of MODEL_SELECTION_ACTIONS) test(`${action}: unsupported option is refused before sending, with the exact problem`, async () => {
 const h = await harness();h.estado.catalogo = catalogo({fast: false});
 await assert.rejects(h.dispatch(action, 'op-bad', opus([{id: 'fastMode', value: true}])), (e) => {
  assert.equal(e.message, 'model_option_unsupported');
  assert.equal(e.native.code, 'model_option_unsupported');
  assert.match(e.native.message, /option "fastMode" is not offered by model "claude-opus-5-5" of instance "claudeAgent_custom"\. Offered options: "reasoningEffort" \(select\)\. Nothing was sent\.$/);
  return true;
 });
 assert.equal(h.calls.length, 0);
});

test('missing provider instance and missing model are refused before sending; record is rejected, gate stays open', async () => {
 const h = await harness();
 await assert.rejects(h.dispatch('thread.launch', 'op-i', {instanceId: 'cursor', model: 'claude-opus-5-5'}), {message: 'provider_instance_unavailable'});
 await assert.rejects(h.dispatch('thread.launch', 'op-m', {instanceId: 'claudeAgent_custom', model: 'claude-opus-9'}), {message: 'provider_model_unavailable'});
 assert.equal(h.calls.length, 0);
 // A refusal before the send is journaled rejected with its code; the same operationId replays it.
 const again = await h.dispatch('thread.launch', 'op-m', {instanceId: 'claudeAgent_custom', model: 'claude-opus-9'});
 assert.equal(again.state, 'rejected');assert.equal(again.error.code, 'provider_model_unavailable');
 // The lease still works: a valid write goes through.
 assert.equal((await h.dispatch('thread.launch', 'op-ok', opus())).state, 'completed');
});

test('capability change between writes: each write validates against the configuration read at that moment', async () => {
 const h = await harness(), fast = opus([{id: 'fastMode', value: true}]);
 assert.equal((await h.dispatch('thread.model-selection.set', 'c1', fast)).state, 'completed');
 h.estado.catalogo = catalogo({fast: false});
 await assert.rejects(h.dispatch('thread.model-selection.set', 'c2', fast), {message: 'model_option_unsupported'});
 h.estado.catalogo = catalogo();
 assert.equal((await h.dispatch('thread.model-selection.set', 'c3', fast)).state, 'completed');
 // Model removed from the instance after a successful launch.
 h.estado.catalogo[1].models = h.estado.catalogo[1].models.filter((m) => m.slug !== 'claude-opus-5-5');
 await assert.rejects(h.dispatch('thread.model-selection.set', 'c4', fast), {message: 'provider_model_unavailable'});
 assert.equal(h.estado.leituras, 4);assert.equal(h.calls.length, 2);
});

test('unreadable configuration fails closed: nothing sent, distinct code', async () => {
 for (const providers of [async () => {throw new Error('socket down');}, async () => ({not: 'a list'})]) {
  const h = await harness({providers});
  await assert.rejects(h.dispatch('thread.launch', 'op', opus()), (e) => e.native?.code === 'model_capabilities_unavailable' && /server\.getConfig/.test(e.native.message));
  assert.equal(h.calls.length, 0);
 }
});

test('actions without modelSelection never read the provider configuration', async () => {
 const s = setup();s.env.actions = ['thread.settle'];const lease = await s.grant();let leituras = 0;
 const adapter = {providers: async () => {leituras++;return [];}, projectForThread: async () => 'app', invoke: async () => ({sequence: 1}), receipt: (r) => r};
 const d = new Dispatcher({gate: s.gate, adapter, journal: memoryJournal(), environmentId: s.env.environmentId, destination: s.env.destination});
 assert.equal((await d.dispatch(s.caller, lease.leaseId, {operationId: 'o', action: 'thread.settle', input: {threadId: 't'}})).state, 'completed');
 assert.equal(leituras, 0);
});

// Write connection: server.getConfig over the same V2 socket, and the environment must match.
function socketFalso(config) {
 const sockets = [];
 class S extends EventEmitter {
  constructor(url) {super();this.url = url;this.readyState = 0;this.enviados = [];sockets.push(this);setTimeout(() => {this.readyState = 1;this.emit('open');}, 1);}
  addEventListener(ev, fn, o) {(o?.once ? this.once : this.on).call(this, ev, (e) => fn(e));}
  send(data) {const f = JSON.parse(data);this.enviados.push(f);setTimeout(() => this.emit('message', {data: JSON.stringify({_tag: 'Exit', requestId: f.id, exit: {_tag: 'Success', value: f.tag === 'server.getConfig' ? config() : {sequence: 1}}})}), 1);}
  close() {this.readyState = 3;this.emit('close');}
 }
 return {sockets, S};
}
const registro = {alias: 'remoto', environmentId: 'env-s', ssh: {host: 'remoto'}, tokenFile: '/x', destination: 't3://env-s'};
const conexao = (config) => {
 const f = socketFalso(config);
 const cliente = () => ({ambiente: async () => ({orchestrationProtocolVersion: 2, environmentId: 'env-s', label: 'r', serverVersion: 'v'}), sessao: async () => ({scopes: ['orchestration:read', 'orchestration:operate']}), ticketWs: async () => 'ticket'});
 const c = criarConexaoEscrita(registro, {transporte: {baseUrl: async () => 'http://127.0.0.1:43773', descartar() {}, fechar() {}}, lerToken: () => 't', criarClienteImpl: cliente, WebSocketImpl: f.S});
 return {c, f};
};

test('write connection reads providers from server.getConfig of the same environment, fresh each time', async () => {
 let atual = catalogo();
 const {c, f} = conexao(() => ({environment: {environmentId: 'env-s'}, providers: atual}));
 assert.deepEqual(await c.adapter.providers(), catalogo());
 atual = catalogo({fast: false});
 assert.deepEqual(await c.adapter.providers(), catalogo({fast: false}));
 assert.deepEqual(f.sockets[0].enviados.map((x) => [x.tag, x.payload]), [['server.getConfig', {}], ['server.getConfig', {}]]);
 c.fechar();
 for (const config of [{environment: {environmentId: 'env-p'}, providers: []}, {environment: {environmentId: 'env-s'}}]) {
  const {c: outra} = conexao(() => config);
  await assert.rejects(outra.adapter.providers(), /providers_unavailable/);
  outra.fechar();
 }
});

test('lease bridge: refusal code and exact message reach the client through the private HTTP relay', async (t) => {
 const detail = 'option "fastMode" is not offered by model "claude-opus-5-5" of instance "claudeAgent_custom". Offered options: "reasoningEffort" (select). Nothing was sent.';
 const http = createServer((req, res) => {res.writeHead(403, {'content-type': 'application/json'});res.end(JSON.stringify({error: 'model_option_unsupported', native: {code: 'model_option_unsupported', message: detail}}));});
 await new Promise((r) => http.listen(0, '127.0.0.1', r));
 const server = criarPonteEscrita({aliases: ['isolated'], approvalOrigin: 'https://approval.example.test', relay: relayHttp({porta: http.address().port, lerCapability: () => 'cap'})});
 const [a, b] = InMemoryTransport.createLinkedPair();await server.connect(b);
 const client = new Client({name: 'model-options', version: '1'});await client.connect(a);
 t.after(async () => {await client.close();await server.close();http.close();});
 // relayHttp targets localhost: skip where localhost does not resolve to the IPv4 listener.
 const r = await client.callTool({name: 't3_escrever_thread_launch', arguments: {leaseId: 'l', environment: 'isolated', operationId: 'o', input: {projectId: 'app', title: 't', modelSelection: opus([{id: 'fastMode', value: true}]), workspaceStrategy: {type: 'root'}}}});
 if (r.content[0].text.startsWith('gate_unavailable')) return t.skip('localhost does not reach 127.0.0.1');
 assert.equal(r.isError, true);assert.equal(r.content[0].text, `model_option_unsupported: ${detail}`);
});
