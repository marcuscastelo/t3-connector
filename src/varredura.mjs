// Varredura dos environments: executa uma leitura em cada environment configurado (ou só
// no filtrado por `environment`), com a ACL de cada um, prazo por environment e prazo
// total, e devolve o que cada um respondeu ao lado das falhas. É a base de toda leitura
// sem `environment` (busca, listagens e localização de thread por ID): nenhum environment
// é padrão, e um que falha ou não responde não derruba a chamada nem some em silêncio.
// Ver docs/adr/0005.

import { ForaDoEscopo } from './ambientes.mjs';
import { comparador, CursorInvalido, VERSAO_CURSOR } from './paginacao.mjs';
import { Cancelada, ErroT3 } from './t3.mjs';

export const PRAZO_AMBIENTE_MS = 4000;
export const PRAZO_TOTAL_MS = 10000;
export const CONCORRENCIA = 4;

export class EntradaInvalida extends Error {}

export class CoberturaMudou extends CursorInvalido {
  constructor() {
    super();
    this.message = 'the environments that answered changed since the first page; repeat the query without a cursor';
  }
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
  // Recusa da própria consulta naquele environment (filtro indecidível, projeto fora da ACL):
  // a mensagem já é para o cliente.
  if (e instanceof EntradaInvalida || e instanceof ForaDoEscopo) return { code: 'refused', reason: e.message };
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

/**
 * Executa `porAmbiente(r, cliente, info, sinal)` em cada environment selecionado, até
 * `concorrencia` por vez, em ordem de environmentId. Devolve `sucesso` (um por environment
 * que respondeu, na ordem dos selecionados, com `r`, `ambiente` {alias, environmentId,
 * name} e `valor`), `falhas` (sanitizadas, com alias e environmentId) e `cobertura`, a
 * parte da assinatura do cursor que amarra uma página ao conjunto que respondeu.
 * Cancelamento do cliente é propagado como `Cancelada`, nunca como falha parcial.
 * Prazos e concorrência são parâmetros para os testes; os padrões são o contrato.
 */
export async function varrerAmbientes(ambientes, {
  environment,
  signal,
  porAmbiente,
  prazoAmbienteMs = PRAZO_AMBIENTE_MS,
  prazoTotalMs = PRAZO_TOTAL_MS,
  concorrencia = CONCORRENCIA,
}) {
  const selecionados = (environment !== undefined ? [ambientes.resolver(environment)] : [...ambientes.registros])
    .sort((a, b) => comparador()([a.environmentId], [b.environmentId]));

  const total = AbortSignal.timeout(prazoTotalMs);
  const resultados = new Map(); // environmentId -> { ok, ... }

  async function consultar(r) {
    const proprio = AbortSignal.timeout(prazoAmbienteMs);
    const sinal = AbortSignal.any([total, proprio, ...(signal ? [signal] : [])]);
    try {
      const { valor, info } = await correrComSinal(
        ambientes.usar(r, async (cliente, info) => ({ valor: await porAmbiente(r, cliente, info, sinal), info }), { signal: sinal }),
        sinal,
      );
      resultados.set(r.environmentId, { ok: true, r, ambiente: { ...ambientes.identidade(r), name: info?.nome ?? null }, valor });
    } catch (e) {
      if (signal?.aborted || e instanceof Cancelada) throw new Cancelada();
      const falha = total.aborted
        ? { code: 'global_timeout', reason: 'the query reached its total deadline before this environment answered' }
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
          falha: { ...ambientes.identidade(r), code: 'global_timeout', reason: 'the query reached its total deadline before querying this environment' },
        });
        continue;
      }
      await consultar(r);
    }
  });
  await Promise.all(trabalhadores);

  const ordem = selecionados.map((r) => resultados.get(r.environmentId));
  const sucesso = ordem.filter((x) => x.ok);
  const falhas = ordem.filter((x) => !x.ok).map((x) => x.falha);
  const cobertura = {
    filter: environment !== undefined ? selecionados[0].environmentId : null,
    selected: selecionados.map((r) => r.environmentId),
    answered: sucesso.map((x) => x.ambiente.environmentId),
  };
  return { selecionados, sucesso, falhas, cobertura, complete: falhas.length === 0 };
}

/** Resumo da varredura para a resposta: o que respondeu (com `found`) e o que falhou. */
export function resumoCobertura({ sucesso, falhas }, encontrados = (valor) => (Array.isArray(valor) ? valor.length : valor?.itens?.length ?? 0)) {
  return {
    complete: falhas.length === 0,
    queriedEnvironments: sucesso.map((x) => ({ ...x.ambiente, found: encontrados(x.valor) })),
    environmentFailures: falhas,
  };
}

/**
 * Assinatura do cursor de uma consulta varrida: os filtros, o filtro de environment e os
 * environments selecionados (identidade da consulta) e, por último, os que responderam
 * (cobertura). `traduzirCursorInvalido` usa essa posição para dizer, quando o cursor
 * deixa de valer, se foi por outra consulta ou porque a cobertura mudou.
 */
export function assinaturaCoberta(partes, cobertura) {
  return JSON.stringify([...partes, cobertura.filter, cobertura.selected, cobertura.answered]);
}

/** Converte `CursorInvalido` em `CoberturaMudou` quando só a cobertura difere. */
export function traduzirCursorInvalido(e, cursor, consulta) {
  if (e instanceof CursorInvalido && cursor && mesmaConsultaOutraCobertura(cursor, consulta)) return new CoberturaMudou();
  return e;
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
