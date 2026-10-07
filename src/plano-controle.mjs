// Snapshot de control plane (t3_control_plane): numa chamada, o que roda, o que espera
// pessoa e o que terminou sem ser assentado, em todos os environments configurados (ou só
// no filtrado), com a ACL de cada um.
//
// Fontes e coerência: cada environment é uma única leitura da shell, que é uma transação do
// backend (`snapshotSequence`). Os environments são lidos em paralelo, não no mesmo instante:
// não existe corte atômico global, e a resposta diz isso em vez de fingir. Nenhum /bounded
// por thread: o pedido pendente vem resumido da shell, e o conteúdo dele (perguntas, opções)
// continua em t3_thread.
//
// Classificação, sem inventar estado: `running` e `needs_intervention` são o `state` canônico
// (estadoDaThread, o mesmo de t3_threads e t3_atencao). `ready` é trabalho potencialmente
// acionável derivável da shell: último run terminal (completed, failed, cancelled) e thread
// não assentada nem adiada por snooze, ou o marcador Woke. Não é aceite nem prova de que a
// thread está ociosa: background que a shell ainda não publicou só aparece em t3_thread.

import { marcadorWoke, motivoDoPedido, runAtivoDaShell } from './estado.mjs';
import { comparador } from './paginacao.mjs';
import { varrerAmbientes } from './varredura.mjs';

export const VERSAO_CONTRATO = 1;
export const LIMITE_PADRAO = 20;
export const LIMITE_MAXIMO = 100;

const ESTADOS = ['running', 'needs_intervention', 'completed', 'failed', 'cancelled', 'no_run', 'unknown'];
const TERMINAIS = new Set(['completed', 'failed', 'cancelled']);

/** Snooze ainda valendo: prazo no futuro e a thread não acordou antes dele. */
function adiada(thread, agora) {
  const prazo = Date.parse(thread.snoozedUntil ?? '');
  return !Number.isNaN(prazo) && prazo > Date.parse(agora) && marcadorWoke(thread, agora).wokeAt == null;
}

/** Pedido pendente resumido da shell; o conteúdo e a resposta ficam em t3_thread. */
function pedidoResumido(thread) {
  const p = thread.pendingRuntimeRequest;
  if (!p) return null;
  return { requestId: p.id, kind: p.kind, reason: motivoDoPedido(p.kind), since: p.createdAt ?? null, contentInThreadRead: true };
}

function classificar(thread, resumo, agora) {
  if (resumo.state === 'running') return { balde: 'running' };
  if (resumo.state === 'needs_intervention') return { balde: 'needsIntervention' };
  const motivos = [];
  if (TERMINAIS.has(resumo.state) && !resumo.settled && !adiada(thread, agora)) motivos.push(`latest_run_${resumo.state}_unsettled`);
  if (resumo.woke === true) motivos.push('woke');
  if (!motivos.length) return null;
  const bloqueios = (thread.pendingBackgroundTasks ?? []).length ? ['background_work_pending'] : [];
  return { balde: 'ready', extra: { readyReasons: motivos, blockers: bloqueios, actionableNow: bloqueios.length === 0 } };
}

function ordenarEPaginar(itens, limite) {
  const chave = (t) => [t.updatedAt ?? '', t.environment.environmentId, t.threadId];
  const comparar = comparador([true, false, false]);
  const ordenados = itens.sort((a, b) => comparar(chave(a), chave(b)));
  const threads = ordenados.slice(0, limite);
  return { total: ordenados.length, returned: threads.length, truncated: ordenados.length > threads.length, threads };
}

/**
 * `resumir(thread, projeto, pendentes, agora)` monta o item com o contrato de t3_threads (injetado pelo
 * servidor). Prazos e concorrência vêm de `opcoes`, como na busca entre environments.
 */
export async function snapshotPlanoControle(ambientes, { environment, limit: limite = LIMITE_PADRAO } = {}, { signal, resumir, ...opcoes } = {}) {
  const agora = new Date().toISOString();
  const varredura = await varrerAmbientes(ambientes, {
    environment,
    signal,
    ...opcoes,
    porAmbiente: async (r, cliente, info, sinal) => ({ shell: await cliente.shell({ signal: sinal }), lidoEm: new Date().toISOString() }),
  });

  const baldes = { needsIntervention: [], running: [], ready: [] };
  const consultados = varredura.sucesso.map(({ r, ambiente, valor: { shell, lidoEm } }) => {
    const projetos = new Map((shell.projects ?? []).map((p) => [p.id, p]));
    const contagem = Object.fromEntries(ESTADOS.map((e) => [e, 0]));
    const visiveis = r.escopo.threadsVisiveis(shell);
    for (const t of visiveis) {
      const resumo = resumir(t, projetos.get(t.projectId), [], agora);
      contagem[resumo.state] = (contagem[resumo.state] ?? 0) + 1;
      const classe = classificar(t, resumo, agora);
      if (!classe) continue;
      const ativo = runAtivoDaShell(t);
      baldes[classe.balde].push({
        environment: ambiente,
        ...resumo,
        activeRun: ativo ? { runId: ativo.runId, status: ativo.status } : null,
        pendingRequest: pedidoResumido(t),
        ...(adiada(t, agora) ? { snoozedUntil: t.snoozedUntil } : {}),
        ...classe.extra,
        next: { tool: 't3_thread', input: { environment: ambiente.alias, threadId: t.id } },
      });
    }
    return {
      ...ambiente,
      snapshotSequence: Number.isInteger(shell.snapshotSequence) ? shell.snapshotSequence : null,
      readAt: lidoEm,
      visibleThreads: visiveis.length,
      byState: contagem,
    };
  });

  const completo = varredura.complete;
  return {
    contractVersion: VERSAO_CONTRATO,
    scope: environment !== undefined ? 'environment' : 'all_environments',
    complete: completo,
    ...(completo ? {} : {
      incompleteReason: 'some environments did not answer; their threads are absent from every list and from the counts, so this is not a global view',
    }),
    generatedAt: agora,
    coherence: {
      mode: 'per_environment',
      note: 'each environment is one shell read (one backend snapshot, `snapshotSequence`); environments are read concurrently, not at one instant',
    },
    queriedEnvironments: consultados,
    environmentFailures: varredura.falhas,
    limit: limite,
    needsIntervention: ordenarEPaginar(baldes.needsIntervention, limite),
    running: ordenarEPaginar(baldes.running, limite),
    ready: ordenarEPaginar(baldes.ready, limite),
  };
}
