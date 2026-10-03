// Espera curta pelo fim (ou por intervenção) de um run, por eventos de
// orchestration.subscribeThread. Ver docs/adr/0002-espera.md.
//
// Garantias: o prazo cobre a chamada inteira; fim do prazo com estado observado é
// resultado (timedOut), não erro; nenhuma mutação, claim ou lease; cancelar ou
// terminar só encerra a própria subscription.

import { Cancelada, ErroT3 } from './t3.mjs';
import { assinar } from './ws.mjs';
import { motivoDoPedido, ultimaResposta } from './estado.mjs';

export const TETO_MS = 5000;
const TERMINAIS = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back']);
const CANCELADA = new Set(['cancelled', 'interrupted', 'rolled_back']);

export function estadoDoRun(status, pedido) {
  if (pedido) return 'precisa_intervencao';
  if (status === 'idle') return 'sem_execucao';
  if (!status) return 'desconhecido';
  if (status === 'completed') return 'concluida';
  if (status === 'failed') return 'falhou';
  if (CANCELADA.has(status)) return 'cancelada';
  return 'rodando';
}

function resumoPedido(p) {
  return p ? { runtimeRequestId: p.id, tipo: p.kind, motivo: motivoDoPedido(p.kind), desde: p.createdAt } : null;
}

const ultimoRun = (runs) => [...(runs ?? [])].sort((a, b) => b.ordinal - a.ordinal)[0];

/**
 * @param ambientes registro de criarAmbientes
 * @param entrada {ambiente, threadId, timeoutMs, runId?, incluirUltimaResposta?, maxCaracteres?}
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

async function aguardar(ambientes, entrada, { signal, agora = Date.now, assinarImpl = assinar }, timeoutMs, prazo) {
  const { threadId, runId: runPedido = null, incluirUltimaResposta = false, maxCaracteres = 800 } = entrada;
  const inicio = agora();
  const sinal = signal ? AbortSignal.any([signal, prazo]) : prazo;
  const r = ambientes.resolver(entrada.ambiente);

  const obs = { thread: null, run: null, pedido: null, mensagens: null, observadoEm: null };
  const resultado = (motivoRetorno, timedOut) => {
    const status = obs.run ? obs.run.status : 'idle';
    const res = {
      ambiente: ambientes.identidade(r),
      projectId: obs.thread.projectId,
      threadId,
      titulo: obs.thread.title,
      runId: obs.run?.id ?? (runPedido || obs.thread.latestRunId || null),
      statusRun: status,
      estado: estadoDoRun(status, obs.pedido),
      terminal: TERMINAIS.has(status),
      timedOut,
      motivoRetorno,
      pedidoPendente: resumoPedido(obs.pedido),
      observadoEm: obs.observadoEm,
      elapsedMs: agora() - inicio,
      timeoutMs,
    };
    if (incluirUltimaResposta) {
      res.ultimaResposta = obs.mensagens ? ultimaResposta({ messages: obs.mensagens.filter((m) => !res.runId || m.runId === res.runId) }, maxCaracteres) : null;
    }
    return res;
  };
  const marcar = () => { obs.observadoEm = new Date(agora()).toISOString(); };
  const naoObservado = (e) => {
    ambientes.falhou(r, e);
    if (signal?.aborted) throw new Cancelada();
    if (prazo.aborted && !obs.thread) {
      throw new ErroT3(`ambiente ${r.alias} não respondeu em ${timeoutMs} ms; nenhum estado observado`, { codigo: 'indisponivel' });
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
  if (!latest && !runPedido) return resultado('sem_execucao', false);
  const runDaShell = !runPedido || runPedido === latest;
  if (runDaShell && TERMINAIS.has(obs.thread.status) && !incluirUltimaResposta) {
    obs.run = { id: latest, status: obs.thread.status };
    return resultado('terminal', false);
  }
  if (runDaShell && obs.pedido && !incluirUltimaResposta) {
    obs.run = { id: latest, status: obs.thread.status };
    return resultado('precisa_intervencao', false);
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
    else if (obs.pedido) concluir('precisa_intervencao');
  };
  const aoReceber = (itens) => {
    for (const item of itens) {
      if (item.kind === 'snapshot') {
        const p = item.projection ?? {};
        const runs = p.runs ?? [];
        obs.run = runPedido ? runs.find((x) => x.id === runPedido) : (runs.find((x) => x.id === latest) ?? ultimoRun(runs));
        if (!obs.run) throw new ErroT3(`run ${runPedido ?? latest} não encontrado na thread ${threadId}`, { codigo: 'run_inexistente' });
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
        } else if (type === 'thread.deleted') concluir('thread_apagada');
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
      sub.fim.then(() => resolve('subscription_encerrada'), reject);
    });
    if (motivo === 'cancelada') throw new Cancelada();
    if (motivo === 'prazo') {
      if (!obs.run) {
        // Shell observada mas snapshot não chegou: devolve o estado da shell.
        obs.run = { id: runPedido ?? latest, status: runDaShell ? obs.thread.status : null };
      }
      return resultado('prazo', !TERMINAIS.has(obs.run.status));
    }
    return resultado(motivo, false);
  } catch (e) {
    if (e instanceof Cancelada) throw e;
    ambientes.falhou(r, e);
    if (prazo.aborted && obs.thread && !(e instanceof ErroT3 && e.codigo === 'run_inexistente')) {
      obs.run ??= { id: runPedido ?? latest, status: runDaShell ? obs.thread.status : null };
      return resultado('prazo', !TERMINAIS.has(obs.run.status));
    }
    throw e;
  } finally {
    sub?.encerrar();
  }
}

