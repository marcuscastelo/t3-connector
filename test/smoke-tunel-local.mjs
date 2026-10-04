// Ponte através do tunnel-client real com plano de controle local (`tunnel-client dev proxy`):
// mesmo binding stdio e mesmo protocolo de túnel do uso com a OpenAI, sem chave e sem rede externa.
// Só leitura; imprime só metadados. Uso: SMOKE_THREAD_REMOTO=<threadId autorizada no Remoto> node test/smoke-tunel-local.mjs

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const PONTE = path.join(AQUI, '..', 'bin', 't3-connector.mjs');
const dir = await mkdtemp(path.join(tmpdir(), 'ponte-tunel-'));
const urlFile = path.join(dir, 'proxy.json');

const proxy = spawn('tunnel-client', [
  'dev', 'proxy', '--duration', '120s', '--readiness-timeout', '30s',
  '--mcp-command', `${process.execPath} ${PONTE} serve`, '--url-file', urlFile,
], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
proxy.stdout.on('data', (d) => (log += d));
proxy.stderr.on('data', (d) => (log += d));

async function esperarArquivo(ms) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    try { return JSON.parse(await readFile(urlFile, 'utf8')); } catch {}
    if (proxy.exitCode !== null) throw new Error(`proxy saiu (${proxy.exitCode}): ${log.slice(-800)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`proxy não ficou pronto: ${log.slice(-800)}`);
}

try {
  const info = await esperarArquivo(40000);
  const url = info.mcp_url ?? info.mcpUrl ?? info.url ?? Object.values(info).find((v) => typeof v === 'string' && v.startsWith('http'));
  console.log('proxy local pronto; chaves do JSON:', Object.keys(info).join(','), '| tunnel_id:', info.tunnel_id ?? info.tunnelId ?? '?');
  const cliente = new Client({ name: 'smoke-tunel', version: '0' });
  await cliente.connect(new StreamableHTTPClientTransport(new URL(url)));
  const { tools } = await cliente.listTools();
  console.log('ferramentas via túnel local:', tools.map((t) => t.name).join(', '));
  const dados = (r) => (r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text));
  for (const ambiente of ['local', 'remoto']) {
    const p = dados(await cliente.callTool({ name: 't3_projetos', arguments: { environment: ambiente } }));
    console.log(`t3_projetos ${ambiente}:`, JSON.stringify(p.error ? p : p.projects.map((x) => [x.projectId, x.directory])));
  }
  if (process.env.SMOKE_THREAD_REMOTO) {
    const t = dados(await cliente.callTool({ name: 't3_thread', arguments: { environment: 'remoto', threadId: process.env.SMOKE_THREAD_REMOTO, maxCharacters: 200 } }));
    console.log('t3_thread:', JSON.stringify(t.error ? t : {
      title: t.title, project: t.project?.title, directory: t.directory, model: t.model?.model,
      state: t.state, statusRun: t.statusRun, caracteresUltimaResposta: t.latestResponse?.text?.length ?? 0,
    }));
    const w = dados(await cliente.callTool({ name: 't3_aguardar_thread', arguments: { environment: 'remoto', threadId: process.env.SMOKE_THREAD_REMOTO, timeoutMs: 2000 } }));
    console.log('t3_aguardar_thread:', JSON.stringify(w.error ? w : { state: w.state, terminal: w.terminal, timedOut: w.timedOut, elapsedMs: w.elapsedMs }));
  }
  await cliente.close();
} finally {
  proxy.kill('SIGTERM');
  await rm(dir, { recursive: true, force: true });
}
