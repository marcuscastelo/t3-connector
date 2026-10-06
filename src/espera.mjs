// Espera curta pelo fim (ou por intervenção) de um run, por eventos de
// orchestration.subscribeThread. Ver docs/adr/0002-espera.md.
//
// Garantias: o prazo cobre a chamada inteira; fim do prazo com estado observado é
// resultado (timedOut), não erro; nenhuma mutação, claim ou lease; cancelar ou
// terminar só encerra a própria subscription.

import { Cancelada, ErroT3 } from './t3.mjs';
import { assinar } from './ws.mjs';
import { motivoDoPedido, runAtivoDaShell, ultimaResposta } from './estado.mjs';
import { aplicarItens, derivarExecucao } from './execucao.mjs';
import { EntradaInvalida } from './busca-threads.mjs';

export const TETO_MS = 5000;
// Modo execution_idle: a thread precisa ficar parada este tempo antes de ser declarada
// ociosa, para um wake run que o provider abre logo depois de uma task em segundo plano
// terminar não ser confundido com fim do trabalho.
export const QUIETO_MS = 1500;
const TERMINAIS = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back']);
const CANCELADA = new Set(['cancelled', 'interrupted', 'rolled_back']);
const ATIVIDADE = new Set(['preparing', 'starting', 'running', 'waiting']);

export function estadoDoRun(status, pedido) {
  if (pedido) return 'needs_intervention';
  if (status === 'idle') return 'no_run';
  if (!status) return 'unknown';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (CANCELADA.has(status)) return 'cancelled';
  return 'running';
}

function resumoPedido(p) {
  return p ? { runtimeRequestId: p.id, kind: p.kind, reason: motivoDoPedido(p.kind), since: p.createdAt } : null;
}

const ultimoRun = (runs) => [...(runs ?? [])].sort((a, b) => b.ordinal - a.ordinal)[0];
const ultimoRunAtivo = (runs) => ultimoRun((runs ?? []).filter((x) => ATIVIDADE.has(x.status)));

/**
 * @param ambientes registro de criarAmbientes
 * @param entrada {environment, threadId, timeoutMs, runId?, includeLatestResponse?, maxCharacters?}
 *   Sem runId, segue o run ativo da thread e, sem run ativo, o último run: o último run
 *   pode ser uma mensagem da fila já cancelada enquanto o ativo continua.
 * @param signal cancelamento vindo do cliente MCP
 */
export async function aguardarThread(ambientes, entrada, opcoes = {}) {
  const timeoutMs = Math.min(Math.max(1, Math.trunc(entrada.timeoutMs)), TETO_MS);
  // Timer real (não AbortSignal.timeout) para o prazo valer mesmo sem outro I/O pendente.
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(new DOMException('prazo da espera', 'TimeoutError')), timeoutMs);
  try {
    return await aguardar(ambientes, entrada, opcoes, timeoutMs, controle.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function aguardar(ambientes, entrada, opcoes, timeoutMs, prazo) {
  if (entrada.until === 'execution_idle') return aguardarExecucao(ambientes, entrada, opcoes, timeoutMs, prazo);
  return aguardarRun(ambientes, entrada, opcoes, timeoutMs, prazo);
}

async function aguardarRun(ambientes, entrada, { signal, agora = Date.now, assinarImpl = assinar }, timeoutMs, prazo) {
  const { threadId, runId: runPedido = null, includeLatestResponse: incluirUltimaResposta = false, maxCharacters: maxCaracteres = 800 } = entrada;
  const inicio = agora();
  const sinal = signal ? AbortSignal.any([signal, prazo]) : prazo;
  const r = ambientes.resolver(entrada.environment);

  const obs = { thread: null, run: null, pedido: null, mensagens: null, observadoEm: null };
  const resultado = (motivoRetorno, timedOut) => {
    const status = obs.run ? obs.run.status : 'idle';
    const res = {
      environment: ambientes.identidade(r),
      projectId: obs.thread.projectId,
      threadId,
      title: obs.thread.title,
      runId: obs.run?.id ?? (runPedido || obs.thread.latestRunId || null),
      statusRun: status,
      state: estadoDoRun(status, obs.pedido),
      terminal: TERMINAIS.has(status),
      timedOut,
      returnReason: motivoRetorno,
      pendingRequest: resumoPedido(obs.pedido),
      observedAt: obs.observadoEm,
      elapsedMs: agora() - inicio,
      timeoutMs,
    };
    if (incluirUltimaResposta) {
      res.latestResponse = obs.mensagens ? ultimaResposta({ messages: obs.mensagens.filter((m) => !res.runId || m.runId === res.runId) }, maxCaracteres) : null;
    }
    return res;
  };
  const marcar = () => { obs.observadoEm = new Date(agora()).toISOString(); };
  const naoObservado = (e) => {
    ambientes.falhou(r, e);
    if (signal?.aborted) throw new Cancelada();
    if (prazo.aborted && !obs.thread) {
      throw new ErroT3(`environment ${r.alias} did not respond within ${timeoutMs} ms; no state observed`, { codigo: 'indisponivel' });
    }
    throw e;
  };

  // 1. Autorização e estado inicial pela shell, antes de qualquer leitura da thread.
  let cliente;
  try {
    ({ cliente } = await ambientes.conectar(r, { signal: sinal }));
    const shell = await cliente.shell({ signal: sinal });
    obs.thread = r.escopo.exigirThread(shell, threadId);
    obs.pedido = obs.thread.pendingRuntimeRequest ?? null;
    marcar();
  } catch (e) {
    naoObservado(e);
  }

  const latest = obs.thread.latestRunId;
  const ativo = runAtivoDaShell(obs.thread);
  // Run seguido; null quando o ativo existe mas a shell não diz qual é (waiting atrás de outro).
  const alvo = runPedido ?? (ativo ? ativo.runId : latest);
  if (!alvo && !ativo) return resultado('no_run', false);
  // Status do run seguido segundo a shell; null quando ela não o descreve.
  const statusDaShell = !alvo ? null : alvo === ativo?.runId ? ativo.status : alvo === latest ? obs.thread.status : null;
  const runDaShell = statusDaShell !== null;
  if (runDaShell && TERMINAIS.has(statusDaShell) && !incluirUltimaResposta) {
    obs.run = { id: alvo, status: statusDaShell };
    return resultado('terminal', false);
  }
  if (runDaShell && obs.pedido && !incluirUltimaResposta) {
    obs.run = { id: alvo, status: statusDaShell };
    return resultado('needs_intervention', false);
  }

  // 2. Subscription: snapshot (runs, pedidos, mensagens) e depois eventos ao vivo.
  let sub = null;
  let concluir;
  const decidido = new Promise((resolve) => { concluir = resolve; });
  const pedidos = new Map();
  const avaliar = () => {
    if (!obs.run) return;
    obs.pedido = [...pedidos.values()].find((p) => p.status === 'pending') ?? null;
    if (TERMINAIS.has(obs.run.status)) concluir('terminal');
    else if (obs.pedido) concluir('needs_intervention');
  };
  const aoReceber = (itens) => {
    for (const item of itens) {
      if (item.kind === 'snapshot') {
        const p = item.projection ?? {};
        const runs = p.runs ?? [];
        obs.run = runPedido
          ? runs.find((x) => x.id === runPedido)
          : (runs.find((x) => x.id === alvo) ?? (ativo ? ultimoRunAtivo(runs) : null) ?? ultimoRun(runs));
        if (!obs.run) throw new ErroT3(`run ${alvo ?? latest} not found in thread ${threadId}`, { codigo: 'run_inexistente' });
        pedidos.clear();
        for (const q of p.runtimeRequests ?? []) pedidos.set(q.id, q);
        obs.mensagens = [...(p.messages ?? [])];
      } else if (item.kind === 'event') {
        const { type, payload } = item.event ?? {};
        if ((type === 'run.updated' || type === 'run.created') && payload?.id === obs.run?.id) obs.run = payload;
        else if (type === 'runtime-request.updated' && payload?.id) pedidos.set(payload.id, payload);
        else if (type === 'message.updated' && payload?.id && obs.mensagens) {
          const i = obs.mensagens.findIndex((m) => m.id === payload.id);
          if (i >= 0) obs.mensagens[i] = payload; else obs.mensagens.push(payload);
        } else if (type === 'thread.deleted') concluir('thread_deleted');
      }
    }
    marcar();
    avaliar();
  };

  try {
    const ticket = await cliente.ticketWs({ signal: sinal });
    sub = await assinarImpl({
      baseUrl: cliente.base,
      ticket,
      tag: 'orchestration.subscribeThread',
      payload: { threadId, requestCompletionMarker: true, acceptBoundedSnapshot: true },
      aoReceber,
      signal: sinal,
    });
    const motivo = await new Promise((resolve, reject) => {
      if (sinal.aborted) return resolve(signal?.aborted ? 'cancelada' : 'prazo');
      sinal.addEventListener('abort', () => resolve(signal?.aborted ? 'cancelada' : 'prazo'), { once: true });
      decidido.then(resolve);
      sub.fim.then(() => resolve('subscription_closed'), reject);
    });
    if (motivo === 'cancelada') throw new Cancelada();
    if (motivo === 'prazo') {
      if (!obs.run) {
        // Shell observada mas snapshot não chegou: devolve o estado da shell.
        obs.run = { id: alvo, status: statusDaShell };
      }
      return resultado('timeout', !TERMINAIS.has(obs.run.status));
    }
    return resultado(motivo, false);
  } catch (e) {
    if (e instanceof Cancelada) throw e;
    ambientes.falhou(r, e);
    if (prazo.aborted && obs.thread && !(e instanceof ErroT3 && e.codigo === 'run_inexistente')) {
      obs.run ??= { id: alvo, status: statusDaShell };
      return resultado('timeout', !TERMINAIS.has(obs.run.status));
    }
    throw e;
  } finally {
    sub?.encerrar();
  }
}


/**
 * Espera pelo fim do trabalho real da thread, não só do run: nenhum run ativo ou na fila,
 * nenhum pedido pendente e nenhum trabalho em segundo plano que segure a thread, estável
 * por QUIETO_MS. A projeção vem do snapshot da subscription e é mantida pelos eventos em
 * ordem de sequence (aplicarItens), então cada avaliação é coerente por construção.
 * Também registra as tasks que saíram do roster durante a espera (o roster do Claude não
 * guarda hora de término).
 */
async function aguardarExecucao(ambientes, entrada, { signal, agora = Date.now, assinarImpl = assinar }, timeoutMs, prazo) {
  const { threadId, includeLatestResponse: incluirUltimaResposta = false, maxCharacters: maxCaracteres = 800 } = entrada;
  if (entrada.runId) throw new EntradaInvalida('runId only applies to until=run_terminal; execution_idle follows the whole thread');
  const inicio = agora();
  const sinal = signal ? AbortSignal.any([signal, prazo]) : prazo;
  const r = ambientes.resolver(entrada.environment);
  let threadShell = null;
  let cliente;
  try {
    ({ cliente } = await ambientes.conectar(r, { signal: sinal }));
    const shell = await cliente.shell({ signal: sinal });
    threadShell = r.escopo.exigirThread(shell, threadId);
  } catch (e) {
    ambientes.falhou(r, e);
    if (signal?.aborted) throw new Cancelada();
    if (prazo.aborted) throw new ErroT3(`environment ${r.alias} did not respond within ${timeoutMs} ms; no state observed`, { codigo: 'indisponivel' });
    throw e;
  }

  const estado = { projecao: null, sequencia: null, historicoCompleto: false };
  const vistas = new Map();
  const encerradas = [];
  let execucao = null;
  let observadoEm = new Date(agora()).toISOString();

  const derivar = () => derivarExecucao({
    projecao: estado.projecao,
    fonte: { kind: 'thread_subscription', threadSequence: estado.sequencia, historyComplete: estado.historicoCompleto, observedAt: observadoEm },
    limitRecovery: threadShell.limitRecovery ?? null,
  });
  const resultado = (motivoRetorno, timedOut) => {
    const runs = execucao?.runs;
    const run = runs ? (runs.active ?? runs.latestExecuted ?? runs.latest) : null;
    const pedido = execucao?.pendingRequests?.[0] ?? null;
    const status = run?.status ?? (execucao ? 'idle' : threadShell.status);
    const res = {
      environment: ambientes.identidade(r),
      projectId: threadShell.projectId,
      threadId,
      title: threadShell.title,
      until: 'execution_idle',
      runId: run?.runId ?? (execucao ? null : threadShell.latestRunId ?? null),
      statusRun: status,
      state: execucao?.signals.pendingIntervention && !pedido ? 'needs_intervention' : estadoDoRun(status, pedido),
      terminal: TERMINAIS.has(status),
      executionIdle: execucao?.signals.operationallyIdle ?? null,
      timedOut,
      returnReason: motivoRetorno,
      pendingRequest: pedido ? { runtimeRequestId: pedido.requestId, kind: pedido.kind, reason: motivoDoPedido(pedido.kind), since: pedido.createdAt } : null,
      observedAt: observadoEm,
      elapsedMs: agora() - inicio,
      timeoutMs,
      backgroundClearedDuringWait: encerradas,
      execution: execucao,
    };
    if (incluirUltimaResposta) {
      res.latestResponse = estado.projecao ? ultimaResposta({ messages: (estado.projecao.messages ?? []).filter((m) => !res.runId || m.runId === res.runId) }, maxCaracteres) : null;
    }
    return res;
  };

  let concluir;
  const decidido = new Promise((resolve) => { concluir = resolve; });
  let quieto = null;
  const avaliar = () => {
    clearTimeout(quieto);
    execucao = derivar();
    const pendentes = new Map(execucao.background.pending.map((t) => [t.taskId, t]));
    for (const [taskId, t] of vistas) {
      if (!pendentes.has(taskId)) {
        encerradas.push({ taskId, kind: t.kind, description: t.description, source: t.source, observedClearedAt: observadoEm, threadSequence: estado.sequencia });
        vistas.delete(taskId);
      }
    }
    for (const [taskId, t] of pendentes) vistas.set(taskId, t);
    if (execucao.signals.pendingIntervention) return concluir('needs_intervention');
    if (!execucao.signals.operationallyIdle) return;
    // Ocioso: só conta depois de QUIETO_MS sem mudança da thread.
    const desde = Date.parse(execucao.source.projectionUpdatedAt ?? '');
    const falta = Number.isNaN(desde) ? 0 : desde + QUIETO_MS - agora();
    if (falta <= 0) return concluir('execution_idle');
    quieto = setTimeout(() => concluir('execution_idle'), falta);
  };
  const aoReceber = (itens) => {
    aplicarItens(estado, itens);
    observadoEm = new Date(agora()).toISOString();
    if (itens.some((i) => i.kind === 'event' && i.event?.type === 'thread.deleted')) return concluir('thread_deleted');
    if (estado.projecao) avaliar();
  };

  let sub = null;
  try {
    const ticket = await cliente.ticketWs({ signal: sinal });
    sub = await assinarImpl({
      baseUrl: cliente.base,
      ticket,
      tag: 'orchestration.subscribeThread',
      // Projeção completa: com a janela do bounded, a ausência de turn items antigos ainda
      // ativos não pode ser provada e a thread nunca seria declarada ociosa.
      payload: { threadId, requestCompletionMarker: true },
      aoReceber,
      signal: sinal,
    });
    const motivo = await new Promise((resolve, reject) => {
      if (sinal.aborted) return resolve(signal?.aborted ? 'cancelada' : 'prazo');
      sinal.addEventListener('abort', () => resolve(signal?.aborted ? 'cancelada' : 'prazo'), { once: true });
      decidido.then(resolve);
      sub.fim.then(() => resolve('subscription_closed'), reject);
    });
    if (motivo === 'cancelada') throw new Cancelada();
    if (motivo === 'prazo') return resultado('timeout', true);
    return resultado(motivo, false);
  } catch (e) {
    if (e instanceof Cancelada) throw e;
    ambientes.falhou(r, e);
    if (prazo.aborted) return resultado('timeout', true);
    throw e;
  } finally {
    clearTimeout(quieto);
    sub?.encerrar();
  }
}
