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
import { assinatura, casaBusca, comparador, CursorInvalido, normalizar, paginar, VERSAO_CURSOR } from './paginacao.mjs';

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

function criterio({ search: busca, threadId, match = 'partial' }) {
  if (threadId !== undefined) {
    return { casa: (t) => t.id === threadId, partes: ['threadId', threadId] };
  }
  if (match === 'exact') {
    const alvo = normalizar(busca);
    return { casa: (t) => normalizar(t.title) === alvo || t.id === busca, partes: ['exact', busca] };
  }
  return { casa: (t) => casaBusca(busca, t.title, t.id), partes: ['partial', normalizar(busca)] };
}

/**
 * Lê o shell de cada environment selecionado uma vez, com prazos por environment e total, e
 * devolve as threads visíveis (ACL do environment, sem deletadas) de quem respondeu, mais as
 * falhas de quem não respondeu. O critério de busca é aplicado depois, por quem chamou: a
 * busca em lote aplica várias consultas sobre a mesma leitura.
 */
async function consultarAmbientes(ambientes, selecionados, { signal, prazoAmbienteMs, prazoTotalMs, concorrencia }) {
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
      const visiveis = shell.threads.filter((t) => r.escopo.projetoPermitido(t.projectId) && !t.deletedAt);
      resultados.set(r.environmentId, { ok: true, ambiente, projetos, visiveis });
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
  return { sucesso: ordem.filter((x) => x.ok), falhasAmbientes: ordem.filter((x) => !x.ok).map((x) => x.falha) };
}

/** Itens de um environment que casam o critério, já no formato público. */
function casados(x, casa, resumir) {
  return x.visiveis.filter(casa).map((t) => {
    const item = resumir(t, x.projetos.get(t.projectId));
    return { threadId: item.threadId, title: item.title, environment: x.ambiente, ...item, archived: Boolean(t.archivedAt) };
  });
}

const ordenarSelecionados = (lista) => lista.sort((a, b) => comparador()([a.environmentId], [b.environmentId]));
const chaveItem = (t) => [t.environment.environmentId, t.threadId];

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
  const selecionados = ordenarSelecionados(args.environment !== undefined ? [ambientes.resolver(args.environment)] : [...ambientes.registros]);
  const { sucesso, falhasAmbientes } = await consultarAmbientes(ambientes, selecionados, { signal, prazoAmbienteMs, prazoTotalMs, concorrencia });

  const porAmbiente = sucesso.map((x) => ({ ambiente: x.ambiente, threads: casados(x, casa, resumir) }));
  const comparar = comparador();
  const itens = porAmbiente.flatMap((x) => x.threads).sort((a, b) => comparar(chaveItem(a), chaveItem(b)));

  const filtro = args.environment !== undefined ? selecionados[0].environmentId : null;
  const consulta = assinatura(['t3_buscar_threads', ...partes, filtro, selecionados.map((r) => r.environmentId), sucesso.map((x) => x.ambiente.environmentId)]);
  let pagina;
  try {
    pagina = paginar({ itens, consulta, cursor: args.cursor, limite: args.limit ?? 20, chave: chaveItem, comparar });
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
    queriedEnvironments: porAmbiente.map((x) => ({ ...x.ambiente, found: x.threads.length })),
    environmentFailures: falhasAmbientes,
    threads: pagina.pagina,
  };
}

export const MAX_CONSULTAS = 50;
export const LIMITE_LOTE = 5;

/**
 * Várias consultas (título ou ID) sobre uma única leitura do shell por environment
 * (t3_thread_find_batch). Cada consulta tem resultado, cobertura e cursor próprios; nenhuma
 * escolhe entre candidatos: `resolution` diz se a referência ficou resolvida (um único
 * candidato com cobertura completa), ambígua, ausente no universo lido ou inconclusiva.
 * Entrada estruturalmente inválida recusa a chamada inteira antes de qualquer leitura;
 * cursor inválido é erro só da sua consulta.
 */
export async function buscarThreadsEmLote(ambientes, args, {
  signal,
  resumir,
  prazoAmbienteMs = PRAZO_AMBIENTE_MS,
  prazoTotalMs = PRAZO_TOTAL_MS,
  concorrencia = CONCORRENCIA,
} = {}) {
  const consultas = args.queries ?? [];
  if (!consultas.length || consultas.length > MAX_CONSULTAS) throw new EntradaInvalida(`pass 1-${MAX_CONSULTAS} queries`);
  const vistas = new Set();
  for (const q of consultas) {
    if (vistas.has(q.key)) throw new EntradaInvalida(`duplicate query key "${q.key}"; every key must be unique in the call`);
    vistas.add(q.key);
    try {
      validar(q);
    } catch (e) {
      throw new EntradaInvalida(`query "${q.key}": ${e.message}`);
    }
  }
  const filtrados = args.environments !== undefined;
  if (filtrados && !args.environments.length) throw new EntradaInvalida('`environments` is empty; omit it to search every configured environment');
  const porId = new Map((filtrados ? args.environments.map((e) => ambientes.resolver(e)) : ambientes.registros).map((r) => [r.environmentId, r]));
  const selecionados = ordenarSelecionados([...porId.values()]);
  const { sucesso, falhasAmbientes } = await consultarAmbientes(ambientes, selecionados, { signal, prazoAmbienteMs, prazoTotalMs, concorrencia });

  const completo = falhasAmbientes.length === 0;
  const comparar = comparador();
  const filtro = filtrados ? selecionados.map((r) => r.environmentId) : null;
  const results = consultas.map((q) => {
    const { casa, partes } = criterio(q);
    const porAmbiente = sucesso.map((x) => ({ ambiente: x.ambiente, threads: casados(x, casa, resumir) }));
    const itens = porAmbiente.flatMap((x) => x.threads).sort((a, b) => comparar(chaveItem(a), chaveItem(b)));
    const base = {
      key: q.key,
      ...(q.search !== undefined ? { search: q.search, match: q.match ?? 'partial' } : { threadId: q.threadId }),
    };
    const consulta = assinatura(['t3_thread_find_batch', ...partes, filtro, selecionados.map((r) => r.environmentId), sucesso.map((x) => x.ambiente.environmentId)]);
    let pagina;
    try {
      pagina = paginar({ itens, consulta, cursor: q.cursor, limite: q.limit ?? LIMITE_LOTE, chave: chaveItem, comparar });
    } catch (e) {
      if (!(e instanceof CursorInvalido)) throw e;
      const mudou = q.cursor && mesmaConsultaOutraCobertura(q.cursor, consulta);
      return {
        ...base,
        status: 'error',
        error: mudou
          ? { code: 'cursor_coverage_changed', message: new CoberturaMudou().message }
          : { code: 'cursor_invalid', message: e.message },
      };
    }
    const resolution = itens.length > 1 ? 'ambiguous'
      : !completo ? 'inconclusive'
        : itens.length === 1 ? 'resolved' : 'not_found';
    return {
      ...base,
      status: 'ok',
      resolution,
      total: itens.length,
      returned: pagina.pagina.length,
      truncated: pagina.truncado,
      ...(pagina.proximoCursor ? { nextCursor: pagina.proximoCursor } : {}),
      complete: completo,
      queriedEnvironments: porAmbiente.map((x) => ({ ...x.ambiente, found: x.threads.length })),
      environmentFailures: falhasAmbientes,
      candidates: pagina.pagina,
    };
  });

  const summary = { resolved: 0, ambiguous: 0, not_found: 0, inconclusive: 0, error: 0 };
  for (const r of results) summary[r.status === 'error' ? 'error' : r.resolution]++;
  return {
    returned: results.length,
    complete: completo,
    summary,
    queriedEnvironments: sucesso.map((x) => x.ambiente),
    environmentFailures: falhasAmbientes,
    results,
  };
}

function mesmaConsultaOutraCobertura(cursor, consulta) {
  try {
    const dados = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (dados?.v !== VERSAO_CURSOR || !Array.isArray(dados.k)) return false;
    const q = JSON.parse(dados.q);
    const atual = JSON.parse(consulta);
    return JSON.stringify(q.slice(0, -1)) === JSON.stringify(atual.slice(0, -1))
      && JSON.stringify(q.at(-1)) !== JSON.stringify(atual.at(-1));
  } catch {
    return false;
  }
}
