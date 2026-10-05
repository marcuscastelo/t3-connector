// Workset do orquestrador (t3_workset): numa chamada, o que um orquestrador precisa para
// reconstruir seu quadro depois de perder o contexto, em todos os environments
// configurados (ou nos escolhidos). Uma leitura de shell por environment; nada é inferido.
//
// Cada thread visível (projeto autorizado, não arquivada, não apagada) cai em UM grupo,
// pela ordem: needs_intervention > running > snoozed > failed_unsettled >
// completed_unsettled > cancelled_unsettled > unknown. Threads liquidadas que não estão
// rodando nem pedindo intervenção e threads sem run não entram (só contadas).
// `completed` é desfecho de run, não aceite: completed_unsettled é exatamente o que ainda
// precisa de uma decisão (absorver, continuar, liquidar).
//
// Environment que falha não derruba os outros: entra em `environmentFailures` e
// `complete` fica false; os grupos trazem o que os environments que responderam mostraram.

import { Cancelada } from './t3.mjs';
import { correrComSinal, falhaSanitizada } from './busca-threads.mjs';
import { resumoModelo } from './estado.mjs';
import { comparador } from './paginacao.mjs';

export const GRUPOS = Object.freeze([
  'needs_intervention', 'running', 'snoozed', 'failed_unsettled', 'completed_unsettled', 'cancelled_unsettled', 'unknown',
]);
export const PRAZO_AMBIENTE_MS = 6000;
export const PRAZO_TOTAL_MS = 12000;
export const LIMITE_PADRAO = 25;

function grupoDa(item, agora) {
  if (item.state === 'needs_intervention') return 'needs_intervention';
  if (item.state === 'running') return 'running';
  if (item.settled) return null;
  if (item.snoozedUntil && Date.parse(item.snoozedUntil) > agora) return 'snoozed';
  if (item.state === 'failed') return 'failed_unsettled';
  if (item.state === 'completed') return 'completed_unsettled';
  if (item.state === 'cancelled') return 'cancelled_unsettled';
  if (item.state === 'no_run') return null;
  return 'unknown';
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
    ...(t.pendingBackgroundTasks?.length ? { backgroundTaskCount: t.pendingBackgroundTasks.length } : {}),
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
      const { shell, info } = await correrComSinal(
        ambientes.usar(r, async (cliente, info) => ({ shell: await cliente.shell({ signal: sinal }), info }), { signal: sinal }),
        sinal,
      );
      const projetos = new Map((shell.projects ?? []).map((p) => [p.id, p]));
      const ambiente = { ...ambientes.identidade(r), name: info?.nome ?? null };
      const itens = r.escopo.threadsVisiveis(shell).map((t) => {
        const projeto = projetos.get(t.projectId);
        return itemCompacto(t, resumir(t, projeto), ambiente, projeto);
      });
      return { ok: true, ambiente, snapshotSequence: shell.snapshotSequence ?? null, itens };
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
  for (const g of GRUPOS) {
    grupos[g].sort((a, b) => comparar(chave(a), chave(b)));
    counts[g] = grupos[g].length;
    if (grupos[g].length > limite) {
      omitidos[g] = grupos[g].length - limite;
      grupos[g] = grupos[g].slice(0, limite);
    }
  }
  const falhas = resultados.filter((x) => !x.ok).map((x) => x.falha);
  return {
    observedAt: new Date(agora).toISOString(),
    complete: falhas.length === 0,
    queriedEnvironments: consultados,
    environmentFailures: falhas,
    counts: { ...counts, settledIdle: liquidadas, noRun: semRun },
    ...(Object.keys(omitidos).length ? { truncated: omitidos } : {}),
    groups: grupos,
  };
}
