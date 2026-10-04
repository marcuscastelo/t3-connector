// Teste ao vivo da busca entre environments (t3_buscar_threads), só leitura. Sobe
// `t3-connector serve` por stdio nos environments configurados e mede a primeira busca de
// um processo novo (conexão e túnel SSH a frio) e as seguintes (a quente). Imprime só
// metadados: aliases, IDs, contagens, códigos de falha e tempos; nunca títulos ou mensagens.
//
//   [SMOKE_RODADAS_FRIAS=3] [T3_CONNECTOR_CMD=<executável>] node test/smoke-busca.mjs
//
// Sai com código 1 se algum caso falhar.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const cmd = process.env.T3_CONNECTOR_CMD;
const rodadasFrias = Number(process.env.SMOKE_RODADAS_FRIAS ?? 3);

async function abrir() {
  const transporte = new StdioClientTransport({
    command: cmd ?? process.execPath,
    args: cmd ? ['serve'] : [path.join(AQUI, '..', 'bin', 't3-connector.mjs'), 'serve'],
    env: { ...process.env },
    stderr: 'pipe',
  });
  const cliente = new Client({ name: 'smoke-busca', version: '0' });
  await cliente.connect(transporte);
  const chamar = async (name, args) => {
    const inicio = performance.now();
    const r = await cliente.callTool({ name, arguments: args });
    const ms = Math.round(performance.now() - inicio);
    return { ms, ...(r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text)) };
  };
  return { cliente, chamar };
}

let falhas = 0;
function caso(nome, ok, detalhe) {
  if (!ok) falhas++;
  console.log(`${ok ? 'ok  ' : 'FALHA'} ${nome}: ${JSON.stringify(detalhe)}`);
}
const resumo = (r) => r.error ? { error: r.error, ms: r.ms } : {
  ms: r.ms,
  total: r.total,
  complete: r.complete,
  consultados: r.queriedEnvironments?.map((a) => `${a.alias}:${a.found}`),
  falhas: r.environmentFailures?.map((f) => `${f.alias}:${f.code}`),
};

// 1. Primeira busca de processos novos: conexão e túnel a frio.
for (let i = 1; i <= rodadasFrias; i++) {
  const { cliente, chamar } = await abrir();
  const r = await chamar('t3_buscar_threads', { search: 'a', limit: 1 });
  caso(`fria ${i}: busca sem ambiente completa`, !r.error && r.complete === true, resumo(r));
  const q = await chamar('t3_buscar_threads', { search: 'a', limit: 1 });
  caso(`fria ${i}: segunda busca (a quente)`, !q.error && q.complete === true, resumo(q));
  await cliente.close();
}

// 2. Contrato contra dados reais, num processo só.
const { cliente, chamar } = await abrir();
const { tools } = await cliente.listTools();
caso('ferramenta exposta', tools.some((t) => t.name === 't3_buscar_threads'), tools.length);

const amb = await chamar('t3_ambientes', {});
const aliases = amb.environments?.map((a) => a.alias) ?? [];
caso('t3_ambientes', aliases.length >= 2 && amb.environments.every((a) => a.available), amb.environments?.map((a) => ({ alias: a.alias, transport: a.transport, available: a.available })));

for (const alias of aliases) {
  const lista = await chamar('t3_threads', { environment: alias, limit: 1, includeNoRun: true });
  const alvo = lista.threads?.[0];
  if (!alvo) {
    caso(`${alias}: há thread para procurar`, false, lista.error ?? { total: lista.total });
    continue;
  }
  const porId = await chamar('t3_buscar_threads', { threadId: alvo.threadId });
  const achou = porId.threads?.filter((t) => t.threadId === alvo.threadId) ?? [];
  caso(`${alias}: threadId sem ambiente volta com o environment certo`,
    !porId.error && porId.complete && achou.some((t) => t.environment.alias === alias && t.environment.environmentId === lista.environment.environmentId && t.environment.name),
    { ...resumo(porId), threadId: alvo.threadId, environments: achou.map((t) => t.environment.alias) });

  const exata = await chamar('t3_buscar_threads', { search: alvo.title, match: 'exact' });
  caso(`${alias}: título exato inclui a thread`, !exata.error && exata.threads?.some((t) => t.threadId === alvo.threadId && t.environment.alias === alias),
    { ...resumo(exata), caracteresTitulo: alvo.title?.length ?? 0 });

  const filtrada = await chamar('t3_buscar_threads', { threadId: alvo.threadId, environment: alias });
  caso(`${alias}: filtro por ambiente consulta só ele`, !filtrada.error && filtrada.queriedEnvironments?.length === 1 && filtrada.total >= 1, resumo(filtrada));
}

const ampla = await chamar('t3_buscar_threads', { search: 'a', limit: 50 });
const ordenada = ampla.threads?.every((t, i, xs) => i === 0
  || [xs[i - 1].environment.environmentId, xs[i - 1].threadId].join('\u0000') < [t.environment.environmentId, t.threadId].join('\u0000'));
caso('busca ampla: ordem por (environmentId, threadId)', !ampla.error && ordenada, { ...resumo(ampla), returned: ampla.returned, truncated: ampla.truncated });
if (ampla.nextCursor) {
  const p2 = await chamar('t3_buscar_threads', { search: 'a', limit: 50, cursor: ampla.nextCursor });
  caso('busca ampla: segunda página', !p2.error && p2.total === ampla.total, { ...resumo(p2), returned: p2.returned });
}

const inexistente = await chamar('t3_buscar_threads', { threadId: '00000000-0000-0000-0000-000000000000' });
caso('ID inexistente: zero com cobertura completa', !inexistente.error && inexistente.total === 0 && inexistente.complete, resumo(inexistente));

await cliente.close();
process.exit(falhas ? 1 : 0);
