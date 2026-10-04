// Busca de thread por título ou ID sem exigir environment (t3_buscar_threads). Consulta o
// shell de cada environment configurado (ou só do filtrado), aplica a ACL de cada um e
// devolve cada candidato com o environment onde ele vive. É descoberta, não roteamento:
// as outras ferramentas continuam sem fallback entre environments, e quem lê ou age
// depois passa o par (environment, threadId) escolhido.
//
// Um environment que falha ou não responde no prazo não derruba a busca: entra em
// `environmentFailures` e `complete` fica false. Zero resultados com `complete: false` não
// prova que a thread não existe.

import { Cancelada, ErroT3 } from './t3.mjs';
import { assinatura, casaBusca, comparador, CursorInvalido, normalizar, paginar } from './paginacao.mjs';

export const PRAZO_AMBIENTE_MS = 4000;
export const PRAZO_TOTAL_MS = 10000;
export const CONCORRENCIA = 4;

export class EntradaInvalida extends Error {}

export class CoberturaMudou extends CursorInvalido {
  constructor() {
    super();
    this.message = 'the environments that answered changed since the first page; repeat the search without a cursor';
  }
}

/** Rejeita quando `signal` aborta, mesmo que a promessa ignore o sinal. */
function correrComSinal(promessa, signal) {
  return new Promise((resolve, reject) => {
    const aoAbortar = () => reject(signal.reason);
    if (signal.aborted) return aoAbortar();
    signal.addEventListener('abort', aoAbortar, { once: true });
    promessa.then(resolve, reject).finally(() => signal.removeEventListener('abort', aoAbortar));
  });
}

/** Código e motivo sem detalhes internos (caminho do token, stack, saída do ssh). */
function falhaSanitizada(e) {
  if (e instanceof ErroT3) {
    if (e.codigo === 'prazo') return { code: 'timeout', reason: 'environment did not respond in time' };
    if (e.codigo === 'indisponivel') return { code: 'unavailable', reason: 'T3 unavailable in this environment' };
    if (e.codigo === 'environment_divergente') return { code: 'environment_mismatch', reason: 'endpoint answered as another environment' };
    if (e.status === 401 || e.status === 403) return { code: `http_${e.status}`, reason: 'T3 refused the token of this environment' };
    if (e.status) return { code: `http_${e.status}`, reason: `T3 answered ${e.status}` };
    return { code: 'connection_refused', reason: 'connection refused (token, scope or protocol); see t3_ambientes' };
  }
  return { code: 'failed', reason: 'failed to query the environment' };
}

function validar({ search: busca, threadId, match }) {
  const temBusca = busca !== undefined;
  const temId = threadId !== undefined;
  if (temBusca === temId) throw new EntradaInvalida('pass exactly one of `search` and `threadId`');
  if (temBusca && !busca.trim()) throw new EntradaInvalida('`search` is empty');
  if (temId && match !== undefined) throw new EntradaInvalida('`match` only applies to `search`; `threadId` is always exact');
}

// As partes da assinatura do cursor mantêm os rótulos antigos (parcial/exata): um cursor
// emitido antes da troca dos nomes dos parâmetros continua valendo.
function criterio({ search: busca, threadId, match = 'partial' }) {
  if (threadId !== undefined) {
    return { casa: (t) => t.id === threadId, partes: ['threadId', threadId] };
  }
  if (match === 'exact') {
    const alvo = normalizar(busca);
    return { casa: (t) => normalizar(t.title) === alvo || t.id === busca, partes: ['exata', busca] };
  }
  return { casa: (t) => casaBusca(busca, t.title, t.id), partes: ['parcial', normalizar(busca)] };
}

/**
 * `resumir(thread, projeto)` monta o item (injetado pelo servidor). Prazos e concorrência
 * são parâmetros para os testes; os padrões são o contrato.
 */
export async function buscarThreads(ambientes, args, {
  signal,
  resumir,
  prazoAmbienteMs = PRAZO_AMBIENTE_MS,
  prazoTotalMs = PRAZO_TOTAL_MS,
  concorrencia = CONCORRENCIA,
} = {}) {
  validar(args);
  const { casa, partes } = criterio(args);
  const selecionados = (args.environment !== undefined ? [ambientes.resolver(args.environment)] : [...ambientes.registros])
    .sort((a, b) => comparador()([a.environmentId], [b.environmentId]));

  const total = AbortSignal.timeout(prazoTotalMs);
  const resultados = new Map(); // environmentId -> { ok, ... }

  async function consultar(r) {
    const proprio = AbortSignal.timeout(prazoAmbienteMs);
    const sinal = AbortSignal.any([total, proprio, ...(signal ? [signal] : [])]);
    try {
      const { shell, info } = await correrComSinal(
        ambientes.usar(r, async (cliente, info) => ({ shell: await cliente.shell({ signal: sinal }), info }), { signal: sinal }),
        sinal,
      );
      const projetos = new Map((shell.projects ?? []).map((p) => [p.id, p]));
      const ambiente = { ...ambientes.identidade(r), name: info?.nome ?? null };
      const threads = shell.threads
        .filter((t) => r.escopo.projetoPermitido(t.projectId) && !t.deletedAt && casa(t))
        .map((t) => {
          const item = resumir(t, projetos.get(t.projectId));
          return { threadId: item.threadId, title: item.title, environment: ambiente, ...item, archived: Boolean(t.archivedAt) };
        });
      resultados.set(r.environmentId, { ok: true, ambiente, threads });
    } catch (e) {
      if (signal?.aborted || e instanceof Cancelada) throw new Cancelada();
      const falha = total.aborted
        ? { code: 'global_timeout', reason: 'the search reached its total deadline before this environment answered' }
        : proprio.aborted ? { code: 'timeout', reason: 'environment did not respond in time' } : falhaSanitizada(e);
      resultados.set(r.environmentId, { ok: false, falha: { ...ambientes.identidade(r), ...falha } });
    }
  }

  let proximo = 0;
  const trabalhadores = Array.from({ length: Math.min(concorrencia, selecionados.length) }, async () => {
    while (proximo < selecionados.length) {
      const r = selecionados[proximo++];
      if (signal?.aborted) throw new Cancelada();
      if (total.aborted) {
        resultados.set(r.environmentId, {
          ok: false,
          falha: { ...ambientes.identidade(r), code: 'global_timeout', reason: 'the search reached its total deadline before querying this environment' },
        });
        continue;
      }
      await consultar(r);
    }
  });
  await Promise.all(trabalhadores);

  const ordem = selecionados.map((r) => resultados.get(r.environmentId));
  const sucesso = ordem.filter((x) => x.ok);
  const falhasAmbientes = ordem.filter((x) => !x.ok).map((x) => x.falha);
  const chave = (t) => [t.environment.environmentId, t.threadId];
  const comparar = comparador();
  const itens = sucesso.flatMap((x) => x.threads).sort((a, b) => comparar(chave(a), chave(b)));

  const filtro = args.environment !== undefined ? selecionados[0].environmentId : null;
  const consulta = assinatura(['t3_buscar_threads', ...partes, filtro, selecionados.map((r) => r.environmentId), sucesso.map((x) => x.ambiente.environmentId)]);
  let pagina;
  try {
    pagina = paginar({ itens, consulta, cursor: args.cursor, limite: args.limit ?? 20, chave, comparar });
  } catch (e) {
    // Mesma consulta com outra cobertura: diz por que o cursor deixou de valer.
    if (e instanceof CursorInvalido && args.cursor && mesmaConsultaOutraCobertura(args.cursor, consulta)) throw new CoberturaMudou();
    throw e;
  }

  return {
    total: itens.length,
    ...(args.search !== undefined ? { search: args.search, match: args.match ?? 'partial' } : { threadId: args.threadId }),
    returned: pagina.pagina.length,
    truncated: pagina.truncado,
    complete: falhasAmbientes.length === 0,
    ...(pagina.proximoCursor ? { nextCursor: pagina.proximoCursor } : {}),
    queriedEnvironments: sucesso.map((x) => ({ ...x.ambiente, found: x.threads.length })),
    environmentFailures: falhasAmbientes,
    threads: pagina.pagina,
  };
}

function mesmaConsultaOutraCobertura(cursor, consulta) {
  try {
    const q = JSON.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).q);
    const atual = JSON.parse(consulta);
    return JSON.stringify(q.slice(0, -1)) === JSON.stringify(atual.slice(0, -1));
  } catch {
    return false;
  }
}
