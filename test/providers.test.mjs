import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chamar } from '../src/ws.mjs';
import { CAMPOS, resumoProvider } from '../src/providers.mjs';
import { Cancelada, ErroT3 } from '../src/t3.mjs';
import { ambientesFalsos, conectarMcp, dados, LOCAL, REMOTO } from './apoio.mjs';

// ServerProvider no formato do contrato do T3 (packages/contracts/src/server.ts:367-438),
// com os campos sensíveis preenchidos para provar que não saem.
const modelo = (slug, extra = {}) => ({
  slug,
  name: slug.toUpperCase(),
  isCustom: false,
  capabilities: { optionDescriptors: [{ id: 'reasoningEffort', label: 'Reasoning', type: 'select', options: [{ id: 'high', label: 'High', isDefault: true }] }] },
  ...extra,
});
const provider = (instanceId, extra = {}) => ({
  instanceId,
  driver: 'codex',
  displayName: instanceId,
  continuation: { groupKey: 'codex' },
  enabled: true,
  installed: true,
  version: '1.2.3',
  status: 'ready',
  auth: { status: 'authenticated', email: 'pessoa@example.com', profileId: 'perfil', action: { elicitationId: 'e', url: 'https://login.example', message: 'm' } },
  checkedAt: '2026-10-05T10:00:00.000Z',
  models: [modelo('gpt-6.1-sol')],
  slashCommands: [{ name: 'review' }],
  skills: [{ name: 's', path: '/Users/dev/.codex/skills/s', enabled: true }],
  runtimePaths: { homePath: '/Users/dev/.codex-galm', shadowHomePath: null },
  usageLimits: { checkedAt: '2026-10-05T10:00:00.000Z', windows: [], credentialFingerprint: 'fp' },
  workspaceSnapshots: [{ cwd: '/Users/dev/app', checkedAt: '2026-10-05T10:00:00.000Z', slashCommands: [], skills: [] }],
  versionAdvisory: { status: 'current', currentVersion: '1.2.3', latestVersion: '1.2.3', updateCommand: 'npm i -g x', canUpdate: false, checkedAt: null, message: null },
  setup: { canAuthenticate: true, canInstall: false },
  accentColor: '#fff',
  ...extra,
});

const configs = {
  [LOCAL.environmentId]: {
    environment: { environmentId: LOCAL.environmentId, label: 'local' },
    settings: { providerInstances: { codex_galm: { driver: 'codex', config: { apiKey: 'segredo' } } } },
    cwd: '/Users/dev',
    providers: [
      provider('codex'),
      provider('codex_galm', { displayName: 'Codex Galm', models: [modelo('gpt-6.1-sol'), modelo('meu-modelo', { isCustom: true })] }),
      provider('claudeAgent_custom', { driver: 'claudeAgent', displayName: 'Claude Custom' }),
      provider('cursor', { driver: 'cursor', enabled: false, installed: false, status: 'disabled', message: 'Cursor is disabled in T3 Code settings.', models: [] }),
      provider('sumido', { driver: 'driver-novo', enabled: false, installed: false, status: 'error', availability: 'unavailable', unavailableReason: 'Driver not registered', models: [] }),
    ],
  },
  [REMOTO.environmentId]: {
    environment: { environmentId: REMOTO.environmentId, label: 'remoto' },
    providers: [provider('codex_galm', { displayName: 'Codex GALM', supportedRuntimeModes: ['full-access'], requiresNewThreadForModelChange: true })],
  },
};

/** RPC falso: responde pelo baseUrl, como cada environment real responderia no próprio /ws. */
function rpcFalso({ porBase = { 'http://127.0.0.1:3773/': LOCAL.environmentId, 'http://127.0.0.1:43773/': REMOTO.environmentId }, responder } = {}) {
  const pedidos = [];
  const chamarImpl = async (args) => {
    pedidos.push({ ...args, baseUrl: String(args.baseUrl) });
    const env = porBase[String(args.baseUrl)];
    return responder ? responder(env, args) : structuredClone(configs[env]);
  };
  return { pedidos, chamarImpl };
}

async function conectar(opcoes) {
  const rpc = rpcFalso(opcoes);
  const chamadas = [];
  const mcp = await conectarMcp(ambientesFalsos(undefined, { chamadas }), undefined, { chamarImpl: rpc.chamarImpl });
  return { mcp, rpc, chamadas };
}

// Sem `environment` a leitura varre os dois environments; estes testes olham um só.
const providers = (mcp, args = {}) => mcp.callTool({ name: 't3_providers', arguments: { environment: 'local', ...args } });
const varrendo = (mcp, args = {}) => mcp.callTool({ name: 't3_providers', arguments: args });

test('t3_providers: lista do environment escolhido, na ordem do T3, sem filtrar desabilitados nem indisponíveis', async () => {
  const { mcp, rpc, chamadas } = await conectar();
  const r = await providers(mcp, { includeModels: true });
  assert.equal(r.isError, undefined);
  const d = dados(r);
  assert.deepEqual(d.environment, { alias: 'local', environmentId: LOCAL.environmentId });
  assert.equal(d.source, 'server.getConfig');
  assert.equal(d.total, 5);
  assert.deepEqual(d.providers.map((p) => p.instanceId), ['codex', 'codex_galm', 'claudeAgent_custom', 'cursor', 'sumido']);
  assert.deepEqual(r.structuredContent, d);
  const sumido = d.providers.at(-1);
  assert.deepEqual(sumido, {
    instanceId: 'sumido', driver: 'driver-novo', displayName: 'sumido', enabled: false, installed: false, status: 'error',
    availability: 'unavailable', unavailableReason: 'Driver not registered', version: '1.2.3', checkedAt: '2026-10-05T10:00:00.000Z',
    continuation: { groupKey: 'codex' }, auth: { status: 'authenticated' }, models: [],
    environment: { alias: 'local', environmentId: LOCAL.environmentId, name: 'local' },
  });
  assert.equal(d.providers[3].message, 'Cursor is disabled in T3 Code settings.');
  assert.deepEqual(rpc.pedidos.map(({ baseUrl, ticket, tag, payload }) => ({ baseUrl, ticket, tag, payload })),
    [{ baseUrl: 'http://127.0.0.1:3773/', ticket: 'ticket', tag: 'server.getConfig', payload: {} }]);
  assert.ok(chamadas.includes('local:ticket'));
  assert.ok(!chamadas.some((c) => c.endsWith(':shell')), 'não deriva nada de threads');
});

test('t3_providers: IDs, nomes e modelos preservados literalmente; modelos customizados e capabilities como vieram', async () => {
  const { mcp } = await conectar();
  const d = dados(await providers(mcp, { includeModels: true }));
  const galm = d.providers.find((p) => p.instanceId === 'codex_galm');
  assert.equal(galm.displayName, 'Codex Galm');
  assert.deepEqual(galm.models, configs[LOCAL.environmentId].providers[1].models);
  assert.equal(galm.models[1].isCustom, true);
  assert.equal(d.providers.find((p) => p.instanceId === 'claudeAgent_custom').driver, 'claudeAgent');
});

test('t3_providers: cada environment responde pelo próprio /ws; o mesmo instanceId pode ter outro nome', async () => {
  const { mcp, rpc } = await conectar();
  const d = dados(await providers(mcp, { environment: 'remoto', includeModels: true }));
  assert.deepEqual(d.environment, { alias: 'remoto', environmentId: REMOTO.environmentId });
  assert.equal(d.total, 1);
  assert.equal(d.providers[0].displayName, 'Codex GALM');
  assert.deepEqual(d.providers[0].supportedRuntimeModes, ['full-access']);
  assert.equal(d.providers[0].requiresNewThreadForModelChange, true);
  assert.equal(rpc.pedidos[0].baseUrl, 'http://127.0.0.1:43773/');
  const porId = dados(await providers(mcp, { environment: REMOTO.environmentId }));
  assert.equal(porId.providers[0].displayName, 'Codex GALM');
});

test('t3_providers: não repassa conta, caminhos, quota, skills nem settings', async () => {
  const { mcp } = await conectar();
  const r = await providers(mcp, { includeModels: true });
  const texto = r.content[0].text;
  for (const vazamento of ['pessoa@example.com', 'login.example', 'perfil', '.codex-galm', '/Users/dev', 'fp', 'segredo', 'npm i -g', 'skills', 'slashCommands', 'usageLimits', 'runtimePaths', '"settings"', 'providerInstances', 'accentColor']) {
    assert.ok(!texto.includes(vazamento), `não deveria conter ${vazamento}`);
  }
  for (const p of dados(r).providers) {
    for (const chave of Object.keys(p)) assert.ok([...CAMPOS, 'auth', 'models', 'environment'].includes(chave), chave);
    assert.deepEqual(Object.keys(p.auth), ['status']);
  }
});

test('t3_providers: sem includeModels lista só as instances, sem models', async () => {
  const { mcp } = await conectar();
  const d = dados(await providers(mcp));
  assert.equal(d.total, 5);
  assert.ok(d.providers.every((p) => !('models' in p)));
  assert.equal(dados(await providers(mcp, { includeModels: false })).providers.some((p) => 'models' in p), false);
});

test('t3_providers: filtro instanceId é literal e sensível a maiúsculas; models só com includeModels true', async () => {
  const { mcp } = await conectar();
  const comModelos = dados(await providers(mcp, { instanceId: 'codex_galm', includeModels: true }));
  assert.deepEqual(comModelos.providers[0].models.map((m) => m.slug), ['gpt-6.1-sol', 'meu-modelo']);
  const exato = dados(await providers(mcp, { instanceId: 'codex_galm' }));
  assert.equal(exato.total, 1);
  assert.equal(exato.providers[0].instanceId, 'codex_galm');
  assert.equal('models' in exato.providers[0], false);
  for (const outro of ['Codex_Galm', 'codex-galm', 'codex_gal', 'Codex Galm']) {
    const d = dados(await providers(mcp, { instanceId: outro }));
    assert.equal(d.total, 0, outro);
    assert.deepEqual(d.providers, []);
  }
});

test('t3_providers: campos ausentes no T3 continuam ausentes, sem default inventado', () => {
  const minimo = { instanceId: 'x', driver: 'codex', enabled: true, installed: true, version: null, status: 'warning', auth: { status: 'unknown' }, checkedAt: 't', models: [] };
  assert.deepEqual(resumoProvider(minimo, { incluirModelos: true }), minimo);
  assert.deepEqual(resumoProvider({ instanceId: 'y' }), { instanceId: 'y' });
});

test('t3_providers: erros viram isError com mensagem, sem derrubar o servidor', async () => {
  const casos = [
    [() => ({ ...configs[LOCAL.environmentId], environment: { environmentId: 'env-outro' } }), /answered as environment env-outro; expected env-local/],
    [() => ({ environment: { environmentId: LOCAL.environmentId } }), /without the providers list/],
    [() => { throw new ErroT3('T3 refused server.getConfig: The authenticated token is missing required scope: orchestration:read.', { codigo: 'EnvironmentAuthorizationError' }); }, /missing required scope/],
  ];
  for (const [responder, esperado] of casos) {
    const { mcp } = await conectar({ responder });
    const r = await providers(mcp);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, esperado);
  }
  const { mcp } = await conectar();
  const fora = await providers(mcp, { environment: 'nenhum' });
  assert.equal(fora.isError, true);
  assert.match(fora.content[0].text, /environment "nenhum" is not configured/);
});

test('t3_providers: sem environment varre os dois, cada instance com o seu; falha de um vira escopo incompleto', async () => {
  const { mcp, rpc } = await conectar();
  const d = dados(await varrendo(mcp));
  assert.equal(d.complete, true);
  assert.equal(d.total, 6);
  assert.equal('environment' in d, false, 'sem environment de topo: cada item diz o seu');
  assert.deepEqual(d.queriedEnvironments.map((a) => [a.alias, a.found]), [['local', 5], ['remoto', 1]]);
  assert.deepEqual(d.providers.map((p) => `${p.environment.alias}:${p.instanceId}`), ['local:codex', 'local:codex_galm', 'local:claudeAgent_custom', 'local:cursor', 'local:sumido', 'remoto:codex_galm']);
  assert.deepEqual(d.providers[0].environment, { alias: 'local', environmentId: LOCAL.environmentId, name: 'local' });
  assert.deepEqual(rpc.pedidos.map((x) => x.baseUrl).sort(), ['http://127.0.0.1:3773/', 'http://127.0.0.1:43773/']);
  // O mesmo instanceId em dois environments não se funde.
  const galm = dados(await varrendo(mcp, { instanceId: 'codex_galm' }));
  assert.deepEqual(galm.providers.map((p) => [p.environment.alias, p.displayName]), [['local', 'Codex Galm'], ['remoto', 'Codex GALM']]);

  const { mcp: parcial } = await conectar({ responder: (env) => { if (env === REMOTO.environmentId) throw new ErroT3('T3 refused server.getConfig', { status: 403 }); return structuredClone(configs[env]); } });
  const p = dados(await varrendo(parcial));
  assert.equal(p.isError, undefined);
  assert.equal(p.complete, false);
  assert.equal(p.total, 5);
  assert.deepEqual(p.environmentFailures, [{ alias: 'remoto', environmentId: REMOTO.environmentId, code: 'http_403', reason: 'T3 refused the token of this environment' }]);
});

test('t3_providers: transporte caído repete uma vez com conexão nova', async () => {
  let falhas = 1;
  const { mcp, rpc, chamadas } = await conectar({
    responder: (env) => {
      if (falhas-- > 0) throw new ErroT3('WS do T3 closed before answering de server.getConfig', { codigo: 'indisponivel' });
      return structuredClone(configs[env]);
    },
  });
  const d = dados(await providers(mcp, { environment: 'remoto', includeModels: true }));
  assert.equal(d.total, 1);
  assert.equal(rpc.pedidos.length, 2);
  assert.ok(chamadas.includes('remoto:descartar'));
});

test('t3_providers: anotações de leitura', async () => {
  const { mcp } = await conectar();
  const { tools } = await mcp.listTools();
  const t = tools.find((x) => x.name === 't3_providers');
  assert.deepEqual(t.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ['environment', 'includeModels', 'instanceId']);
});

test('t3_providers: nomes em português são recusados, sem cair no environment padrão', async () => {
  const { mcp, rpc } = await conectar();
  for (const args of [{ ambiente: 'remoto' }, { incluirModelos: true }]) {
    const r = await mcp.callTool({ name: 't3_providers', arguments: args }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /-32602|Unrecognized key/);
  }
  assert.equal(rpc.pedidos.length, 0);
});

// --- RPC unário no /ws ---

class SocketFalso extends EventTarget {
  static ultimos = [];
  constructor(url) {
    super();
    this.url = url;
    this.enviados = [];
    this.fechado = false;
    this.readyState = 0;
    SocketFalso.ultimos.push(this);
    queueMicrotask(() => {
      if (SocketFalso.recusar) return this.dispatchEvent(new Event('error'));
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    });
  }
  send(texto) {
    const msg = JSON.parse(texto);
    this.enviados.push(msg);
    queueMicrotask(() => SocketFalso.responder?.(this, msg));
  }
  receber(obj) {
    this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(obj) }));
  }
  close() {
    if (this.fechado) return;
    this.fechado = true;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

function preparar(responder, { recusar = false } = {}) {
  SocketFalso.ultimos = [];
  SocketFalso.responder = responder;
  SocketFalso.recusar = recusar;
}

const chamada = (extra = {}) =>
  chamar({ baseUrl: new URL('http://127.0.0.1:3773'), ticket: 'tk', tag: 'server.getConfig', payload: {}, WebSocketImpl: SocketFalso, ...extra });

test('ws chamar: envia um Request e devolve exit.value; ignora quadros de outro requestId; fecha o socket', async () => {
  preparar((s, msg) => {
    s.receber({ _tag: 'Exit', requestId: '9', exit: { _tag: 'Success', value: 'outro' } });
    s.receber({ _tag: 'Chunk', requestId: msg.id, values: [1] });
    s.receber({ _tag: 'Exit', requestId: msg.id, exit: { _tag: 'Success', value: { providers: [{ instanceId: 'codex_galm' }] } } });
  });
  const v = await chamada();
  assert.deepEqual(v, { providers: [{ instanceId: 'codex_galm' }] });
  const [s] = SocketFalso.ultimos;
  assert.equal(s.url, 'ws://127.0.0.1:3773/ws?orchestrationProtocol=2&wsTicket=tk');
  assert.deepEqual(s.enviados, [{ _tag: 'Request', id: '1', tag: 'server.getConfig', payload: {}, headers: [] }]);
  assert.equal(s.fechado, true);
});

test('ws chamar: https vira wss', async () => {
  preparar((s, msg) => s.receber({ _tag: 'Exit', requestId: msg.id, exit: { _tag: 'Success', value: 1 } }));
  await chamada({ baseUrl: new URL('https://t3.example') });
  assert.match(SocketFalso.ultimos[0].url, /^wss:\/\/t3\.example\/ws\?/);
});

test('ws chamar: falha tipada do T3 vira ErroT3 com a _tag como código', async () => {
  preparar((s, msg) => s.receber({
    _tag: 'Exit', requestId: msg.id,
    exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { _tag: 'EnvironmentAuthorizationError', message: 'The authenticated token is missing required scope: orchestration:read.', requiredScope: 'orchestration:read' } }] },
  }));
  await assert.rejects(chamada(), (e) => e instanceof ErroT3 && e.codigo === 'EnvironmentAuthorizationError' && /server\.getConfig: The authenticated token is missing required scope/.test(e.message));
  assert.equal(SocketFalso.ultimos[0].fechado, true);
});

test('ws chamar: socket fechado antes do Exit ou recusado é indisponível', async () => {
  preparar((s) => s.close());
  await assert.rejects(chamada(), (e) => e instanceof ErroT3 && e.codigo === 'indisponivel' && /closed before answering/.test(e.message));
  preparar(() => {}, { recusar: true });
  await assert.rejects(chamada(), (e) => e instanceof ErroT3 && e.codigo === 'indisponivel');
});

test('ws chamar: prazo esgotado sem resposta é codigo prazo; cancelamento do cliente é Cancelada', async () => {
  preparar(() => {});
  const prazo = new AbortController();
  setTimeout(() => prazo.abort(new DOMException('prazo', 'TimeoutError')), 20);
  await assert.rejects(chamada({ signal: prazo.signal }), (e) => e instanceof ErroT3 && e.codigo === 'prazo');
  assert.equal(SocketFalso.ultimos[0].fechado, true);
  preparar(() => {});
  const ac = new AbortController();
  const p = chamada({ signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(p, (e) => e instanceof Cancelada);
});
