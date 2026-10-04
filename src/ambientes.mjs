// Registro dos environments configurados: resolve o alias da chamada, conecta sob
// demanda, confere identidade e escopo do token e aplica a ACL daquele environment.
// Não há fallback entre environments: um ID ausente aqui não é procurado em outro.

import { Cancelada, ErroT3, criarCliente, lerToken, verificarConexao } from './t3.mjs';
import { criarTransporteSsh, criarTransporteUrl } from './transporte.mjs';

export class ForaDoEscopo extends Error {}

/** Respeita o sinal de quem chama mesmo quando a promessa é compartilhada com outra chamada. */
function comSinal(promessa, signal, alias) {
  if (!signal) return promessa;
  return new Promise((resolve, reject) => {
    const aoAbortar = () =>
      reject(signal.reason?.name === 'TimeoutError'
        ? new ErroT3(`environment ${alias} did not respond within the call deadline`, { codigo: 'prazo' })
        : new Cancelada());
    if (signal.aborted) return aoAbortar();
    signal.addEventListener('abort', aoAbortar, { once: true });
    promessa.then(resolve, reject).finally(() => signal.removeEventListener('abort', aoAbortar));
  });
}

export function criarEscopo(alias, projetosPermitidos) {
  const permitidos = new Set(projetosPermitidos);
  if (permitidos.size === 0) throw new Error(`${alias}: sem projetosPermitidos; a ponte não expõe nada por padrão`);
  return {
    permitidos,
    projetoPermitido: (projectId) => permitidos.has(projectId),
    threadsVisiveis: (shell) =>
      shell.threads.filter((t) => permitidos.has(t.projectId) && !t.deletedAt && !t.archivedAt),
    exigirProjeto(projectId) {
      if (!permitidos.has(projectId)) {
        throw new ForaDoEscopo(`project ${projectId} is not among the authorized projects of environment ${alias}`);
      }
    },
    exigirThread(shell, threadId) {
      const thread = shell.threads.find((t) => t.id === threadId && !t.deletedAt);
      // Mesma resposta para inexistente e fora do escopo: não revela threads de outros projetos.
      if (!thread || !permitidos.has(thread.projectId)) {
        throw new ForaDoEscopo(`thread ${threadId} not found in the authorized projects of environment ${alias}`);
      }
      return thread;
    },
  };
}

export function criarAmbientes(config, {
  criarClienteImpl = criarCliente,
  lerTokenImpl = lerToken,
  transporteImpl = (a) => (a.ssh ? criarTransporteSsh(a.ssh) : criarTransporteUrl(a.url)),
} = {}) {
  const registros = config.ambientes.map((a) => ({
    ...a,
    escopo: criarEscopo(a.alias, a.projetosPermitidos),
    transporte: transporteImpl(a),
    conexao: null, // Promise<{cliente, info}>
  }));

  function resolver(chave) {
    const alvo = chave ?? config.padrao;
    const r = registros.find((x) => x.alias === alvo || x.environmentId === alvo);
    if (!r) {
      throw new ForaDoEscopo(`environment "${alvo}" is not configured; available: ${registros.map((x) => x.alias).join(', ')}`);
    }
    return r;
  }

  async function abrir(r, signal) {
    const url = await r.transporte.baseUrl({ signal });
    const token = await lerTokenImpl(r.tokenFile);
    const cliente = criarClienteImpl({ url, token });
    const info = await verificarConexao(cliente, { environmentIdEsperado: r.environmentId, signal });
    return { cliente, info };
  }

  /** Conexão verificada do ambiente; reaproveitada entre chamadas até uma falha de transporte. */
  async function conectar(r, { signal } = {}) {
    if (!r.conexao) {
      // A abertura é compartilhada: tem prazo próprio, não o da primeira chamada.
      const conexao = abrir(r, AbortSignal.timeout(20000));
      r.conexao = conexao;
      conexao.catch(() => { if (r.conexao === conexao) r.conexao = null; });
    }
    return comSinal(r.conexao, signal, r.alias);
  }

  /** Executa `fn(cliente)`; se o transporte falhar, descarta a conexão para a próxima chamada reabrir. */
  /**
   * Executa `fn(cliente)`. Todas as ferramentas desta ponte só leem (GET), então, se o
   * transporte caiu (ex.: o ssh até o Remoto morreu e a porta antiga não responde), a
   * conexão é descartada, reaberta e a leitura repetida uma vez.
   */
  async function usar(r, fn, { signal } = {}) {
    for (let tentativa = 0; ; tentativa++) {
      const { cliente, info } = await conectar(r, { signal });
      try {
        return await fn(cliente, info);
      } catch (e) {
        falhou(r, e);
        const repetir = tentativa === 0 && e instanceof ErroT3 && e.codigo === 'indisponivel' && !signal?.aborted;
        if (!repetir) throw e;
      }
    }
  }

  /** Depois de falha de transporte ou de auth, a próxima chamada reabre (e o túnel é recriado). */
  function falhou(r, e) {
    if (e instanceof ErroT3 && (e.codigo === 'indisponivel' || e.status === 401)) {
      r.conexao = null;
      if (e.codigo === 'indisponivel') r.transporte.descartar();
    }
  }

  const identidade = (r) => ({ alias: r.alias, environmentId: r.environmentId });

  return {
    padrao: config.padrao,
    registros,
    resolver,
    conectar,
    usar,
    falhou,
    identidade,
    /** Lista os ambientes configurados; com `verificar`, tenta conectar a cada um dentro do prazo. */
    async listar({ verificar = false, prazoMs = 4000, signal } = {}) {
      return Promise.all(registros.map(async (r) => {
        const item = {
          ...identidade(r),
          default: r.alias === config.padrao,
          transport: r.ssh ? `ssh ${r.ssh.host}` : 'url',
          allowedProjectCount: r.projetosPermitidos.length,
        };
        if (!verificar) return item;
        const limite = AbortSignal.timeout(prazoMs);
        try {
          const { info } = await conectar(r, { signal: signal ? AbortSignal.any([signal, limite]) : limite });
          return { ...item, available: true, name: info.nome, version: info.versao };
        } catch (e) {
          if (e instanceof Cancelada) throw e;
          return { ...item, available: false, error: e.message };
        }
      }));
    },
    fechar() {
      for (const r of registros) r.transporte.fechar();
    },
  };
}
