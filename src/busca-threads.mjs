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
import { validRow } from './escrita/project-admin.mjs';
import { CONTROL_PLANE_CONTRACT_VERSION } from './control-plane.mjs';

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

/** JSON com chaves ordenadas em todos os níveis, para comparar linhas de fontes diferentes. */
const estavel = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/** Shell lida de novo: no OAuth all, `shell` devolve o inventário da invocação (em cache). */
export const lerShellFresca = (cliente, opcoes) => (typeof cliente.shellFresca === 'function' ? cliente.shellFresca(opcoes) : cliente.shell(opcoes));

export const TENTATIVAS_POPULACAO = 3;

/**
 * População ativa + arquivada de um environment (control-plane v1, `population: "all"`): a shell
 * HTTP só traz threads ativas; as arquivadas vêm de `lerArquivadas` (o mesmo snapshot WS
 * `orchestration.getArchivedShellSnapshot` da contagem de projeto). Só é completa com as duas
 * leituras na mesma sequence e todas as linhas válidas; senão `complete: false` com o motivo,
 * nunca uma população menor apresentada como inteira.
 */
async function lerPopulacao(cliente, r, shellInicial, { lerArquivadas, signal }) {
  if (!lerArquivadas) return { shell: shellInicial, arquivadas: [], populacao: { population: 'all', complete: false, reason: 'archived_source_unavailable' } };
  let shell = shellInicial;
  let motivo = 'archived_sequence_mismatch';
  for (let i = 0; i < TENTATIVAS_POPULACAO; i++) {
    if (i > 0) shell = await lerShellFresca(cliente, { signal });
    let arquivo;
    try {
      arquivo = await lerArquivadas(cliente, r, { signal });
    } catch (e) {
      if (signal?.aborted || e instanceof Cancelada) throw e;
      return { shell, arquivadas: [], populacao: { population: 'all', complete: false, reason: 'archived_source_unavailable' } };
    }
    if (!Array.isArray(arquivo?.threads) || !arquivo.threads.every(validRow) || !Number.isInteger(arquivo.snapshotSequence)) {
      return { shell, arquivadas: [], populacao: { population: 'all', complete: false, reason: 'archived_source_invalid' } };
    }
    if (Number.isInteger(shell.snapshotSequence) && arquivo.snapshotSequence === shell.snapshotSequence) {
      return { shell, arquivadas: arquivo.threads, populacao: { population: 'all', complete: true, sequence: shell.snapshotSequence } };
    }
    if (!Number.isInteger(shell.snapshotSequence)) { motivo = 'active_sequence_missing'; break; }
  }
  return { shell, arquivadas: [], populacao: { population: 'all', complete: false, reason: motivo } };
}

/** Rejeita quando `signal` aborta, mesmo que a promessa ignore o sinal. */
export function correrComSinal(promessa, signal) {
  return new Promise((resolve, reject) => {
    const aoAbortar = () => reject(signal.reason);
    if (signal.aborted) return aoAbortar();
    signal.addEventListener('abort', aoAbortar, { once: true });
    promessa.then(resolve, reject).finally(() => signal.removeEventListener('abort', aoAbortar));
  });
}

/** Código e motivo sem detalhes internos (caminho do token, stack, saída do ssh). */
export function falhaSanitizada(e) {
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
async function consultarAmbientes(ambientes, selecionados, { signal, prazoAmbienteMs, prazoTotalMs, concorrencia, populacao = 'active', lerArquivadas = null, validarAtivas = false }) {
  const total = AbortSignal.timeout(prazoTotalMs);
  const resultados = new Map(); // environmentId -> { ok, ... }

  async function consultar(r) {
    const proprio = AbortSignal.timeout(prazoAmbienteMs);
    const sinal = AbortSignal.any([total, proprio, ...(signal ? [signal] : [])]);
    try {
      const { shell, info, arquivadas, estadoPopulacao } = await correrComSinal(
        ambientes.usar(r, async (cliente, info) => {
          const inicial = await cliente.shell({ signal: sinal });
          if (populacao !== 'all') return { shell: inicial, info, arquivadas: [], estadoPopulacao: { population: 'active', complete: true } };
          const lido = await lerPopulacao(cliente, r, inicial, { lerArquivadas, signal: sinal });
          return { shell: lido.shell, info, arquivadas: lido.arquivadas, estadoPopulacao: lido.populacao };
        }, { signal: sinal }),
        sinal,
      );
      const projetos = new Map((shell.projects ?? []).map((p) => [p.id, p]));
      const ambiente = { ...ambientes.identidade(r), name: info?.nome ?? null };
      // Control-plane v1: uma linha ativa que não dá para atribuir (sem projectId, sem status...)
      // seria descartada pela ACL em silêncio; a população fica incompleta, nunca "ausente"
      // (revisão 334a1840, P2). Mesma validação de linha da contagem de projeto.
      let populacaoFinal = estadoPopulacao;
      if (validarAtivas && (!Array.isArray(shell.threads) || !shell.threads.every(validRow))) {
        populacaoFinal = { population: estadoPopulacao.population, complete: false, reason: 'active_source_invalid' };
      }
      // União por ID de TODAS as linhas lidas (ativas e arquivadas, inclusive repetidas dentro
      // de uma fonte): a mesma thread conta uma vez só se todas as linhas concordam na linha
      // inteira (menos o que só diz a fonte: archivedAt). Qualquer divergência não é resolvida
      // escolhendo uma: a população fica incompleta (revisões a8d1170, 737d9be e aacaf76).
      const evidencia = (t) => estavel(Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'archivedAt' && k !== '_arquivada')));
      const porId = new Map();
      const linhas = [
        ...(Array.isArray(shell.threads) ? shell.threads : []).filter(Boolean).map((t) => ({ t, arquivada: false })),
        ...arquivadas.filter(Boolean).map((t) => ({ t, arquivada: true })),
      ];
      for (const { t, arquivada } of linhas) {
        const vista = porId.get(t.id);
        if (!vista) { porId.set(t.id, { t, arquivada, assinatura: evidencia(t) }); continue; }
        if (vista.assinatura !== evidencia(t)) populacaoFinal = { population: estadoPopulacao.population, complete: false, reason: 'population_conflict' };
        if (arquivada) vista.arquivada = true;
      }
      const visiveis = [...porId.values()]
        .filter(({ t }) => r.escopo.projetoPermitido(t.projectId) && !t.deletedAt)
        .map(({ t, arquivada }) => (arquivada && !t.archivedAt ? { ...t, _arquivada: true } : t));
      resultados.set(r.environmentId, { ok: true, ambiente, projetos, visiveis, populacao: populacaoFinal });
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

/**
 * Busca por título prova ausência só se toda linha lida tem título textual e a população do
 * environment é íntegra; senão a resposta é inconclusiva (revisão aacaf76, P2). Vale também
 * para as buscas legadas, que dizem `not_found`/`complete`.
 */
function evidenciaDoCriterio(sucesso, q) {
  if (!sucesso.every((x) => x.populacao.complete)) return false;
  if (q.search === undefined) return true;
  const casa = criterio(q).casa;
  return sucesso.every((x) => x.visiveis.every((t) => casa(t) || typeof t.title === 'string'));
}

/** Itens de um environment que casam o critério, já no formato público. */
function casados(x, casa, resumir) {
  return x.visiveis.filter(casa).map((t) => {
    const item = resumir(t, x.projetos.get(t.projectId));
    return { threadId: item.threadId, title: item.title, environment: x.ambiente, ...item, archived: Boolean(t.archivedAt || t._arquivada) };
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
  const { sucesso, falhasAmbientes } = await consultarAmbientes(ambientes, selecionados, { signal, prazoAmbienteMs, prazoTotalMs, concorrencia, validarAtivas: true });

  const porAmbiente = sucesso.map((x) => ({ ambiente: x.ambiente, threads: casados(x, casa, resumir) }));
  const comparar = comparador();
  const itens = porAmbiente.flatMap((x) => x.threads).sort((a, b) => comparar(chaveItem(a), chaveItem(b)));
  const evidenciaCompleta = evidenciaDoCriterio(sucesso, args);

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
    complete: falhasAmbientes.length === 0 && evidenciaCompleta,
    ...(evidenciaCompleta ? {} : { evidenceIncomplete: true }),
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
export async function buscarThreadsEmLote(ambientes, args, opcoes = {}) {
  if (args.controlPlaneContractVersion !== undefined) return buscarFrentes(ambientes, args, opcoes);
  for (const q of args.queries ?? []) {
    if (q.selector !== undefined || q.relations !== undefined) throw new EntradaInvalida(`query "${q.key}": \`selector\` and \`relations\` need controlPlaneContractVersion: ${CONTROL_PLANE_CONTRACT_VERSION}`);
  }
  if (args.population !== undefined) throw new EntradaInvalida(`\`population\` needs controlPlaneContractVersion: ${CONTROL_PLANE_CONTRACT_VERSION}`);
  return buscarThreadsEmLoteLegado(ambientes, args, opcoes);
}

async function buscarThreadsEmLoteLegado(ambientes, args, {
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
  const { sucesso, falhasAmbientes } = await consultarAmbientes(ambientes, selecionados, { signal, prazoAmbienteMs, prazoTotalMs, concorrencia, validarAtivas: true });

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
    const coberto = completo && evidenciaDoCriterio(sucesso, q);
    const resolution = itens.length > 1 ? 'ambiguous'
      : !coberto ? 'inconclusive'
        : itens.length === 1 ? 'resolved' : 'not_found';
    return {
      ...base,
      status: 'ok',
      resolution,
      total: itens.length,
      returned: pagina.pagina.length,
      truncated: pagina.truncado,
      ...(pagina.proximoCursor ? { nextCursor: pagina.proximoCursor } : {}),
      complete: coberto,
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

// ---------------------------------------------------------------------------------------------
// Control-plane v1: localizar frente (docs/design/control-plane-v1.md §4).

export const RELACOES_MAX_NOS = 50;
export const RELACOES_MAX_PROFUNDIDADE = 4;
const CHAVES_ESPECIFICAS = ['threadId', 'title', 'branch', 'worktreePath', 'pullRequest'];

/** host/repository/number de uma URL de PR (`https://github.com/owner/repo/pull/12`), ou null. */
export function prDaUrl(url) {
  try {
    const u = new URL(url);
    // GitHub /owner/repo/pull/N; GitLab /group/.../project/-/merge_requests/N.
    const m = u.pathname.match(/^\/(.+?)\/-\/merge_requests\/(\d+)\/?$/) ?? u.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/);
    if (!m) return null;
    return { host: u.host.toLowerCase(), repository: m[1].toLowerCase(), number: Number(m[2]) };
  } catch {
    return null;
  }
}

function validarSeletor(q) {
  const sel = q.selector;
  if (!sel || typeof sel !== 'object') throw new EntradaInvalida(`query "${q.key}": pass \`selector\``);
  if (!CHAVES_ESPECIFICAS.some((k) => sel[k] !== undefined)) {
    throw new EntradaInvalida(`query "${q.key}": selector needs at least one of ${CHAVES_ESPECIFICAS.join(', ')} (projectIds alone is not a front)`);
  }
  const r = q.relations;
  if (r && (r.maxDepth !== undefined && (r.maxDepth < 1 || r.maxDepth > RELACOES_MAX_PROFUNDIDADE))) throw new EntradaInvalida(`query "${q.key}": relations.maxDepth is 1-${RELACOES_MAX_PROFUNDIDADE}`);
}

/**
 * Casa uma thread com o seletor (E lógico). `match`, `no` ou `unknown`: campo necessário ausente
 * na linha (ex.: servidor sem `branch` ou PR sem URL estruturada) não prova nem exclui nada.
 */
export function casarSeletor(t, sel, environmentId, projetosAlvo) {
  let desconhecido = false;
  if (sel.threadId !== undefined && t.id !== sel.threadId) return 'no';
  if (sel.title !== undefined) {
    // Título ausente ou não textual não prova nem exclui (revisão a8d1170, P2).
    if (typeof t.title !== 'string') desconhecido = true;
    else {
      const alvo = normalizar(sel.title.value);
      const titulo = normalizar(t.title);
      if ((sel.title.match ?? 'exact') === 'exact' ? titulo !== alvo : !titulo.includes(alvo)) return 'no';
    }
  }
  if (projetosAlvo && !projetosAlvo.has(`${environmentId}\u0000${t.projectId}`)) return 'no';
  // Evidência estrutural: campo ausente ou malformado (tipo errado, PR sem URL atribuível) é
  // desconhecido; só um valor bem formado e diferente exclui (revisão 737d9be, P2).
  for (const campo of ['branch', 'worktreePath']) {
    if (sel[campo] === undefined) continue;
    const v = t[campo];
    if (!(campo in t) || (v !== null && typeof v !== 'string')) desconhecido = true;
    else if (v !== sel[campo]) return 'no';
  }
  if (sel.pullRequest !== undefined) {
    const temLink = 'linkedPullRequest' in t;
    const temLista = 'pullRequests' in t;
    if ((!temLink && !temLista) || (temLista && t.pullRequests !== null && !Array.isArray(t.pullRequests))) desconhecido = true;
    else {
      const links = [...(t.linkedPullRequest != null ? [t.linkedPullRequest] : []), ...(Array.isArray(t.pullRequests) ? t.pullRequests : [])];
      const alvo = { host: sel.pullRequest.host.toLowerCase(), repository: sel.pullRequest.repository.toLowerCase(), number: sel.pullRequest.number };
      let achou = false;
      let linkDesconhecido = false;
      for (const l of links) {
        const pr = typeof l?.url === 'string' ? prDaUrl(l.url) : null;
        // Link que não dá para atribuir a host/repositório/número pode ser o PR procurado.
        if (!pr) { linkDesconhecido = true; continue; }
        if (pr.host === alvo.host && pr.repository === alvo.repository && pr.number === alvo.number) achou = true;
      }
      if (!achou) {
        if (!linkDesconhecido) return 'no';
        desconhecido = true;
      }
    }
  }
  return desconhecido ? 'unknown' : 'match';
}

/** BFS por `lineage.parentThreadId` dentro do environment da raiz; ordem por profundidade e ID. */
export function relacoesDe(raiz, linhas, environmentId, { direction = 'children', maxDepth, limit = 20 } = {}) {
  const profundidade = Math.min(maxDepth ?? (direction === 'children' ? 1 : 2), direction === 'children' ? 1 : RELACOES_MAX_PROFUNDIDADE);
  const teto = Math.min(limit, RELACOES_MAX_NOS);
  // Lineage ausente ou malformado (não objeto, pai não textual) não prova "sem filhos".
  const semLinhagem = linhas.some((t) => !('lineage' in t) || t.lineage === null || typeof t.lineage !== 'object' || Array.isArray(t.lineage)
    || (t.lineage.parentThreadId != null && typeof t.lineage.parentThreadId !== 'string'));
  const filhos = new Map();
  for (const t of linhas) {
    const pai = t.lineage?.parentThreadId;
    if (!pai) continue;
    if (!filhos.has(pai)) filhos.set(pai, []);
    filhos.get(pai).push(t);
  }
  for (const lista of filhos.values()) lista.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const visitados = new Set([raiz]);
  const nodes = [];
  const unresolved = [];
  let fila = [raiz];
  let truncado = false;
  for (let d = 1; d <= profundidade && fila.length; d++) {
    const proxima = [];
    for (const pai of fila) {
      for (const f of filhos.get(pai) ?? []) {
        if (visitados.has(f.id)) { unresolved.push({ environmentId, threadId: f.id, code: 'lineage_cycle' }); continue; }
        if (nodes.length >= teto) { truncado = true; continue; }
        visitados.add(f.id);
        nodes.push({ environmentId, threadId: f.id, parentThreadId: pai, depth: d, relationshipToParent: f.lineage?.relationshipToParent ?? null, archived: Boolean(f.archivedAt || f._arquivada), source: 'shell.lineage' });
        proxima.push(f.id);
      }
    }
    fila = proxima;
  }
  // Ainda há filhos além da profundidade pedida: não é a árvore inteira.
  const alemDoLimite = fila.some((id) => (filhos.get(id) ?? []).length > 0);
  return { complete: !semLinhagem && !truncado && unresolved.length === 0, nodes, unresolved, truncated: truncado, ...(alemDoLimite ? { deeperExists: true } : {}), ...(semLinhagem ? { reason: 'lineage_unavailable' } : {}) };
}

/**
 * find_batch com `controlPlaneContractVersion: 1`: seletores estruturais (E lógico), população
 * `active` ou `all` (ativas + arquivadas validadas), relações e `launchDisposition`. Nenhuma
 * consulta escolhe entre candidatos; ausência só vale com environments, população e campos do
 * seletor completos, e mesmo assim não autoriza escrita.
 */
export async function buscarFrentes(ambientes, args, {
  signal,
  resumir,
  prazoAmbienteMs = PRAZO_AMBIENTE_MS,
  prazoTotalMs = PRAZO_TOTAL_MS,
  concorrencia = CONCORRENCIA,
  lerArquivadas = null,
} = {}) {
  if (args.controlPlaneContractVersion !== CONTROL_PLANE_CONTRACT_VERSION) throw new EntradaInvalida(`contract_version_unsupported: controlPlaneContractVersion ${args.controlPlaneContractVersion}`);
  const consultas = args.queries ?? [];
  if (!consultas.length || consultas.length > MAX_CONSULTAS) throw new EntradaInvalida(`pass 1-${MAX_CONSULTAS} queries`);
  const vistas = new Set();
  for (const q of consultas) {
    if (vistas.has(q.key)) throw new EntradaInvalida(`duplicate query key "${q.key}"; every key must be unique in the call`);
    vistas.add(q.key);
    if (q.selector !== undefined) validarSeletor(q);
    else {
      if (q.relations !== undefined) throw new EntradaInvalida(`query "${q.key}": \`relations\` needs a \`selector\``);
      try { validar(q); } catch (e) { throw new EntradaInvalida(`query "${q.key}": ${e.message}`); }
    }
  }
  const populacao = args.population ?? 'active';
  const filtrados = args.environments !== undefined;
  if (filtrados && !args.environments.length) throw new EntradaInvalida('`environments` is empty; omit it to search every configured environment');
  const porId = new Map((filtrados ? args.environments.map((e) => ambientes.resolver(e)) : ambientes.registros).map((r) => [r.environmentId, r]));
  const selecionados = ordenarSelecionados([...porId.values()]);
  const resolverProjetos = (sel) => (sel?.projectIds ? new Set(sel.projectIds.map((p) => `${ambientes.resolver(p.environment).environmentId}\u0000${p.projectId}`)) : null);
  const alvosPorConsulta = consultas.map((q) => resolverProjetos(q.selector));
  const { sucesso, falhasAmbientes } = await consultarAmbientes(ambientes, selecionados, { signal, prazoAmbienteMs, prazoTotalMs, concorrencia, populacao, lerArquivadas, validarAtivas: true });

  const ambientesCompletos = falhasAmbientes.length === 0;
  const populacaoCompleta = sucesso.every((x) => x.populacao.complete);
  const comparar = comparador();
  const filtro = filtrados ? selecionados.map((r) => r.environmentId) : null;
  const results = consultas.map((q, i) => {
    const base = { key: q.key, ...(q.selector ? { selector: q.selector } : q.search !== undefined ? { search: q.search, match: q.match ?? 'partial' } : { threadId: q.threadId }) };
    let evidenciaCompleta = true;
    const porAmbiente = sucesso.map((x) => {
      let linhas;
      if (q.selector) {
        linhas = x.visiveis.filter((t) => {
          const r = casarSeletor(t, q.selector, x.ambiente.environmentId, alvosPorConsulta[i]);
          if (r === 'unknown') evidenciaCompleta = false;
          return r === 'match';
        });
      } else {
        // `search`/`threadId` no v1 seguem a mesma regra de evidência: sem título textual, uma
        // busca por título não exclui a linha (revisão 737d9be, P2).
        const casa = criterio(q).casa;
        linhas = x.visiveis.filter((t) => {
          if (casa(t)) return true;
          if (q.search !== undefined && typeof t.title !== 'string') evidenciaCompleta = false;
          return false;
        });
      }
      return { x, linhas, threads: linhas.map((t) => { const item = resumir(t, x.projetos.get(t.projectId)); return { threadId: item.threadId, title: item.title, environment: x.ambiente, ...item, archived: Boolean(t.archivedAt || t._arquivada) }; }) };
    });
    const itens = porAmbiente.flatMap((a) => a.threads).sort((a, b) => comparar(chaveItem(a), chaveItem(b)));
    const partes = q.selector ? ['selector', q.selector, q.relations ?? null] : criterio(q).partes;
    const consulta = assinatura(['t3_thread_find_batch', CONTROL_PLANE_CONTRACT_VERSION, populacao, ...partes, filtro, selecionados.map((r) => r.environmentId), sucesso.map((x) => x.ambiente.environmentId)]);
    let pagina;
    try {
      pagina = paginar({ itens, consulta, cursor: q.cursor, limite: q.limit ?? LIMITE_LOTE, chave: chaveItem, comparar });
    } catch (e) {
      if (!(e instanceof CursorInvalido)) throw e;
      const mudou = q.cursor && mesmaConsultaOutraCobertura(q.cursor, consulta);
      return { ...base, status: 'error', error: mudou ? { code: 'cursor_coverage_changed', message: new CoberturaMudou().message } : { code: 'cursor_invalid', message: e.message } };
    }
    const coberto = ambientesCompletos && populacaoCompleta && evidenciaCompleta;
    const resolution = itens.length > 1 ? 'ambiguous' : !coberto ? 'inconclusive' : itens.length === 1 ? 'resolved' : 'not_found';
    const reasons = [];
    if (!ambientesCompletos) reasons.push({ code: 'front_discovery_incomplete', source: 'environments' });
    for (const x of sucesso) if (!x.populacao.complete) reasons.push({ code: x.populacao.reason, environmentId: x.ambiente.environmentId, source: 'population' });
    if (!evidenciaCompleta) reasons.push({ code: 'selector_evidence_unavailable', source: 'shell' });
    if (itens.length === 1) reasons.push({ code: 'front_exists', source: 'shell' });
    if (itens.length > 1) reasons.push({ code: 'front_ambiguous', source: 'shell' });
    if (itens.length === 0 && coberto && populacao === 'active') reasons.push({ code: 'population_active_only', source: 'caller' });
    const launchDisposition = resolution === 'ambiguous' ? 'choose_target'
      : resolution === 'resolved' ? 'continue_existing'
        : resolution === 'not_found' && populacao === 'all' ? 'candidate_new' : 'inconclusive';
    let relations;
    if (q.selector && q.relations) {
      const linhasPorAmbiente = new Map(porAmbiente.map((a) => [a.x.ambiente.environmentId, a.x.visiveis]));
      const arvores = pagina.pagina.map((c) => ({ root: { environmentId: c.environment.environmentId, threadId: c.threadId }, ...relacoesDe(c.threadId, linhasPorAmbiente.get(c.environment.environmentId) ?? [], c.environment.environmentId, q.relations) }));
      relations = { direction: q.relations.direction ?? 'children', complete: coberto && arvores.every((a) => a.complete), trees: arvores };
    }
    return {
      ...base,
      status: 'ok',
      resolution,
      launchDisposition,
      total: itens.length,
      returned: pagina.pagina.length,
      truncated: pagina.truncado,
      ...(pagina.proximoCursor ? { nextCursor: pagina.proximoCursor } : {}),
      complete: coberto,
      coverage: { environmentsComplete: ambientesCompletos, population: populacao, populationComplete: populacaoCompleta, selectorEvidenceComplete: evidenciaCompleta, scope: 'authorized_projects' },
      queriedEnvironments: porAmbiente.map((a) => ({ ...a.x.ambiente, found: a.threads.length })),
      environmentFailures: falhasAmbientes,
      candidates: pagina.pagina,
      ...(relations ? { relations } : {}),
      reasons,
    };
  });

  const summary = { resolved: 0, ambiguous: 0, not_found: 0, inconclusive: 0, error: 0 };
  for (const r of results) summary[r.status === 'error' ? 'error' : r.resolution]++;
  return {
    controlPlaneContractVersion: CONTROL_PLANE_CONTRACT_VERSION,
    returned: results.length,
    complete: ambientesCompletos && populacaoCompleta,
    population: populacao,
    summary,
    queriedEnvironments: sucesso.map((x) => ({ ...x.ambiente, population: x.populacao })),
    environmentFailures: falhasAmbientes,
    results,
  };
}
