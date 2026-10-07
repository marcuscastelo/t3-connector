// Teste ao vivo, só leitura: sobe `t3-connector serve` por stdio como o tunnel-client faria e
// chama as ferramentas nos environments configurados. Não cria, envia, aprova nem cancela
// nada. Imprime só metadados (IDs, estados, contagens, tamanhos), nunca texto de mensagens.
//
//   SMOKE_THREAD_REMOTO=<thread autorizada no environment remoto>
//   SMOKE_AMBIENTE_REMOTO=<alias do environment remoto>    (padrão: o primeiro que não é o default)
//   SMOKE_THREAD_ATIVA=<thread autorizada com run ativo>   (opcional; testa timeout real)
//   SMOKE_AMBIENTE_ATIVA=<alias da thread ativa>           (padrão: o default da config)
//   SMOKE_THREAD_FORA=<thread de projeto não autorizado no default> (opcional)
//
// Os aliases vêm de t3_ambientes, ou seja, da config em uso (T3_CONNECTOR_CONFIG ou a
// instalada); nenhum nome de environment é fixo aqui.
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
  return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
};
function caso(nome, ok, detalhe) {
  if (!ok) falhas++;
  console.log(`${ok ? 'ok  ' : 'FALHA'} ${nome}: ${JSON.stringify(detalhe)}`);
}
const semTexto = (u) => (u ? { messageId: u.messageId, runId: u.runId, caracteres: u.text?.length ?? 0, truncated: u.truncated } : null);

const { tools } = await cliente.listTools();
caso('ferramentas', tools.length === 9, tools.map((t) => t.name));

const amb = await chamar('t3_ambientes', {});
caso('t3_ambientes', amb.environments?.every((a) => a.available) && !('default' in amb), amb.environments?.map((a) => ({ alias: a.alias, transport: a.transport, available: a.available, version: a.version, error: a.error })));

const aliases = (amb.environments ?? []).map((a) => a.alias);
const padrao = aliases[0];
const nomeRemoto = process.env.SMOKE_AMBIENTE_REMOTO ?? aliases.find((a) => a !== padrao);
caso('config com dois environments', Boolean(padrao && nomeRemoto && aliases.includes(nomeRemoto)), { local: padrao, remoto: nomeRemoto, aliases });

// Sem environment: varre todos; cada projeto diz de onde veio e a resposta diz se foi completa.
const todos = await chamar('t3_projetos', {});
caso('t3_projetos (todos os environments)', !todos.error && todos.complete === true && todos.queriedEnvironments?.length === aliases.length && todos.projects.every((x) => x.environment?.alias),
  todos.error ?? { complete: todos.complete, queried: todos.queriedEnvironments, failures: todos.environmentFailures, projects: todos.projects.map((x) => [x.environment.alias, x.projectId, x.title, x.runningThreads]) });
for (const ambiente of aliases) {
  const p = await chamar('t3_projetos', { environment: ambiente });
  caso(`t3_projetos ${ambiente}`, !p.error && p.projects.length > 0, p.error ?? { environment: p.environment, projects: p.projects.map((x) => [x.projectId, x.title, x.directory, x.runningThreads]) });
}

for (const alias of aliases) {
  const p = await chamar('t3_providers', { environment: alias });
  caso(`t3_providers ${alias}`, !p.error && p.total > 0 && p.providers.every((x) => x.instanceId), p.error ?? {
    environment: p.environment,
    providers: p.providers.map((x) => [x.instanceId, x.driver, x.displayName, x.status]),
  });
}

const inexistente = await chamar('t3_projetos', { environment: 'inexistente' });
caso('ambiente inexistente recusado', Boolean(inexistente.error), inexistente.error);

const remoto = process.env.SMOKE_THREAD_REMOTO;
if (remoto) {
  const t = await chamar('t3_thread', { environment: nomeRemoto, threadId: remoto, maxCharacters: 200 });
  caso('t3_thread no Remoto', !t.error && t.environment.alias === nomeRemoto, t.error ?? {
    environment: t.environment, title: t.title, project: t.project, directory: t.directory, state: t.state,
    statusRun: t.statusRun, latestRun: t.latestRun, history: t.history, latestResponse: semTexto(t.latestResponse),
  });
  const m = await chamar('t3_mensagens', { environment: nomeRemoto, threadId: remoto, limit: 3, maxCharacters: 100 });
  caso('t3_mensagens no Remoto', !m.error, m.error ?? { quantidade: m.messages.length, papeis: m.messages.map((x) => x.role), history: m.history });
  const noLocal = await chamar('t3_thread', { threadId: remoto });
  caso('mesma thread no Local é recusada', Boolean(noLocal.error), noLocal.error);
  const w = await chamar('t3_aguardar_thread', { environment: nomeRemoto, threadId: remoto, timeoutMs: 2000, includeLatestResponse: true });
  caso('t3_aguardar_thread no Remoto', !w.error, w.error ?? { ...w, latestResponse: semTexto(w.latestResponse) });
}

const ativa = process.env.SMOKE_THREAD_ATIVA;
if (ativa) {
  const ambiente = process.env.SMOKE_AMBIENTE_ATIVA ?? padrao;
  const w = await chamar('t3_aguardar_thread', { environment: ambiente, threadId: ativa, timeoutMs: 1500 });
  caso('t3_aguardar_thread em run ativo', !w.error && (w.timedOut || w.terminal || w.state === 'needs_intervention'), w.error ?? w);
}

const fora = process.env.SMOKE_THREAD_FORA;
if (fora) {
  const r = await chamar('t3_thread', { threadId: fora });
  const w = await chamar('t3_aguardar_thread', { environment: padrao, threadId: fora, timeoutMs: 1000 });
  caso('projeto não autorizado recusado (thread e espera)', Boolean(r.error && w.error), [r.error, w.error]);
}

const naoExiste = await chamar('t3_aguardar_thread', { environment: nomeRemoto, threadId: '00000000-0000-0000-0000-000000000000', timeoutMs: 1000 });
caso('espera em thread inexistente recusada', Boolean(naoExiste.error), naoExiste.error);

await cliente.close();
console.log('stderr da ponte:', stderr.trim());
process.exit(falhas ? 1 : 0);
