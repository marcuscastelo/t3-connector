// Workset do orquestrador (t3_workset): numa chamada, o que um orquestrador precisa para
// reconstruir seu quadro depois de perder o contexto, em todos os environments
// configurados (ou nos escolhidos). Uma leitura de shell por environment; nada é inferido.
//
// Cada thread visível (projeto autorizado, não arquivada, não apagada) cai em UM grupo,
// pela ordem: needs_intervention > running > background_pending > unknown > snoozed >
// failed_unsettled > completed_unsettled > cancelled_unsettled. Os quatro primeiros valem
// também para threads liquidadas: trabalho de fundo pode continuar depois do settlement e
// estado desconhecido nunca é tratado como ocioso. Threads liquidadas ociosas e threads sem
// run não entram (só contadas).
// `completed` é desfecho de run, não aceite: completed_unsettled é exatamente o que ainda
// precisa de uma decisão (absorver, continuar, liquidar).
//
// Trabalho de fundo vem só do roster da shell (uma leitura por environment, sem projeção por
// thread): `background_pending` usa a regra canônica de `execution` (segura a thread tudo
// menos comando) e a lista não prova ausência; para decidir uma thread, leia `t3_thread`
// (`execution`).
//
// Fila ativa: `actionable` (decisão agora) e `inFlight` (em execução) já vêm prontos, para o
// host não refiltrar a cada rodada. Settled ociosa, snoozed com wake no futuro e arquivada
// nunca entram neles; snoozed fica no grupo `snoozed` só para inspeção. Pedido pendente,
// run ativo e trabalho de fundo valem mais que settled/snoozed: continuam na fila.
// Arquivadas ficam fora dos grupos; só são listadas, à parte, quando há fonte validada.
//
// Environment que falha não derruba os outros: entra em `environmentFailures` e
// `complete` fica false; os grupos trazem o que os environments que responderam mostraram.

import { Cancelada } from './t3.mjs';
import { correrComSinal, falhaSanitizada } from './busca-threads.mjs';
import { resumoModelo } from './estado.mjs';
import { seguraAThread } from './execucao.mjs';
import { msIso } from './instante.mjs';
import { linhaUnica } from './linhas.mjs';
import { assinatura, comparador, CursorInvalido, paginar, VERSAO_CURSOR } from './paginacao.mjs';
import { CONTROL_PLANE_CONTRACT_VERSION } from './control-plane.mjs';

export const GRUPOS = Object.freeze([
  'needs_intervention', 'running', 'background_pending', 'unknown', 'snoozed', 'failed_unsettled', 'completed_unsettled', 'cancelled_unsettled',
]);
export const FILAS = Object.freeze({
  actionable: Object.freeze(['needs_intervention', 'unknown', 'failed_unsettled', 'completed_unsettled', 'cancelled_unsettled']),
  inFlight: Object.freeze(['running', 'background_pending']),
});
export const PRAZO_AMBIENTE_MS = 6000;
export const PRAZO_TOTAL_MS = 12000;
export const LIMITE_PADRAO = 25;
export const GRUPOS_REVISAO = Object.freeze(['completed_unsettled']);
export const LIMITE_REVISAO = 20;

export class CursorSnapshotMudou extends CursorInvalido {
  constructor() {
    super();
    this.code = 'cursor_snapshot_changed';
    this.message = 'cursor_snapshot_changed: the environments or their snapshot sequences changed since the first page; start the review queue again without a cursor and deduplicate by environmentId and threadId';
  }
}

/** Mesma fila (grupo, environments) com outro vetor de sequences: o snapshot mudou entre páginas. */
function mesmaFilaOutroSnapshot(cursor, consulta) {
  try {
    const dados = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (dados?.v !== VERSAO_CURSOR) return false;
    const q = JSON.parse(dados.q);
    const atual = JSON.parse(consulta);
    return JSON.stringify(q.slice(0, -1)) === JSON.stringify(atual.slice(0, -1)) && JSON.stringify(q.at(-1)) !== JSON.stringify(atual.at(-1));
  } catch {
    return false;
  }
}

function grupoDa(item, agora) {
  if (item.state === 'needs_intervention') return 'needs_intervention';
  if (item.state === 'running') return 'running';
  if (item.backgroundHoldsThread) return 'background_pending';
  if (item.state === 'unknown') return 'unknown';
  if (item.settled) return null;
  if (item.snoozedUntil && (msIso(item.snoozedUntil) ?? -Infinity) > agora) return 'snoozed';
  if (item.state === 'failed') return 'failed_unsettled';
  if (item.state === 'completed') return 'completed_unsettled';
  if (item.state === 'cancelled') return 'cancelled_unsettled';
  return null; // no_run
}

/** Item compacto: referências e fatos de decisão, sem texto de conversa. */
function itemCompacto(t, resumo, ambiente, projeto) {
  const linha = t.lineage ?? {};
  const pr = t.linkedPullRequest;
  return {
    environment: ambiente.alias,
    threadId: t.id,
    title: t.title,
    projectId: t.projectId,
    ...(projeto?.title ? { projectTitle: projeto.title } : {}),
    state: resumo.state,
    stateSource: resumo.stateSource,
    runId: resumo.runId ?? null,
    ...(resumo.latestRunId ? { latestRunId: resumo.latestRunId, latestRunStatus: resumo.latestRunStatus } : {}),
    ...(resumo.reason ? { reason: resumo.reason, kind: resumo.kind } : {}),
    pendingRequest: t.pendingRuntimeRequest
      ? { requestId: t.pendingRuntimeRequest.id, kind: t.pendingRuntimeRequest.kind, since: t.pendingRuntimeRequest.createdAt }
      : null,
    model: resumoModelo(t.modelSelection),
    updatedAt: t.updatedAt,
    settled: Boolean(t.settledAt),
    ...(t.settledAt ? { settledAt: t.settledAt } : {}),
    ...(t.snoozedUntil ? { snoozedUntil: t.snoozedUntil } : {}),
    // Campo ausente em servidor antigo é desconhecido, não false.
    pinned: 'pinnedAt' in t ? Boolean(t.pinnedAt) : null,
    ...(linha.parentThreadId ? { parentThreadId: linha.parentThreadId, relationshipToParent: linha.relationshipToParent ?? null } : {}),
    ...(pr ? { linkedPullRequest: { number: pr.number ?? null, url: pr.url ?? null, state: pr.state ?? null } } : {}),
    ...(t.pendingBackgroundTasks?.length ? {
      backgroundTaskCount: t.pendingBackgroundTasks.length,
      // Mesma regra de `execution.background` (src/execucao.mjs): comando não segura a thread.
      backgroundHoldsThread: t.pendingBackgroundTasks.some((x) => seguraAThread(x.kind ?? 'background_task')),
    } : {}),
  };
}

/**
 * `resumir(thread, projeto)` é o resumo canônico do servidor (estado com a precedência
 * da 0.11.2). Prazos e relógio são parâmetros para os testes; os padrões são o contrato.
 */
export async function montarWorkset(ambientes, args, {
  signal,
  resumir,
  agora = Date.now(),
  prazoAmbienteMs = PRAZO_AMBIENTE_MS,
  prazoTotalMs = PRAZO_TOTAL_MS,
  // Leitor de threads arquivadas de um environment: (cliente, {signal}) => shell threads.
  // Nenhuma fonte de produção foi validada ainda (a shell HTTP não garante arquivadas), então
  // por padrão não há leitor e a resposta declara a lacuna em vez de inferir.
  lerArquivadas = null,
} = {}) {
  const limite = args.limitPerGroup ?? LIMITE_PADRAO;
  const selecionados = args.environments?.length
    ? [...new Map(args.environments.map((chave) => {
      const r = ambientes.resolver(chave);
      return [r.environmentId, r];
    })).values()]
    : [...ambientes.registros];
  selecionados.sort((a, b) => comparador()([a.environmentId], [b.environmentId]));

  const total = AbortSignal.timeout(prazoTotalMs);
  const resultados = await Promise.all(selecionados.map(async (r) => {
    const proprio = AbortSignal.timeout(prazoAmbienteMs);
    const sinal = AbortSignal.any([total, proprio, ...(signal ? [signal] : [])]);
    try {
      const { shell, info, arquivadas } = await correrComSinal(
        ambientes.usar(r, async (cliente, info) => {
          const shell = await cliente.shell({ signal: sinal });
          let arquivadas = null;
          if (lerArquivadas) {
            try { arquivadas = { ok: true, threads: await lerArquivadas(cliente, { signal: sinal }) }; } catch (e) { arquivadas = { ok: false, falha: falhaSanitizada(e) }; }
          }
          return { shell, info, arquivadas };
        }, { signal: sinal }),
        sinal,
      );
      const projetos = new Map((shell.projects ?? []).map((p) => [p.id, p]));
      const ambiente = { ...ambientes.identidade(r), name: info?.nome ?? null };
      // Uma linha por thread: repetidas iguais contam uma vez; divergentes (revisão R5) viram
      // um item `unknown`, nunca a mesma thread em dois grupos.
      const vistos = new Set();
      const itens = [];
      for (const t of r.escopo.threadsVisiveis(shell)) {
        if (vistos.has(t.id)) continue;
        vistos.add(t.id);
        const projeto = projetos.get(t.projectId);
        const item = itemCompacto(t, resumir(t, projeto), ambiente, projeto);
        itens.push(linhaUnica(shell.threads, t.id).conflito ? { ...item, state: 'unknown', stateSource: 'thread_rows_conflict', reason: 'thread_rows_conflict' } : item);
      }
      const arquivo = arquivadas?.ok
        ? {
            ok: true,
            itens: (arquivadas.threads ?? [])
              .filter((t) => r.escopo.projetoPermitido(t.projectId) && !t.deletedAt && t.archivedAt)
              .map((t) => ({ ...itemCompacto(t, resumir(t, projetos.get(t.projectId)), ambiente, projetos.get(t.projectId)), archivedAt: t.archivedAt })),
          }
        : arquivadas;
      return { ok: true, ambiente, snapshotSequence: shell.snapshotSequence ?? null, itens, arquivo };
    } catch (e) {
      if (signal?.aborted || e instanceof Cancelada) throw new Cancelada();
      const falha = total.aborted
        ? { code: 'global_timeout', reason: 'the workset reached its total deadline before this environment answered' }
        : proprio.aborted ? { code: 'timeout', reason: 'environment did not respond in time' } : falhaSanitizada(e);
      return { ok: false, falha: { ...ambientes.identidade(r), ...falha } };
    }
  }));

  const grupos = Object.fromEntries(GRUPOS.map((g) => [g, []]));
  let liquidadas = 0;
  let semRun = 0;
  const consultados = [];
  for (const res of resultados.filter((x) => x.ok)) {
    const contagem = Object.fromEntries(GRUPOS.map((g) => [g, 0]));
    for (const item of res.itens) {
      const g = grupoDa(item, agora);
      if (g) { grupos[g].push(item); contagem[g]++; }
      else if (item.state === 'no_run') semRun++;
      else liquidadas++;
    }
    consultados.push({ ...res.ambiente, snapshotSequence: res.snapshotSequence, visibleThreads: res.itens.length, counts: contagem });
  }

  const chave = (t) => [t.updatedAt ?? '', t.environment, t.threadId];
  const comparar = comparador([true, false, false]);
  const counts = {};
  const omitidos = {};
  const completos = {};
  for (const g of GRUPOS) {
    grupos[g].sort((a, b) => comparar(chave(a), chave(b)));
    completos[g] = grupos[g];
    counts[g] = grupos[g].length;
    if (grupos[g].length > limite) {
      omitidos[g] = grupos[g].length - limite;
      grupos[g] = grupos[g].slice(0, limite);
    }
  }
  const falhas = resultados.filter((x) => !x.ok).map((x) => x.falha);
  const ref = (g) => (t) => ({ environment: t.environment, threadId: t.threadId, group: g });
  const fila = (nomes) => nomes.flatMap((g) => grupos[g].map(ref(g)));
  const somar = (nomes) => nomes.reduce((n, g) => n + counts[g], 0);

  let archived;
  if (!lerArquivadas) {
    archived = { available: false, reason: 'archived_source_not_validated' };
  } else {
    const ok = resultados.filter((x) => x.ok);
    const falhasArquivo = ok.filter((x) => !x.arquivo?.ok).map((x) => ({ ...x.ambiente, ...(x.arquivo?.falha ?? {}) }));
    const lista = ok.filter((x) => x.arquivo?.ok).flatMap((x) => x.arquivo.itens).sort((a, b) => comparar(chave(a), chave(b)));
    archived = {
      available: falhasArquivo.length === 0 && falhas.length === 0,
      total: lista.length,
      ...(lista.length > limite ? { truncated: lista.length - limite } : {}),
      environmentFailures: falhasArquivo,
      threads: lista.slice(0, limite),
    };
  }
  // Fila de revisão (control-plane v1): página de referências do grupo, antes do corte por grupo,
  // com cursor ligado aos environments e às sequences de cada um. Mesma classificação (grupoDa).
  let reviewQueue;
  if (args.reviewQueue) {
    const { group, limit = LIMITE_REVISAO, cursor } = args.reviewQueue;
    const lista = completos[group];
    const vetor = consultados.map((c) => [c.environmentId, c.snapshotSequence ?? null]);
    const consulta = assinatura(['t3_workset.reviewQueue', CONTROL_PLANE_CONTRACT_VERSION, group, selecionados.map((r) => r.environmentId), vetor]);
    const chaveRef = (t) => [t.updatedAt ?? '', t.environment, t.threadId];
    let pagina;
    try {
      pagina = paginar({ itens: lista, consulta, cursor, limite: limit, chave: chaveRef, comparar });
    } catch (e) {
      if (e instanceof CursorInvalido && cursor && mesmaFilaOutroSnapshot(cursor, consulta)) throw new CursorSnapshotMudou();
      throw e;
    }
    const idPorAlias = new Map(consultados.map((c) => [c.alias, c.environmentId]));
    reviewQueue = {
      group,
      total: lista.length,
      returned: pagina.pagina.length,
      truncated: pagina.truncado,
      ...(pagina.proximoCursor ? { nextCursor: pagina.proximoCursor } : {}),
      items: pagina.pagina.map((t) => ({
        environment: t.environment,
        environmentId: idPorAlias.get(t.environment) ?? null,
        threadId: t.threadId,
        projectId: t.projectId,
        runId: t.latestRunId ?? t.runId ?? null,
        updatedAt: t.updatedAt,
        nextRead: { tool: 't3_thread', controlPlaneContractVersion: CONTROL_PLANE_CONTRACT_VERSION, settlementContractVersion: 2, review: true },
      })),
    };
  }
  return {
    ...(args.controlPlaneContractVersion ? { controlPlaneContractVersion: args.controlPlaneContractVersion } : {}),
    observedAt: new Date(agora).toISOString(),
    complete: falhas.length === 0,
    queriedEnvironments: consultados,
    environmentFailures: falhas,
    counts: { ...counts, actionable: somar(FILAS.actionable), inFlight: somar(FILAS.inFlight), settledIdle: liquidadas, noRun: semRun },
    ...(Object.keys(omitidos).length ? { truncated: omitidos } : {}),
    actionable: fila(FILAS.actionable),
    inFlight: fila(FILAS.inFlight),
    groups: grupos,
    archived,
    ...(reviewQueue ? { reviewQueue } : {}),
  };
}
