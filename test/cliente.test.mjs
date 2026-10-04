import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { criarCliente, verificarConexao } from '../src/t3.mjs';
import { validarConfig } from '../src/config.mjs';
import { criarTransporteSsh } from '../src/transporte.mjs';

function fetchFalso(rotas) {
  return async (url, opcoes) => {
    const caminho = new URL(url).pathname;
    const corpo = rotas[caminho];
    if (!corpo) return new Response('{}', { status: 404 });
    if (caminho.startsWith('/api/orchestration') && opcoes.headers['x-t3-orchestration-protocol'] !== '2') {
      return new Response('{}', { status: 400 });
    }
    return new Response(JSON.stringify(corpo), { status: 200 });
  };
}

const descritor = { orchestrationProtocolVersion: 2, environmentId: 'e', label: 'local', serverVersion: 'v' };

test('verificação aceita só token de leitura e o environmentId esperado', async () => {
  const amplo = criarCliente({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: fetchFalso({
    '/.well-known/t3/environment': descritor,
    '/api/auth/session': { scopes: ['orchestration:read', 'orchestration:operate'] },
  }) });
  await assert.rejects(verificarConexao(amplo, { environmentIdEsperado: 'e' }), /beyond read/);
  const leitura = criarCliente({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: fetchFalso({
    '/.well-known/t3/environment': descritor,
    '/api/auth/session': { scopes: ['orchestration:read'] },
  }) });
  assert.deepEqual((await verificarConexao(leitura, { environmentIdEsperado: 'e' })).escopos, ['orchestration:read']);
  await assert.rejects(verificarConexao(leitura, { environmentIdEsperado: 'outro' }), /expected outro/);
});

test('verificação recusa servidor fora do protocolo 2 e URL pública sem TLS', async () => {
  const v1 = criarCliente({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: fetchFalso({
    '/.well-known/t3/environment': { orchestrationProtocolVersion: 1 },
  }) });
  await assert.rejects(verificarConexao(v1), /protocol 1/);
  assert.throws(() => criarCliente({ url: 'http://100.64.0.1:3773', token: 't' }), /HTTPS or loopback HTTP/);
});

test('cliente manda o header V2 só nas rotas de orquestração e só usa GET, salvo o ticket WS', async () => {
  const vistos = [];
  const c = criarCliente({ url: 'http://127.0.0.1:1', token: 'segredo', fetchImpl: async (url, o) => {
    vistos.push([new URL(url).pathname, o.headers['x-t3-orchestration-protocol'] ?? null, o.method]);
    return new Response('{"projects":[],"threads":[],"ticket":"t"}', { status: 200 });
  } });
  await c.shell(); await c.projetos(); await c.thread('a/b'); await c.ticketWs();
  assert.deepEqual(vistos, [
    ['/api/orchestration/shell', '2', 'GET'],
    ['/api/projects', null, 'GET'],
    ['/api/orchestration/threads/a%2Fb/bounded', '2', 'GET'],
    ['/api/auth/websocket-ticket', null, 'POST'],
  ]);
});

test('prazo do chamador vira erro "prazo", não "indisponivel"', async () => {
  const c = criarCliente({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: (url, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(o.signal.reason))) });
  const manter = setTimeout(() => {}, 1000);
  await assert.rejects(c.shell({ signal: AbortSignal.timeout(20) }), (e) => e.codigo === 'prazo');
  clearTimeout(manter);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(c.shell({ signal: ac.signal }), /cancelled/);
});

test('config: exige environmentId, um transporte, token e ACL não vazia por environment', () => {
  const base = { environmentId: 'e1', url: 'http://127.0.0.1:3773', tokenFile: '~/t', projetosPermitidos: ['p'] };
  assert.equal(validarConfig({ ambientes: { local: base } }).padrao, 'local');
  assert.throws(() => validarConfig({ ambientes: { local: { ...base, projetosPermitidos: [] } } }), /allowedProjects vazio/);
  assert.throws(() => validarConfig({ ambientes: { local: { ...base, environmentId: undefined } } }), /environmentId/);
  assert.throws(() => validarConfig({ ambientes: { local: { ...base, ssh: { host: 'remoto' } } } }), /exatamente um/);
  assert.throws(() => validarConfig({ ambientes: { local: { ...base, url: 'http://remoto.example.com:3773' } } }), /loopback/);
  assert.throws(() => validarConfig({ padrao: 'inexistente', ambientes: { local: base } }), /default "inexistente"/);
  assert.throws(() => validarConfig({ ambientes: { a: base, b: base } }), /environmentId repetido/);
});

test('túnel SSH: argumentos fechados, porta de loopback, reuso e recriação após queda', async () => {
  const filhos = [];
  const servidores = [];
  const spawnImpl = (cmd, args) => {
    const filho = new EventEmitter();
    filho.stderr = new EventEmitter();
    filho.exitCode = null;
    const [, porta] = args[args.indexOf('-L') + 1].split(':');
    const s = net.createServer((c) => c.destroy()).listen(Number(porta), '127.0.0.1');
    servidores.push(s);
    filho.kill = () => { s.close(); filho.exitCode = 0; filho.emit('exit', 0); };
    filhos.push({ cmd, args, filho });
    return filho;
  };
  const t = criarTransporteSsh({ host: 'remoto', spawnImpl });
  const url1 = await t.baseUrl();
  assert.match(url1, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(await t.baseUrl(), url1, 'reusa o túnel vivo');
  assert.equal(filhos.length, 1);
  const { cmd, args } = filhos[0];
  assert.equal(cmd, 'ssh');
  assert.ok(args.includes('BatchMode=yes') && args.includes('ExitOnForwardFailure=yes') && args.includes('ForwardAgent=no'));
  assert.ok(args.includes('ControlPath=none') && args.includes('-N'));
  assert.equal(args.at(-1), 'remoto');
  assert.match(args[args.indexOf('-L') + 1], /^127\.0\.0\.1:\d+:127\.0\.0\.1:3773$/);
  filhos[0].filho.kill();
  await t.baseUrl();
  assert.equal(filhos.length, 2, 'recria depois que o ssh saiu');
  t.fechar();
  for (const s of servidores) s.close();
  assert.throws(() => criarTransporteSsh({ host: 'remoto; rm -rf /' }), /invalid SSH host/);
});

test('túnel SSH que não abre vira erro de indisponibilidade com a última linha do ssh', async () => {
  const spawnImpl = () => {
    const filho = new EventEmitter();
    filho.stderr = new EventEmitter();
    filho.kill = () => {};
    setTimeout(() => { filho.stderr.emit('data', 'ssh: connect to host remoto port 22: Operation timed out\n'); filho.emit('exit', 255); }, 10);
    return filho;
  };
  const t = criarTransporteSsh({ host: 'remoto', spawnImpl, prontoEmMs: 2000 });
  await assert.rejects(t.baseUrl(), (e) => e.codigo === 'indisponivel' && /Operation timed out/.test(e.message));
});
