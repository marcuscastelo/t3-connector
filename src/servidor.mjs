// Servidor MCP somente leitura. Cada chamada escolhe o environment (`environment`; padrão
// da config, normalmente local) e só enxerga os projectIds autorizados nele: thread de
// outro projeto é recusada mesmo que o token do T3 alcance o environment inteiro.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  estadoDaThread,
  pedidosPendentes,
  resumoModelo,
  ultimaResposta,
} from './estado.mjs';
import { ForaDoEscopo } from './ambientes.mjs';
import { aguardarThread, TETO_MS } from './espera.mjs';
import { buscarThreads, EntradaInvalida, PRAZO_AMBIENTE_MS, PRAZO_TOTAL_MS } from './busca-threads.mjs';
import { assinatura, casaBusca, comparador, CursorInvalido, normalizar, paginar } from './paginacao.mjs';
import { Cancelada, ErroT3 } from './t3.mjs';
import { resumirPedidosRuntime } from './pedidos-runtime.mjs';

export const VERSAO = '0.8.0';
const ESTADOS = ['running', 'needs_intervention', 'completed', 'failed', 'cancelled', 'no_run', 'unknown'];
const SO_LEITURA = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function projetosPorId(shell) {
  return new Map((shell.projects ?? []).map((p) => [p.id, p]));
}

export function resumoDaThread(thread, projeto, pendentes = []) {
  return {
    threadId: thread.id,
    title: thread.title,
    project: projeto ? { projectId: projeto.id, title: projeto.title } : { projectId: thread.projectId },
    directory: thread.worktreePath ?? projeto?.workspaceRoot ?? null,
    branch: thread.branch ?? null,
    model: resumoModelo(thread.modelSelection),
    runtimeMode: thread.runtimeMode,
    ...estadoDaThread(thread, pendentes),
    updatedAt: thread.updatedAt,
    settled: Boolean(thread.settledAt),
  };
}

function resposta(dados) {
  return { content: [{ type: 'text', text: JSON.stringify(dados, null, 1) }], structuredContent: dados };
}

function erro(e) {
  const mensagem = e instanceof ForaDoEscopo || e instanceof ErroT3 || e instanceof Cancelada || e instanceof CursorInvalido || e instanceof EntradaInvalida
    ? e.message
    : `failed to query T3: ${e?.message ?? e}`;
  return { content: [{ type: 'text', text: mensagem }], isError: true };
}

export function criarServidor({ ambientes, opcoesBusca = {} }) {
  const servidor = new McpServer({ name: 't3-connector', version: VERSAO });
  const nomes = ambientes.registros.map((r) => r.alias).join(', ');
  const campoAmbiente = z.string().min(1).optional()
    .describe(`T3 environment (alias or environmentId): ${nomes}. Default when omitted: ${ambientes.padrao}. Project and thread IDs are only valid inside their own environment.`);

  /**
   * Registra a ferramenta com schema estrito: um parâmetro desconhecido (por exemplo um
   * nome antigo, como `ambiente`) é recusado pelo SDK, em vez de ser descartado e a
   * chamada cair no environment padrão. Ver docs/adr/0004.
   */
  const registrar = (nome, { forma, ...config }, fn) =>
    servidor.registerTool(nome, { ...config, inputSchema: z.strictObject(forma) }, fn);

  /** Executa a ferramenta no environment escolhido, com o sinal de cancelamento do cliente. */
  const noAmbiente = (fn) => async (args, extra) => {
    try {
      const r = ambientes.resolver(args.environment);
      const dados = await ambientes.usar(r, (cliente) => fn({ ...args, r, cliente, signal: extra?.signal }), { signal: extra?.signal });
      return resposta({ environment: ambientes.identidade(r), ...dados });
    } catch (e) {
      return erro(e);
    }
  };

  registrar(
    't3_ambientes',
    {
      title: 'Configured T3 environments',
      description:
        'Lists the T3 environments this connector can read (e.g. local = this machine, remoto = another one over SSH), with the default, the transport and whether each responds right now. Pass the alias in the `environment` parameter of the other tools. Read-only.',
      forma: {
        check: z.boolean().optional().describe('Try to connect to each environment (up to 4 s); default true'),
      },
      annotations: SO_LEITURA,
    },
    async ({ check = true }, extra) => {
      try {
        return resposta({ default: ambientes.padrao, environments: await ambientes.listar({ verificar: check, signal: extra?.signal }) });
      } catch (e) {
        return erro(e);
      }
    },
  );

  const campoCursor = z.string().min(1).optional()
    .describe('`nextCursor` from the previous page, with the same environment and filters; omitted: first page');

  registrar(
    't3_projetos',
    {
      title: 'Authorized T3 projects',
      description:
        'Lists the authorized projects of a T3 environment, with directory and counts of threads running or needing intervention, ordered by title. `total` comes before the list; use `search` (part of the title or projectId) and `limit` in environments with many projects. When `truncated: true`, repeat the call with `cursor` = `nextCursor` for the next page. Read-only.',
      forma: {
        environment: campoAmbiente,
        search: z.string().min(1).optional().describe('Filter by part of the title or projectId, ignoring case and accents'),
        limit: z.number().int().min(1).optional().describe('Maximum projects per page; `total` always counts every match'),
        cursor: campoCursor,
      },
      annotations: SO_LEITURA,
    },
    noAmbiente(async ({ r, cliente, signal, search: busca, limit: limite, cursor }) => {
      const shell = await cliente.shell({ signal });
      const threads = r.escopo.threadsVisiveis(shell);
      const casados = (shell.projects ?? [])
        .filter((p) => r.escopo.projetoPermitido(p.id))
        .filter((p) => casaBusca(busca, p.title, p.id));
      const chave = (p) => [normalizar(p.title), p.id];
      const { pagina, truncado, proximoCursor } = paginar({
        itens: casados.sort((a, b) => comparador()(chave(a), chave(b))),
        consulta: assinatura(['t3_projetos', r.environmentId, normalizar(busca ?? '')]),
        cursor,
        limite,
        chave,
        comparar: comparador(),
      });
      const projetos = pagina.map((p) => {
        const doProjeto = threads.filter((t) => t.projectId === p.id).map((t) => estadoDaThread(t).state);
        return {
          projectId: p.id,
          title: p.title,
          directory: p.workspaceRoot,
          runningThreads: doProjeto.filter((e) => e === 'running').length,
          threadsNeedingIntervention: doProjeto.filter((e) => e === 'needs_intervention').length,
        };
      });
      return {
        total: casados.length,
        ...(busca ? { search: busca } : {}),
        returned: projetos.length,
        truncated: truncado,
        ...(proximoCursor ? { nextCursor: proximoCursor } : {}),
        projects: projetos,
      };
    }),
  );

  registrar(
    't3_threads',
    {
      title: 'T3 threads',
      description:
        'Lists threads of the authorized projects of an environment with project, directory, model and state (running, needs_intervention, completed, failed, cancelled, no_run, unknown), most recently updated first. To find a thread by name use `search` (part of the title or threadId): `total` counts every match, not just the page. When `truncated: true`, repeat the call with `cursor` = `nextCursor` for the next page. Threads without a V2 run (imported history) only appear with includeNoRun; `hiddenNoRun` says how many were left out. Read-only.',
      forma: {
        environment: campoAmbiente,
        projectId: z.string().optional().describe('Restrict to one authorized project of this environment'),
        state: z.enum(ESTADOS).optional().describe('Filter by state'),
        includeNoRun: z.boolean().optional().describe('Include threads without a V2 run; default false'),
        search: z.string().min(1).optional().describe('Filter by part of the title or threadId, ignoring case and accents'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum threads per page; default 20'),
        cursor: campoCursor,
      },
      annotations: SO_LEITURA,
    },
    noAmbiente(async ({ r, cliente, signal, projectId, state: estado, includeNoRun: incluirSemExecucao = false, search: busca, limit: limite = 20, cursor }) => {
      if (projectId) r.escopo.exigirProjeto(projectId);
      const shell = await cliente.shell({ signal });
      const projetos = projetosPorId(shell);
      const candidatas = r.escopo
        .threadsVisiveis(shell)
        .filter((t) => !projectId || t.projectId === projectId)
        .filter((t) => casaBusca(busca, t.title, t.id))
        .map((t) => resumoDaThread(t, projetos.get(t.projectId)));
      const lista = candidatas.filter((t) => (estado ? t.state === estado : incluirSemExecucao || t.state !== 'no_run'));
      const ocultas = estado || incluirSemExecucao ? 0 : candidatas.length - lista.length;
      const chave = (t) => [t.updatedAt ?? '', t.threadId];
      const comparar = comparador([true, false]);
      const { pagina, truncado, proximoCursor, alterados } = paginar({
        itens: lista.sort((a, b) => comparar(chave(a), chave(b))),
        consulta: assinatura(['t3_threads', r.environmentId, projectId ?? null, estado ?? null, incluirSemExecucao, normalizar(busca ?? '')]),
        cursor,
        limite,
        chave,
        comparar,
        versao: (t) => t.updatedAt ?? '',
      });
      return {
        total: lista.length,
        ...(busca ? { search: busca } : {}),
        returned: pagina.length,
        truncated: truncado,
        ...(proximoCursor ? { nextCursor: proximoCursor } : {}),
        ...(alterados ? { changedSinceStart: alterados } : {}),
        ...(ocultas ? { hiddenNoRun: ocultas } : {}),
        threads: pagina,
      };
    }),
  );

  registrar(
    't3_buscar_threads',
    {
      title: 'Find threads across environments',
      description:
        'Finds threads by title or ID in every configured environment (or only in `environment`) and returns each candidate with the environment where it lives (`environment: {alias, environmentId, name}`). ' +
        'Pass exactly one of `search` (part of the title or ID, or the whole title with `match: "exact"`) or `threadId` (exact ID). ' +
        `Each environment has ${PRAZO_AMBIENTE_MS} ms and the whole search ${PRAZO_TOTAL_MS} ms; environments that fail or time out are listed in \`environmentFailures\` and \`complete\` is false, so zero results then do not prove the thread is missing. ` +
        'The same title or ID can exist in several environments: never pick one on your own; ask the user when `total` > 1, then call the other tools with the chosen environment (`environment` parameter) and `threadId`. ' +
        'Includes archived threads (`archived`) and threads without a run. Results are ordered by environmentId and threadId; when `truncated: true`, repeat with `cursor` = `nextCursor`. Read-only.',
      forma: {
        search: z.string().min(1).optional().describe('Part of the title or threadId, ignoring case and accents; exclusive with threadId'),
        threadId: z.string().min(1).optional().describe('Exact thread ID, compared literally; exclusive with search'),
        match: z.enum(['partial', 'exact']).optional().describe('With search: partial (substring, default) or exact (whole title, or exact ID)'),
        environment: z.string().min(1).optional().describe(`Restrict the search to one environment (alias or environmentId): ${nomes}. Omitted: every configured environment`),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum threads per page; default 20. `total` counts every match in the environments that answered'),
        cursor: z.string().min(1).optional().describe('`nextCursor` from the previous page of the same search; omitted: first page'),
      },
      annotations: SO_LEITURA,
    },
    async (args, extra) => {
      try {
        return resposta(await buscarThreads(ambientes, args, { ...opcoesBusca, signal: extra?.signal, resumir: (t, p) => resumoDaThread(t, p) }));
      } catch (e) {
        return erro(e);
      }
    },
  );

  registrar(
    't3_atencao',
    {
      title: 'What needs my attention in T3',
      description:
        'Threads of the authorized projects of an environment that need intervention (approval, question, plan, usage limit) or that failed and were not settled, with reason and identifier. Read-only.',
      forma: { environment: campoAmbiente },
      annotations: SO_LEITURA,
    },
    noAmbiente(async ({ r, cliente, signal }) => {
      const shell = await cliente.shell({ signal });
      const projetos = projetosPorId(shell);
      const itens = r.escopo
        .threadsVisiveis(shell)
        .map((t) => resumoDaThread(t, projetos.get(t.projectId)))
        .filter((t) => t.state === 'needs_intervention' || (t.state === 'failed' && !t.settled));
      return { total: itens.length, threads: itens };
    }),
  );

  registrar(
    't3_thread',
    {
      title: 'Thread state and latest response',
      description:
        'Detailed state of an authorized thread, latest response and pending runtime requests. pendingRequests includes requestId, responseCapability, nextAction and content: user_input questions with IDs/options/field constraints, or approval prompt/options. Follow nextAction: answer questions with runtime-request.answer (answers keyed by question ID); approvals use runtime-request.approve (decision). thread.send does NOT answer a pending runtime request and can remain queued behind the blocked run. If contentAvailable is false, do not infer an answer: inspect the request in T3. Pass the thread environment. Read-only.',
      forma: {
        environment: campoAmbiente,
        threadId: z.string().min(1),
        maxCharacters: z.number().int().min(200).max(6000).optional().describe('Maximum length of the latest response; default 1500'),
      },
      annotations: SO_LEITURA,
    },
    noAmbiente(async ({ r, cliente, signal, threadId, maxCharacters: maxCaracteres = 1500 }) => {
      const shell = await cliente.shell({ signal });
      const thread = r.escopo.exigirThread(shell, threadId);
      const projeto = projetosPorId(shell).get(thread.projectId);
      const bounded = await cliente.thread(threadId, { signal });
      const projecao = bounded.projection;
      const pendentes = pedidosPendentes(projecao);
      const sessao = (projecao.providerSessions ?? []).at(-1) ?? null;
      const runs = [...(projecao.runs ?? [])].sort((a, b) => a.ordinal - b.ordinal);
      return {
        ...resumoDaThread(thread, projeto, pendentes),
        pendingRequests: resumirPedidosRuntime(projecao, thread),
        providerSession: sessao ? { status: sessao.status, directory: sessao.cwd, model: sessao.model } : null,
        latestRun: runs.length ? { runId: runs.at(-1).id, ordinal: runs.at(-1).ordinal, status: runs.at(-1).status } : null,
        latestResponse: ultimaResposta(projecao, maxCaracteres),
        history: { complete: !bounded.hasMoreHistory, payloadBudgetExceeded: Boolean(bounded.payloadBudgetExceeded) },
      };
    }),
  );

  registrar(
    't3_mensagens',
    {
      title: 'Recent thread messages',
      description:
        'Latest user and assistant messages of an authorized thread, oldest first, with truncated text. They come from the recent window of the thread; `history.complete` false means older messages exist outside it. Read-only.',
      forma: {
        environment: campoAmbiente,
        threadId: z.string().min(1),
        limit: z.number().int().min(1).max(20).optional().describe('Number of messages; default 6'),
        maxCharacters: z.number().int().min(100).max(4000).optional().describe('Maximum characters per message; default 800'),
      },
      annotations: SO_LEITURA,
    },
    noAmbiente(async ({ r, cliente, signal, threadId, limit: limite = 6, maxCharacters: maxCaracteres = 800 }) => {
      const shell = await cliente.shell({ signal });
      r.escopo.exigirThread(shell, threadId);
      const bounded = await cliente.thread(threadId, { signal });
      const mensagens = (bounded.projection.messages ?? []).filter((m) => m.text).slice(-limite).map((m) => ({
        messageId: m.id,
        role: m.role,
        text: m.text.length > maxCaracteres ? m.text.slice(0, maxCaracteres) + '…' : m.text,
        truncated: m.text.length > maxCaracteres,
        streaming: Boolean(m.streaming),
        createdAt: m.createdAt,
      }));
      return {
        threadId,
        messages: mensagens,
        history: { complete: !bounded.hasMoreHistory, payloadBudgetExceeded: Boolean(bounded.payloadBudgetExceeded) },
      };
    }),
  );

  registrar(
    't3_aguardar_thread',
    {
      title: 'Wait a few seconds for a thread',
      description:
        `Short wait (up to ${TETO_MS} ms) for the run of an authorized thread to finish or to request intervention, driven by T3 events, without polling. ` +
        'Returns immediately if the run already finished, if there is no run or if a request is pending. Reaching the deadline is not an error: it returns timedOut=true with the current state. ' +
        'To follow a long thread, call again later, between conversation turns; in voice use 1000-2000 ms. Never interrupts or changes the thread. Read-only.',
      forma: {
        environment: z.string().min(1).describe(`Environment where the thread lives (required): ${nomes}`),
        threadId: z.string().min(1),
        timeoutMs: z.number().int().min(1).max(TETO_MS).describe(`Total deadline for the call in ms, 1-${TETO_MS}; voice: 1000-2000`),
        runId: z.string().min(1).optional().describe('Run to follow; default: the latest run when the call starts'),
        includeLatestResponse: z.boolean().optional().describe('Include the latest assistant response of that run; default false'),
        maxCharacters: z.number().int().min(100).max(4000).optional().describe('Maximum length of the latest response; default 800'),
      },
      annotations: SO_LEITURA,
    },
    async (args, extra) => {
      try {
        return resposta(await aguardarThread(ambientes, args, { signal: extra?.signal }));
      } catch (e) {
        return erro(e);
      }
    },
  );

  return servidor;
}
