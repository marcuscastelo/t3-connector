#!/usr/bin/env node
// Ponte MCP somente leitura para o Orchestrator V2 do T3 Code, com vários environments.
//
//   t3-connector serve                      MCP por stdio (o que o tunnel-client lança)
//   t3-connector ambientes                  environments configurados e se respondem
//   t3-connector diagnostico [--ambiente X] conexão, escopo e projetos, sem MCP
//   t3-connector pair --ambiente X          troca um código de pareamento do T3 desse environment
//                                       por token só de leitura; o código vem da stdin e
//                                       nunca é impresso
//
// Configuração: T3_CONNECTOR_CONFIG (padrão ~/.config/t3-connector/config.json).

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { carregarConfig } from '../src/config.mjs';
import { criarAmbientes } from '../src/ambientes.mjs';
import { criarServidor, VERSAO } from '../src/servidor.mjs';
import { ESCOPO_LEITURA } from '../src/t3.mjs';

// Opções aceitam o nome em inglês e o original: --environment / --ambiente.
const SINONIMOS = { '--ambiente': '--environment' };
function opcao(nome) {
  for (const n of [SINONIMOS[nome], nome].filter(Boolean)) {
    const i = process.argv.indexOf(n);
    if (i > 0) return process.argv[i + 1];
  }
  return undefined;
}

async function abrir() {
  const config = await carregarConfig();
  const ambientes = criarAmbientes(config);
  for (const sinal of ['SIGINT', 'SIGTERM']) process.on(sinal, () => { ambientes.fechar(); process.exit(0); });
  process.on('exit', () => ambientes.fechar());
  return { config, ambientes };
}

async function serve() {
  const { config, ambientes } = await abrir();
  const servidor = criarServidor({ ambientes });
  const transporte = new StdioServerTransport();
  transporte.onclose = () => { ambientes.fechar(); process.exit(0); };
  await servidor.connect(transporte);
  // stdout é do protocolo MCP; diagnóstico vai para stderr. Conexões abrem sob demanda.
  process.stderr.write(
    `t3-connector ${VERSAO}: ambientes ${config.ambientes.map((a) => `${a.alias}(${a.projetosPermitidos.length})`).join(', ')}; padrão ${config.padrao}\n`,
  );
}

async function listarAmbientes() {
  const { ambientes } = await abrir();
  console.log(JSON.stringify({ padrao: ambientes.padrao, ambientes: await ambientes.listar({ verificar: true, prazoMs: 15000 }) }, null, 1));
  ambientes.fechar();
}

async function diagnostico() {
  const { ambientes } = await abrir();
  const alvos = opcao('--ambiente') ? [ambientes.resolver(opcao('--ambiente'))] : ambientes.registros;
  const saida = [];
  for (const r of alvos) {
    try {
      const { cliente, info } = await ambientes.conectar(r);
      const shell = await cliente.shell();
      const projetos = (shell.projects ?? []).filter((p) => r.escopo.projetoPermitido(p.id));
      saida.push({
        ambiente: ambientes.identidade(r),
        nome: info.nome,
        versao: info.versao,
        escopos: info.escopos,
        tokenExpiraEm: info.tokenExpiraEm,
        projetosAutorizados: projetos.map((p) => ({ projectId: p.id, titulo: p.title, diretorio: p.workspaceRoot })),
        projetosConfiguradosInexistentes: [...r.escopo.permitidos].filter((id) => !projetos.some((p) => p.id === id)),
        threadsVisiveis: r.escopo.threadsVisiveis(shell).length,
      });
    } catch (e) {
      saida.push({ ambiente: ambientes.identidade(r), erro: e.message });
    }
  }
  console.log(JSON.stringify(saida, null, 1));
  ambientes.fechar();
  if (saida.some((s) => s.erro || s.projetosConfiguradosInexistentes?.length)) process.exitCode = 1;
}

async function lerStdin() {
  const partes = [];
  for await (const parte of process.stdin) partes.push(parte);
  return Buffer.concat(partes).toString('utf8');
}

function extrairCodigo(bruto) {
  let texto = bruto.trim();
  if (texto.startsWith('{')) {
    const dados = JSON.parse(texto);
    texto = dados.credential ?? dados.pairUrl ?? '';
  }
  if (texto.includes('://')) {
    const url = new URL(texto);
    const params = new URLSearchParams(url.hash.slice(1));
    texto = params.get('token') ?? url.searchParams.get('token') ?? '';
  }
  if (!texto) throw new Error('código de pareamento vazio');
  return texto;
}

async function pair() {
  const alias = opcao('--ambiente');
  if (!alias) throw new Error('uso: t3-connector pair --ambiente <alias>');
  const { ambientes } = await abrir();
  const r = ambientes.resolver(alias);
  if (process.stdin.isTTY) {
    process.stderr.write(`Cole o código ou link de pareamento do T3 de ${r.alias} e termine com Ctrl-D (não é ecoado em log):\n`);
  }
  const codigo = extrairCodigo(await lerStdin());
  const base = await r.transporte.baseUrl();
  const descritor = await (await fetch(new URL('/.well-known/t3/environment', base), { signal: AbortSignal.timeout(15000) })).json();
  if (descritor.environmentId !== r.environmentId) {
    throw new Error(`endpoint de ${r.alias} respondeu como environment ${descritor.environmentId}; esperado ${r.environmentId}`);
  }
  const corpo = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: codigo,
    subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    scope: ESCOPO_LEITURA,
    client_label: `t3-connector (${hostname()})`,
    client_device_type: 'desktop',
  });
  const resposta = await fetch(new URL('/oauth/token', base), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: corpo,
    signal: AbortSignal.timeout(15000),
  });
  if (!resposta.ok) {
    let codigoErro = '';
    try { codigoErro = JSON.stringify(await resposta.json()).slice(0, 200); } catch {}
    throw new Error(`pareamento recusado (${resposta.status}) ${codigoErro}`);
  }
  const resultado = await resposta.json();
  if (resultado.token_type !== 'Bearer') throw new Error(`T3 emitiu token ${resultado.token_type}; a ponte só usa Bearer`);
  if (resultado.scope !== ESCOPO_LEITURA) {
    throw new Error(
      `T3 emitiu escopo "${resultado.scope}" em vez de só ${ESCOPO_LEITURA}; token descartado sem salvar. ` +
        'Revogue a conexão "t3-connector" em T3 → Settings → Connections.',
    );
  }
  await mkdir(path.dirname(r.tokenFile), { recursive: true, mode: 0o700 });
  await writeFile(r.tokenFile, resultado.access_token + '\n', { mode: 0o600 });
  await chmod(r.tokenFile, 0o600);
  const expira = new Date(Date.now() + Number(resultado.expires_in) * 1000).toISOString();
  console.log(`token só de leitura de ${r.alias} salvo em ${r.tokenFile}; expira ${expira}`);
  ambientes.fechar();
}

const comandos = { serve, ambientes: listarAmbientes, diagnostico, pair, environments: listarAmbientes, diagnose: diagnostico };
const comando = process.argv[2] ?? 'serve';
if (comando === '--version') {
  console.log(VERSAO);
} else if (!comandos[comando]) {
  process.stderr.write('usage: t3-connector [serve|environments|diagnose [--environment X]|pair --environment X|--version]\n');
  process.exit(2);
} else {
  comandos[comando]().catch((e) => {
    process.stderr.write(`t3-connector: ${e.message}\n`);
    process.exit(1);
  });
}
