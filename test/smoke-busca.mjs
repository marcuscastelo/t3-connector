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
    return { ms, ...(r.isError ? { erro: r.content[0].text } : JSON.parse(r.content[0].text)) };
  };
  return { cliente, chamar };
}

let falhas = 0;
function caso(nome, ok, detalhe) {
  if (!ok) falhas++;
  console.log(`${ok ? 'ok  ' : 'FALHA'} ${nome}: ${JSON.stringify(detalhe)}`);
}
const resumo = (r) => r.erro ? { erro: r.erro, ms: r.ms } : {
  ms: r.ms,
  total: r.total,
  completa: r.completa,
  consultados: r.ambientesConsultados?.map((a) => `${a.alias}:${a.encontradas}`),
  falhas: r.falhasAmbientes?.map((f) => `${f.alias}:${f.codigo}`),
};

// 1. Primeira busca de processos novos: conexão e túnel a frio.
for (let i = 1; i <= rodadasFrias; i++) {
  const { cliente, chamar } = await abrir();
  const r = await chamar('t3_buscar_threads', { busca: 'a', limite: 1 });
  caso(`fria ${i}: busca sem ambiente completa`, !r.erro && r.completa === true, resumo(r));
  const q = await chamar('t3_buscar_threads', { busca: 'a', limite: 1 });
  caso(`fria ${i}: segunda busca (a quente)`, !q.erro && q.completa === true, resumo(q));
  await cliente.close();
}

// 2. Contrato contra dados reais, num processo só.
const { cliente, chamar } = await abrir();
const { tools } = await cliente.listTools();
caso('ferramenta exposta', tools.some((t) => t.name === 't3_buscar_threads'), tools.length);

const amb = await chamar('t3_ambientes', {});
const aliases = amb.ambientes?.map((a) => a.alias) ?? [];
caso('t3_ambientes', aliases.length >= 2 && amb.ambientes.every((a) => a.disponivel), amb.ambientes?.map((a) => ({ alias: a.alias, transporte: a.transporte, disponivel: a.disponivel })));

for (const alias of aliases) {
  const lista = await chamar('t3_threads', { ambiente: alias, limite: 1, incluirSemExecucao: true });
  const alvo = lista.threads?.[0];
  if (!alvo) {
    caso(`${alias}: há thread para procurar`, false, lista.erro ?? { total: lista.total });
    continue;
  }
  const porId = await chamar('t3_buscar_threads', { threadId: alvo.threadId });
  const achou = porId.threads?.filter((t) => t.threadId === alvo.threadId) ?? [];
  caso(`${alias}: threadId sem ambiente volta com o environment certo`,
    !porId.erro && porId.completa && achou.some((t) => t.ambiente.alias === alias && t.ambiente.environmentId === lista.ambiente.environmentId && t.ambiente.nome),
    { ...resumo(porId), threadId: alvo.threadId, ambientes: achou.map((t) => t.ambiente.alias) });

  const exata = await chamar('t3_buscar_threads', { busca: alvo.titulo, correspondencia: 'exata' });
  caso(`${alias}: título exato inclui a thread`, !exata.erro && exata.threads?.some((t) => t.threadId === alvo.threadId && t.ambiente.alias === alias),
    { ...resumo(exata), caracteresTitulo: alvo.titulo?.length ?? 0 });

  const filtrada = await chamar('t3_buscar_threads', { threadId: alvo.threadId, ambiente: alias });
  caso(`${alias}: filtro por ambiente consulta só ele`, !filtrada.erro && filtrada.ambientesConsultados?.length === 1 && filtrada.total >= 1, resumo(filtrada));
}

const ampla = await chamar('t3_buscar_threads', { busca: 'a', limite: 50 });
const ordenada = ampla.threads?.every((t, i, xs) => i === 0
  || [xs[i - 1].ambiente.environmentId, xs[i - 1].threadId].join('\u0000') < [t.ambiente.environmentId, t.threadId].join('\u0000'));
caso('busca ampla: ordem por (environmentId, threadId)', !ampla.erro && ordenada, { ...resumo(ampla), retornadas: ampla.retornadas, truncado: ampla.truncado });
if (ampla.proximoCursor) {
  const p2 = await chamar('t3_buscar_threads', { busca: 'a', limite: 50, cursor: ampla.proximoCursor });
  caso('busca ampla: segunda página', !p2.erro && p2.total === ampla.total, { ...resumo(p2), retornadas: p2.retornadas });
}

const inexistente = await chamar('t3_buscar_threads', { threadId: '00000000-0000-0000-0000-000000000000' });
caso('ID inexistente: zero com cobertura completa', !inexistente.erro && inexistente.total === 0 && inexistente.completa, resumo(inexistente));

await cliente.close();
process.exit(falhas ? 1 : 0);
