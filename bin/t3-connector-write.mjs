#!/usr/bin/env node
// Escrita da T3 Connector: gate de aprovação por passkey e MCP de escrita, com environments.
//
//   t3-connector-write gate                       gate + página de aprovação (localhost:<porta>)
//   t3-connector-write bridge                     MCP stdio do plugin de escrita (o tunnel-client lança)
//   t3-connector-write diagnostico [--projetos]   identidade, escopos read+operate e inventário de cada environment
//   t3-connector-write pair --ambiente X          troca código de pareamento do T3 de X por token
//                                               read+operate; o código vem da stdin, nunca impresso
//
// Configuração: T3_CONNECTOR_WRITE_CONFIG (padrão ~/.config/t3-connector/write.json).

import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { lstatSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { carregarConfigEscrita, resolverAmbiente } from '../src/escrita/config.mjs';
import { criarConexaoEscrita, ESCOPOS_ESCRITA } from '../src/escrita/conexao.mjs';
import { iniciarGate } from '../src/escrita/servidor-gate.mjs';
import { criarPonteEscrita, relayHttp, VERSAO_ESCRITA } from '../src/escrita/ponte-mcp.mjs';
import { criarTransporteSsh, criarTransporteUrl } from '../src/transporte.mjs';

// Opções aceitam o nome em inglês e o original: --environment / --ambiente, --projects / --projetos.
const SINONIMOS = { '--ambiente': '--environment', '--projetos': '--projects' };
const temOpcao = (nome) => [SINONIMOS[nome], nome].some((n) => n && process.argv.includes(n));
const opcao = (nome) => { for (const n of [SINONIMOS[nome], nome].filter(Boolean)) { const i = process.argv.indexOf(n); if (i > 0) return process.argv[i + 1]; } return undefined; };

async function gate() {
  const config = await carregarConfigEscrita();
  const g = await iniciarGate(config);
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { g.fechar(); process.exit(0); });
}

async function bridge() {
  const config = await carregarConfigEscrita();
  const arquivo = join(config.estado, 'relay-capability');
  const lerCapability = () => {
    const s = lstatSync(arquivo);
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077)) throw new Error('relay_unavailable');
    return readFileSync(arquivo, 'utf8');
  };
  const server = criarPonteEscrita({
    relay: relayHttp({ porta: config.porta, lerCapability }),
    aliases: config.ambientes.map((a) => a.alias),
    approvalOrigin: `http://localhost:${config.porta}`,
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`t3-connector-write ${VERSAO_ESCRITA}: ambientes ${config.ambientes.map((a) => a.alias).join(', ')}; gate localhost:${config.porta}\n`);
}

async function diagnostico() {
  const config = await carregarConfigEscrita();
  const saida = [];
  for (const r of config.ambientes) {
    const c = criarConexaoEscrita(r);
    try {
      const info = await c.verificar();
      const projetos = await c.inventario();
      saida.push({ environment: { alias: r.alias, environmentId: r.environmentId }, version: info.versao, scopes: info.escopos, tokenExpiresAt: info.tokenExpiraEm,
        projectCount: projetos.length, actionCount: r.acoes.length,
        ...(temOpcao('--projetos') ? { inventory: projetos.map((p) => ({ projectId: p.id, name: p.name, directory: p.directory })) } : {}) });
    } catch (e) {
      saida.push({ environment: { alias: r.alias, environmentId: r.environmentId }, error: e.message });
    } finally { c.fechar(); }
  }
  console.log(JSON.stringify(saida, null, 1));
  if (saida.some((s) => s.error)) process.exitCode = 1;
}

async function pair() {
  const config = await carregarConfigEscrita();
  const r = resolverAmbiente(config.ambientes, opcao('--ambiente'));
  const partes = [];
  for await (const p of process.stdin) partes.push(p);
  let codigo = Buffer.concat(partes).toString('utf8').trim();
  if (codigo.startsWith('{')) codigo = JSON.parse(codigo).credential ?? '';
  if (!codigo) throw new Error('código de pareamento vazio');
  const transporte = r.ssh ? criarTransporteSsh(r.ssh) : criarTransporteUrl(r.url);
  try {
    const base = await transporte.baseUrl();
    const desc = await (await fetch(new URL('/.well-known/t3/environment', base), { signal: AbortSignal.timeout(15000) })).json();
    if (desc.environmentId !== r.environmentId) throw new Error(`endpoint de ${r.alias} respondeu como ${desc.environmentId}; esperado ${r.environmentId}`);
    const resposta = await fetch(new URL('/oauth/token', base), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: codigo,
        subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap', requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        scope: ESCOPOS_ESCRITA.join(' '), client_label: `t3-connector-write (${hostname()})`, client_device_type: 'desktop' }),
    });
    if (!resposta.ok) throw new Error(`pareamento recusado (${resposta.status})`);
    const resultado = await resposta.json();
    if (resultado.token_type !== 'Bearer' || [...(resultado.scope ?? '').split(' ')].sort().join(' ') !== ESCOPOS_ESCRITA.join(' ')) {
      throw new Error(`T3 emitiu escopo "${resultado.scope}"; token descartado sem salvar`);
    }
    const dir = dirname(r.tokenFile);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `.token-${process.pid}`);
    await writeFile(temp, resultado.access_token + '\n', { mode: 0o600, flag: 'wx' });
    await chmod(temp, 0o600);
    await rename(temp, r.tokenFile);
    const c = criarConexaoEscrita(r, { transporte });
    const info = await c.verificar();
    console.log(JSON.stringify({ savedTo: r.tokenFile, environment: r.alias, environmentId: info.environmentId, scopes: info.escopos, expiresAt: info.tokenExpiraEm }));
  } finally { transporte.fechar(); }
}

const comandos = { gate, bridge, diagnostico, pair, diagnose: diagnostico };
const comando = process.argv[2];
if (comando === '--version') console.log(VERSAO_ESCRITA);
else if (!comandos[comando]) { process.stderr.write('usage: t3-connector-write [gate|bridge|diagnose [--projects]|pair --environment X|--version]\n'); process.exit(2); }
else comandos[comando]().catch((e) => { process.stderr.write(`t3-connector-write: ${e.message}\n`); process.exit(1); });
