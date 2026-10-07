// Busca de thread por título ou ID sem exigir environment (t3_buscar_threads). Consulta o
// shell de cada environment configurado (ou só do filtrado), aplica a ACL de cada um e
// devolve cada candidato com o environment onde ele vive. É descoberta, não roteamento:
// quem lê ou age depois passa o par (environment, threadId) escolhido.
//
// A varredura (prazos, concorrência, falhas por environment, cobertura do cursor) está em
// varredura.mjs e é a mesma das listagens. Um environment que falha ou não responde entra
// em `environmentFailures` e `complete` fica false: zero resultados com `complete: false`
// não prova que a thread não existe.

import { assinaturaCoberta, resumoCobertura, traduzirCursorInvalido, varrerAmbientes } from './varredura.mjs';
import { casaBusca, comparador, normalizar, paginar } from './paginacao.mjs';

export { CoberturaMudou, CONCORRENCIA, EntradaInvalida, PRAZO_AMBIENTE_MS, PRAZO_TOTAL_MS } from './varredura.mjs';
import { EntradaInvalida } from './varredura.mjs';

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
 * `resumir(thread, projeto)` monta o item (injetado pelo servidor). Prazos e concorrência
 * são parâmetros para os testes; os padrões são o contrato.
 */
export async function buscarThreads(ambientes, args, { signal, resumir, ...prazos } = {}) {
  validar(args);
  const { casa, partes } = criterio(args);

  const varredura = await varrerAmbientes(ambientes, {
    environment: args.environment,
    signal,
    ...prazos,
    async porAmbiente(r, cliente, info, sinal) {
      const shell = await cliente.shell({ signal: sinal });
      const projetos = new Map((shell.projects ?? []).map((p) => [p.id, p]));
      const ambiente = { ...ambientes.identidade(r), name: info?.nome ?? null };
      return shell.threads
        .filter((t) => r.escopo.projetoPermitido(t.projectId) && !t.deletedAt && casa(t))
        .map((t) => {
          const item = resumir(t, projetos.get(t.projectId));
          return { threadId: item.threadId, title: item.title, environment: ambiente, ...item, archived: Boolean(t.archivedAt) };
        });
    },
  });

  const chave = (t) => [t.environment.environmentId, t.threadId];
  const comparar = comparador();
  const itens = varredura.sucesso.flatMap((x) => x.valor).sort((a, b) => comparar(chave(a), chave(b)));
  const consulta = assinaturaCoberta(['t3_buscar_threads', ...partes], varredura.cobertura);
  let pagina;
  try {
    pagina = paginar({ itens, consulta, cursor: args.cursor, limite: args.limit ?? 20, chave, comparar });
  } catch (e) {
    throw traduzirCursorInvalido(e, args.cursor, consulta);
  }

  return {
    total: itens.length,
    ...(args.search !== undefined ? { search: args.search, match: args.match ?? 'partial' } : { threadId: args.threadId }),
    returned: pagina.pagina.length,
    truncated: pagina.truncado,
    ...(pagina.proximoCursor ? { nextCursor: pagina.proximoCursor } : {}),
    ...resumoCobertura(varredura),
    threads: pagina.pagina,
  };
}
