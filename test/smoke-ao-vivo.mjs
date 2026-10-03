// Teste ao vivo, só leitura: sobe `t3-connector serve` por stdio como o tunnel-client faria e
// chama as ferramentas nos environments configurados. Não cria, envia, aprova nem cancela
// nada. Imprime só metadados (IDs, estados, contagens, tamanhos), nunca texto de mensagens.
//
//   SMOKE_THREAD_REMOTO=<thread autorizada no environment "remoto">
//   SMOKE_THREAD_ATIVA=<thread autorizada com run ativo>   (opcional; testa timeout real)
//   SMOKE_AMBIENTE_ATIVA=<alias da thread ativa>           (padrão local)
//   SMOKE_THREAD_FORA=<thread de projeto não autorizado no Local> (opcional)
//   [T3_CONNECTOR_CMD=<executável>] npm run smoke
//
// Sai com código 1 se algum caso falhar.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const cmd = process.env.T3_CONNECTOR_CMD;
const transporte = new StdioClientTransport({
  command: cmd ?? process.execPath,
  args: cmd ? ['serve'] : [path.join(AQUI, '..', 'bin', 't3-connector.mjs'), 'serve'],
  env: { ...process.env },
  stderr: 'pipe',
});
let stderr = '';
transporte.stderr?.on('data', (d) => (stderr += d));
const cliente = new Client({ name: 'smoke', version: '0' });
await cliente.connect(transporte);

let falhas = 0;
const chamar = async (name, args) => {
  const r = await cliente.callTool({ name, arguments: args });
  return r.isError ? { erro: r.content[0].text } : JSON.parse(r.content[0].text);
};
function caso(nome, ok, detalhe) {
  if (!ok) falhas++;
  console.log(`${ok ? 'ok  ' : 'FALHA'} ${nome}: ${JSON.stringify(detalhe)}`);
}
const semTexto = (u) => (u ? { messageId: u.messageId, runId: u.runId, caracteres: u.texto?.length ?? 0, truncada: u.truncada } : null);

const { tools } = await cliente.listTools();
caso('ferramentas', tools.length === 8, tools.map((t) => t.name));

const amb = await chamar('t3_ambientes', {});
caso('t3_ambientes', amb.ambientes?.every((a) => a.disponivel), amb.ambientes?.map((a) => ({ alias: a.alias, padrao: a.padrao, transporte: a.transporte, disponivel: a.disponivel, versao: a.versao, erro: a.erro })));

for (const ambiente of [undefined, 'local', 'remoto']) {
  const p = await chamar('t3_projetos', ambiente ? { ambiente } : {});
  caso(`t3_projetos ${ambiente ?? '(padrão)'}`, !p.erro && p.projetos.length > 0, p.erro ?? { ambiente: p.ambiente, projetos: p.projetos.map((x) => [x.projectId, x.titulo, x.diretorio, x.threadsRodando]) });
}

const inexistente = await chamar('t3_projetos', { ambiente: 'inexistente' });
caso('ambiente inexistente recusado', Boolean(inexistente.erro), inexistente.erro);

const remoto = process.env.SMOKE_THREAD_REMOTO;
if (remoto) {
  const t = await chamar('t3_thread', { ambiente: 'remoto', threadId: remoto, maxCaracteres: 200 });
  caso('t3_thread no Remoto', !t.erro && t.ambiente.alias === 'remoto', t.erro ?? {
    ambiente: t.ambiente, titulo: t.titulo, projeto: t.projeto, diretorio: t.diretorio, estado: t.estado,
    statusRun: t.statusRun, ultimoRun: t.ultimoRun, historico: t.historico, ultimaResposta: semTexto(t.ultimaResposta),
  });
  const m = await chamar('t3_mensagens', { ambiente: 'remoto', threadId: remoto, limite: 3, maxCaracteres: 100 });
  caso('t3_mensagens no Remoto', !m.erro, m.erro ?? { quantidade: m.mensagens.length, papeis: m.mensagens.map((x) => x.papel), historico: m.historico });
  const noLocal = await chamar('t3_thread', { threadId: remoto });
  caso('mesma thread no Local é recusada', Boolean(noLocal.erro), noLocal.erro);
  const w = await chamar('t3_aguardar_thread', { ambiente: 'remoto', threadId: remoto, timeoutMs: 2000, incluirUltimaResposta: true });
  caso('t3_aguardar_thread no Remoto', !w.erro, w.erro ?? { ...w, ultimaResposta: semTexto(w.ultimaResposta) });
}

const ativa = process.env.SMOKE_THREAD_ATIVA;
if (ativa) {
  const ambiente = process.env.SMOKE_AMBIENTE_ATIVA ?? 'local';
  const w = await chamar('t3_aguardar_thread', { ambiente, threadId: ativa, timeoutMs: 1500 });
  caso('t3_aguardar_thread em run ativo', !w.erro && (w.timedOut || w.terminal || w.estado === 'precisa_intervencao'), w.erro ?? w);
}

const fora = process.env.SMOKE_THREAD_FORA;
if (fora) {
  const r = await chamar('t3_thread', { threadId: fora });
  const w = await chamar('t3_aguardar_thread', { ambiente: 'local', threadId: fora, timeoutMs: 1000 });
  caso('projeto não autorizado recusado (thread e espera)', Boolean(r.erro && w.erro), [r.erro, w.erro]);
}

const naoExiste = await chamar('t3_aguardar_thread', { ambiente: 'remoto', threadId: '00000000-0000-0000-0000-000000000000', timeoutMs: 1000 });
caso('espera em thread inexistente recusada', Boolean(naoExiste.erro), naoExiste.erro);

await cliente.close();
console.log('stderr da ponte:', stderr.trim());
process.exit(falhas ? 1 : 0);
