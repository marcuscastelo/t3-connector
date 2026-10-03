// Cliente somente leitura da API de environment do T3 (Orchestrator V2).
//
// Rotas e escopo (commit 8ed276c2):
// - GET /api/orchestration/shell e /api/orchestration/threads/:id/bounded exigem o header
//   x-t3-orchestration-protocol: 2 (packages/contracts/src/environmentHttp.ts:66-70, 526-577)
//   e o escopo orchestration:read (apps/server/src/orchestration-v2/http.ts:175-222);
// - GET /api/projects exige orchestration:read (apps/server/src/project/http.ts:44);
// - GET /api/auth/session devolve os escopos do token em uso;
// - POST /api/auth/websocket-ticket troca o bearer por um ticket de uso único para /ws
//   (auth/EnvironmentAuth.ts:1075-1094), para o bearer não ir na URL.
// Nenhuma rota de mutação é chamada.

import { readFile, stat } from 'node:fs/promises';

const PROTOCOLO = '2';
export const ESCOPO_LEITURA = 'orchestration:read';

export class ErroT3 extends Error {
  constructor(mensagem, { status = null, codigo = null } = {}) {
    super(mensagem);
    this.status = status;
    this.codigo = codigo;
  }
}

export class Cancelada extends Error {
  constructor() {
    super('chamada cancelada pelo cliente');
  }
}

export function validarUrl(url) {
  const u = new URL(url);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    throw new ErroT3('URL do T3 precisa ser HTTPS ou HTTP de loopback');
  }
  return u;
}

export async function lerToken(caminho) {
  const info = await stat(caminho).catch(() => null);
  if (!info) throw new ErroT3(`token ausente em ${caminho}; rode \`t3-connector pair\``);
  if (info.mode & 0o077) throw new ErroT3(`token em ${caminho} precisa ter modo 600`);
  const token = (await readFile(caminho, 'utf8')).trim();
  if (!token) throw new ErroT3(`token vazio em ${caminho}`);
  return token;
}

/** Junta o sinal do chamador com o timeout próprio da requisição. */
export function sinalCom(signal, timeoutMs) {
  const limite = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, limite]) : limite;
}

export function criarCliente({ url, token, timeoutMs = 15000, fetchImpl = fetch }) {
  const base = validarUrl(url);

  async function pedir(caminho, { orquestracao = false, metodo = 'GET', signal } = {}) {
    const headers = { authorization: `Bearer ${token}` };
    if (orquestracao) headers['x-t3-orchestration-protocol'] = PROTOCOLO;
    let resposta;
    try {
      resposta = await fetchImpl(new URL(caminho, base), { method: metodo, headers, signal: sinalCom(signal, timeoutMs) });
    } catch (erro) {
      // Prazo de quem chama não é falha do servidor: não derruba conexão nem túnel.
      if (signal?.aborted) throw signal.reason?.name === 'TimeoutError' ? new ErroT3('prazo da chamada esgotado', { codigo: 'prazo' }) : new Cancelada();
      throw new ErroT3(`T3 indisponível em ${base.origin} (${erro.name})`, { codigo: 'indisponivel' });
    }
    if (!resposta.ok) {
      let codigo = null;
      try {
        const corpo = await resposta.json();
        codigo = corpo?.code ?? corpo?.error ?? corpo?._tag ?? null;
      } catch {}
      throw new ErroT3(`T3 respondeu ${resposta.status} em ${caminho.split('?')[0]}`, { status: resposta.status, codigo });
    }
    return resposta.json();
  }

  return {
    base,
    ambiente: (o) => pedir('/.well-known/t3/environment', o),
    sessao: (o) => pedir('/api/auth/session', o),
    projetos: (o) => pedir('/api/projects', o),
    shell: (o) => pedir('/api/orchestration/shell', { ...o, orquestracao: true }),
    thread: (threadId, o) =>
      pedir(`/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`, { ...o, orquestracao: true }),
    ticketWs: async (o) => (await pedir('/api/auth/websocket-ticket', { ...o, metodo: 'POST' })).ticket,
  };
}

/**
 * Confere o servidor antes de usá-lo: protocolo 2, environmentId esperado (um endpoint
 * que responde como outro environment falha fechado) e escopos do token exatamente iguais
 * a `escoposExatos`.
 */
export async function verificarIdentidade(cliente, { environmentIdEsperado, escoposExatos, signal } = {}) {
  const ambiente = await cliente.ambiente({ signal });
  if (ambiente.orchestrationProtocolVersion !== 2) {
    throw new ErroT3(`servidor T3 com protocolo ${ambiente.orchestrationProtocolVersion}; a ponte exige 2`);
  }
  if (environmentIdEsperado && ambiente.environmentId !== environmentIdEsperado) {
    throw new ErroT3(
      `endpoint respondeu como environment ${ambiente.environmentId} (${ambiente.label}); esperado ${environmentIdEsperado}`,
      { codigo: 'environment_divergente' },
    );
  }
  const sessao = await cliente.sessao({ signal });
  const escopos = sessao.scopes ?? [];
  const faltando = escoposExatos.filter((e) => !escopos.includes(e));
  if (faltando.length) throw new ErroT3(`token sem o escopo ${faltando.join(', ')}`);
  const extras = escopos.filter((e) => !escoposExatos.includes(e));
  if (extras.length) throw new ErroT3(`token com escopos a mais (${extras.join(', ')})`, { codigo: 'escopo_amplo' });
  return {
    environmentId: ambiente.environmentId,
    nome: ambiente.label,
    versao: ambiente.serverVersion,
    escopos,
    tokenExpiraEm: sessao.expiresAt ?? null,
  };
}

/** Leitura: token com exatamente orchestration:read. */
export async function verificarConexao(cliente, { environmentIdEsperado, signal } = {}) {
  try {
    return await verificarIdentidade(cliente, { environmentIdEsperado, escoposExatos: [ESCOPO_LEITURA], signal });
  } catch (e) {
    if (e.codigo === 'escopo_amplo') {
      throw new ErroT3(`${e.message.replace('escopos a mais', 'escopos além de leitura')}; gere um token só de leitura com \`t3-connector pair\``);
    }
    throw e;
  }
}
