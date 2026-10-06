// Leitura em lote de threads (t3_thread_read_batch): vários alvos {environment, threadId}
// numa chamada, cada um com o mesmo detalhe de t3_thread. Uma shell por environment e por
// chamada (as threads daquele environment são julgadas na mesma observação) e uma projeção
// por thread, como em t3_thread.
//
// A falha é por item: environment não configurado ou fora da política, environment que não
// responde, thread ausente ou fora do escopo, projeção que falhou e prazo esgotado viram
// `status: "error"` só nos itens afetados; os outros seguem. Só o cancelamento pelo cliente
// encerra a chamada inteira. Alvo repetido é lido uma vez e respondido em cada posição.

import { ForaDoEscopo } from './ambientes.mjs';
import { correrComSinal, falhaSanitizada } from './busca-threads.mjs';
import { Cancelada, ErroT3 } from './t3.mjs';

export const MAX_ALVOS = 20;
export const PRAZO_PADRAO_MS = 10000;
export const PRAZO_MAX_MS = 30000;
export const CONCORRENCIA_POR_AMBIENTE = 4;

// Respostas finais sobre o alvo: repetir a leitura não muda o resultado.
const DEFINITIVOS = new Set(['thread_not_found', 'environment_not_allowed']);

const PRAZO_GLOBAL = { code: 'global_timeout', reason: 'the batch reached its deadline before this item was read' };

/**
 * `ler({ r, cliente, shell, threadId, signal })` devolve o detalhe de uma thread (o mesmo
 * de t3_thread, injetado pelo servidor) ou lança ForaDoEscopo quando ela não está no escopo.
 */
export async function lerThreadsEmLote(ambientes, { items, timeoutMs = PRAZO_PADRAO_MS }, {
  signal,
  ler,
  concorrencia = CONCORRENCIA_POR_AMBIENTE,
}) {
  const total = AbortSignal.timeout(timeoutMs);
  const sinal = signal ? AbortSignal.any([signal, total]) : total;
  const resultados = new Array(items.length);
  // Um resultado por posição, gravado uma vez: trabalho que continua depois do prazo não
  // sobrescreve o que já foi decidido.
  const definir = (indice, item) => { resultados[indice] ??= { index: indice, ...item }; };

  const grupos = new Map(); // environmentId -> { r, alvos: Map threadId -> [índices] }
  items.forEach(({ environment, threadId }, indice) => {
    let r;
    try {
      r = ambientes.resolver(environment);
    } catch (e) {
      if (!(e instanceof ForaDoEscopo)) throw e;
      definir(indice, { environment: null, requestedEnvironment: environment, threadId, status: 'error', error: { code: 'environment_not_allowed', reason: e.message } });
      return;
    }
    if (!grupos.has(r.environmentId)) grupos.set(r.environmentId, { r, alvos: new Map() });
    const { alvos } = grupos.get(r.environmentId);
    if (!alvos.has(threadId)) alvos.set(threadId, []);
    alvos.get(threadId).push(indice);
  });

  const cancelada = () => signal?.aborted;
  const falhaDoItem = (e) => {
    if (total.aborted) return PRAZO_GLOBAL;
    if (e instanceof ForaDoEscopo) return { code: 'thread_not_found', reason: e.message };
    return falhaSanitizada(e);
  };

  async function lerAmbiente({ r, alvos }) {
    const identidade = ambientes.identidade(r);
    const responder = (threadId, item) => {
      for (const indice of alvos.get(threadId)) definir(indice, { environment: identidade, threadId, ...item });
    };
    let observedAt = null;
    try {
      await correrComSinal(ambientes.usar(r, async (cliente) => {
        const shell = await cliente.shell({ signal: sinal });
        observedAt = new Date().toISOString();
        const ids = [...alvos.keys()];
        let proximo = 0;
        await Promise.all(Array.from({ length: Math.min(concorrencia, ids.length) }, async () => {
          while (proximo < ids.length) {
            const threadId = ids[proximo++];
            if (cancelada()) throw new Cancelada();
            if (total.aborted) { responder(threadId, { status: 'error', error: PRAZO_GLOBAL }); continue; }
            try {
              const thread = await correrComSinal(ler({ r, cliente, shell, threadId, signal: sinal }), sinal);
              responder(threadId, { status: 'ok', observedAt, thread });
            } catch (e) {
              if (cancelada()) throw new Cancelada();
              // Transporte ou auth caídos numa projeção: a próxima chamada reabre a conexão.
              if (e instanceof ErroT3) ambientes.falhou(r, e);
              responder(threadId, { status: 'error', error: falhaDoItem(e) });
            }
          }
        }));
      }, { signal: sinal }), sinal);
      return { ...identidade, status: 'ok', observedAt };
    } catch (e) {
      if (cancelada() || e instanceof Cancelada) throw new Cancelada();
      const falha = total.aborted ? PRAZO_GLOBAL
        : e instanceof ForaDoEscopo ? { code: 'environment_not_allowed', reason: e.message }
          : falhaSanitizada(e);
      for (const threadId of alvos.keys()) responder(threadId, { status: 'error', error: falha });
      return { ...identidade, status: 'error', ...(observedAt ? { observedAt } : {}), error: falha };
    }
  }

  const ambientesLidos = await Promise.all([...grupos.values()].map(lerAmbiente));
  if (cancelada()) throw new Cancelada();

  const ok = resultados.filter((x) => x.status === 'ok').length;
  return {
    returned: resultados.length,
    summary: { ok, error: resultados.length - ok },
    allSucceeded: ok === resultados.length,
    complete: resultados.every((x) => x.status === 'ok' || DEFINITIVOS.has(x.error.code)),
    environments: ambientesLidos,
    items: resultados,
  };
}
