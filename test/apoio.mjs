// Dois environments falsos com IDs que se repetem entre eles, para provar que nada vaza
// de um para o outro: o mesmo threadId existe nos dois, com projetos e estados diferentes.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { criarAmbientes } from '../src/ambientes.mjs';
import { validarConfig } from '../src/config.mjs';
import { criarServidor } from '../src/servidor.mjs';
import { mensagem, pedido, projecao, thread } from './fixtures.mjs';

export const LOCAL = { alias: 'local', environmentId: 'env-local', url: 'http://127.0.0.1:3773', projeto: 'proj-app-local' };
export const REMOTO = { alias: 'remoto', environmentId: 'env-remoto', projeto: 'mcp-project:app-remoto' };
export const PROJETO_ALHEIO = 'proj-alheio';

export function config() {
  return validarConfig({
    default: 'local',
    environments: {
      local: { environmentId: LOCAL.environmentId, url: LOCAL.url, tokenFile: '/tmp/x', allowedProjects: [LOCAL.projeto] },
      remoto: { environmentId: REMOTO.environmentId, ssh: { host: 'remoto' }, tokenFile: '/tmp/y', allowedProjects: [REMOTO.projeto] },
    },
  });
}

export function dadosPadrao() {
  return {
    local: {
      descritor: { orchestrationProtocolVersion: 2, environmentId: LOCAL.environmentId, label: 'local', serverVersion: 'v' },
      escopos: ['orchestration:read'],
      shell: {
        projects: [
          { id: LOCAL.projeto, title: 'app', workspaceRoot: '/Users/dev/app' },
          { id: PROJETO_ALHEIO, title: 'alheio', workspaceRoot: '/Users/dev/alheio' },
        ],
        threads: [
          thread({ id: 't-comum', projectId: LOCAL.projeto, title: 'Comum no Local', status: 'completed' }),
          thread({ id: 't-local', projectId: LOCAL.projeto, status: 'waiting', pendingRuntimeRequest: { id: 'req-1', kind: 'command', createdAt: '2026-10-03T10:04:00.000Z' } }),
          thread({ id: 't-alheia', projectId: PROJETO_ALHEIO, status: 'failed' }),
        ],
      },
      bounded: {
        't-local': { projection: projecao({ pedidos: [pedido()], turnItems: [{ nodeId: 'node-approval-1', title: 'rm -rf build' }], mensagens: [mensagem({ text: 'Vou rodar o build.' })], runs: [{ id: 'run-1', ordinal: 1, status: 'waiting' }] }), hasMoreHistory: false },
        't-comum': { projection: projecao({ mensagens: [mensagem({ text: 'Pronto no Local.' })], runs: [{ id: 'run-1', ordinal: 1, status: 'completed' }] }), hasMoreHistory: false },
      },
    },
    remoto: {
      descritor: { orchestrationProtocolVersion: 2, environmentId: REMOTO.environmentId, label: 'remoto', serverVersion: 'v' },
      escopos: ['orchestration:read'],
      shell: {
        projects: [{ id: REMOTO.projeto, title: 'app', workspaceRoot: '/home/dev/app' }],
        threads: [
          thread({ id: 't-comum', projectId: REMOTO.projeto, title: 'Comum no Remoto', status: 'running', latestRunId: 'run-s1' }),
          thread({ id: 't-llm', projectId: REMOTO.projeto, title: 'Thread remota', status: 'cancelled', latestRunId: 'run-s3' }),
        ],
      },
      bounded: {
        't-llm': { projection: projecao({ mensagens: [mensagem({ text: 'Resposta no Remoto.', runId: 'run-s3' })], runs: [{ id: 'run-s3', ordinal: 3, status: 'cancelled' }] }), hasMoreHistory: true, payloadBudgetExceeded: true },
      },
    },
  };
}

/** Monta o registro de environments com clientes falsos; `chamadas` registra cada leitura. */
export function ambientesFalsos(dados = dadosPadrao(), { chamadas = [] } = {}) {
  const porUrl = { 'http://127.0.0.1:3773': 'local', 'http://127.0.0.1:43773': 'remoto' };
  const cliente = (url) => {
    const nome = porUrl[url];
    const d = dados[nome];
    const reg = (op) => chamadas.push(`${nome}:${op}`);
    return {
      base: new URL(url),
      ambiente: async () => (reg('ambiente'), d.descritor),
      sessao: async () => (reg('sessao'), { scopes: d.escopos }),
      // `shell` pode ser função, para simular falha ou environment que não responde.
      shell: async () => (reg('shell'), typeof d.shell === 'function' ? d.shell() : d.shell),
      thread: async (id) => {
        reg(`thread:${id}`);
        if (!d.bounded[id]) throw Object.assign(new Error('404'), { status: 404 });
        return d.bounded[id];
      },
      // Snapshot completo (settlement); `completo[id]` pode ser função para simular mudança.
      threadCompleto: async (id) => {
        reg(`completo:${id}`);
        const c = d.completo?.[id];
        if (!c) throw Object.assign(new Error('404'), { status: 404 });
        return typeof c === 'function' ? c() : c;
      },
      ticketWs: async () => (reg('ticket'), 'ticket'),
    };
  };
  const transportes = {
    local: { tipo: 'url', baseUrl: async () => 'http://127.0.0.1:3773', descartar() {}, fechar() {} },
    remoto: { tipo: 'ssh', baseUrl: async () => 'http://127.0.0.1:43773', descartar() { chamadas.push('remoto:descartar'); }, fechar() {} },
  };
  return criarAmbientes(config(), {
    criarClienteImpl: ({ url }) => cliente(url),
    lerTokenImpl: async () => 'token',
    transporteImpl: (a) => transportes[a.alias],
  });
}

export async function conectarMcp(ambientes, opcoesBusca, opcoesProviders, opcoesWorkset) {
  const servidor = criarServidor({ ambientes, opcoesBusca, opcoesProviders, opcoesWorkset });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await servidor.connect(a);
  const cliente = new Client({ name: 'teste', version: '0' });
  await cliente.connect(b);
  return cliente;
}

export const dados = (r) => JSON.parse(r.content[0].text);
