// Busca de thread por título ou ID sem exigir environment (t3_buscar_threads). Consulta o
// shell de cada environment configurado (ou só do filtrado), aplica a ACL de cada um e
// devolve cada candidato com o environment onde ele vive. É descoberta, não roteamento:
// as outras ferramentas continuam sem fallback entre environments, e quem lê ou age
// depois passa o par (environment, threadId) escolhido.
//
// Um environment que falha ou não responde no prazo não derruba a busca: entra em
// `falhasAmbientes` e `completa` fica false. Zero resultados com `completa: false` não
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
    this.message = 'os environments que responderam mudaram desde a primeira página; refaça a busca sem cursor';
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
    if (e.codigo === 'prazo') return { codigo: 'prazo', motivo: 'environment não respondeu no prazo' };
    if (e.codigo === 'indisponivel') return { codigo: 'indisponivel', motivo: 'T3 indisponível nesse environment' };
    if (e.codigo === 'environment_divergente') return { codigo: 'environment_divergente', motivo: 'endpoint respondeu como outro environment' };
    if (e.status === 401 || e.status === 403) return { codigo: `http_${e.status}`, motivo: 'T3 recusou o token desse environment' };
    if (e.status) return { codigo: `http_${e.status}`, motivo: `T3 respondeu ${e.status}` };
    return { codigo: 'conexao_recusada', motivo: 'conexão recusada (token, escopo ou protocolo); veja t3_ambientes' };
  }
  return { codigo: 'falha', motivo: 'falha ao consultar o environment' };
}

function validar({ busca, threadId, correspondencia }) {
  const temBusca = busca !== undefined;
  const temId = threadId !== undefined;
  if (temBusca === temId) throw new EntradaInvalida('informe exatamente um entre `busca` e `threadId`');
  if (temBusca && !busca.trim()) throw new EntradaInvalida('`busca` vazia');
  if (temId && correspondencia !== undefined) throw new EntradaInvalida('`correspondencia` só vale com `busca`; `threadId` é sempre exato');
}

function criterio({ busca, threadId, correspondencia = 'parcial' }) {
  if (threadId !== undefined) {
    return { casa: (t) => t.id === threadId, partes: ['threadId', threadId] };
  }
  if (correspondencia === 'exata') {
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
  const selecionados = (args.ambiente !== undefined ? [ambientes.resolver(args.ambiente)] : [...ambientes.registros])
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
      const ambiente = { ...ambientes.identidade(r), nome: info?.nome ?? null };
      const threads = shell.threads
        .filter((t) => r.escopo.projetoPermitido(t.projectId) && !t.deletedAt && casa(t))
        .map((t) => {
          const item = resumir(t, projetos.get(t.projectId));
          return { threadId: item.threadId, titulo: item.titulo, ambiente, ...item, arquivada: Boolean(t.archivedAt) };
        });
      resultados.set(r.environmentId, { ok: true, ambiente, threads });
    } catch (e) {
      if (signal?.aborted || e instanceof Cancelada) throw new Cancelada();
      const falha = total.aborted
        ? { codigo: 'prazo_global', motivo: 'busca atingiu o prazo total antes da resposta desse environment' }
        : proprio.aborted ? { codigo: 'prazo', motivo: 'environment não respondeu no prazo' } : falhaSanitizada(e);
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
          falha: { ...ambientes.identidade(r), codigo: 'prazo_global', motivo: 'busca atingiu o prazo total antes de consultar esse environment' },
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
  const chave = (t) => [t.ambiente.environmentId, t.threadId];
  const comparar = comparador();
  const itens = sucesso.flatMap((x) => x.threads).sort((a, b) => comparar(chave(a), chave(b)));

  const filtro = args.ambiente !== undefined ? selecionados[0].environmentId : null;
  const consulta = assinatura(['t3_buscar_threads', ...partes, filtro, selecionados.map((r) => r.environmentId), sucesso.map((x) => x.ambiente.environmentId)]);
  let pagina;
  try {
    pagina = paginar({ itens, consulta, cursor: args.cursor, limite: args.limite ?? 20, chave, comparar });
  } catch (e) {
    // Mesma consulta com outra cobertura: diz por que o cursor deixou de valer.
    if (e instanceof CursorInvalido && args.cursor && mesmaConsultaOutraCobertura(args.cursor, consulta)) throw new CoberturaMudou();
    throw e;
  }

  return {
    total: itens.length,
    ...(args.busca !== undefined ? { busca: args.busca, correspondencia: args.correspondencia ?? 'parcial' } : { threadId: args.threadId }),
    retornadas: pagina.pagina.length,
    truncado: pagina.truncado,
    completa: falhasAmbientes.length === 0,
    ...(pagina.proximoCursor ? { proximoCursor: pagina.proximoCursor } : {}),
    ambientesConsultados: sucesso.map((x) => ({ ...x.ambiente, encontradas: x.threads.length })),
    falhasAmbientes,
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
