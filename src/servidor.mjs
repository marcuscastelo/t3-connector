// Servidor MCP somente leitura. Cada chamada escolhe o environment (`environment`; padrão
// da config, normalmente local) e só enxerga os projectIds autorizados nele: thread de
// outro projeto é recusada mesmo que o token do T3 alcance o environment inteiro.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jsonResult, strictRegistrar, toolErrorMapper } from 'mcp-connector-kit';
import { z } from 'zod';
import {
  estadoDaThread,
  pedidosPendentes,
  resumoModelo,
  runAtivoDaShell,
  ultimaResposta,
} from './estado.mjs';
import { ForaDoEscopo } from './ambientes.mjs';
import { aguardarThread, TETO_MS } from './espera.mjs';
import { buscarThreads, buscarThreadsEmLote, EntradaInvalida, LIMITE_LOTE, MAX_CONSULTAS, PRAZO_AMBIENTE_MS, PRAZO_TOTAL_MS } from './busca-threads.mjs';
import { lerProviders, resumoProvider } from './providers.mjs';
import { assinatura, casaBusca, comparador, CursorInvalido, normalizar, paginar } from './paginacao.mjs';
import { Cancelada, ErroT3 } from './t3.mjs';
import { resumirPedidosRuntime } from './pedidos-runtime.mjs';
import { lerObservacaoComDados, SETTLEMENT_CONTRACT_VERSIONS } from './settlement.mjs';
import { GRUPOS, LIMITE_PADRAO, montarWorkset, PRAZO_AMBIENTE_MS as PRAZO_WORKSET_AMBIENTE, PRAZO_TOTAL_MS as PRAZO_WORKSET_TOTAL } from './workset.mjs';
import { compararShell, derivarExecucao } from './execucao.mjs';

export const VERSAO = '0.11.2';
const ESTADOS = ['running', 'needs_intervention', 'completed', 'failed', 'cancelled', 'no_run', 'unknown'];
const SO_LEITURA = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// Contrato de fontes de verdade da thread, repetido nas descrições das ferramentas que o
// expõem: o cliente não deve escolher sozinho entre sinais que falam de coisas diferentes.
const CONTRATO_ESTADO =
  'State contract: `state` is canonical and already resolves conflicting signals with this precedence: ' +
  '(1) pending runtime request → needs_intervention; (2) a run still active → running; ' +
  '(3) usage limit or proposed plan → needs_intervention; (4) otherwise the outcome of the latest run. ' +
  '`stateSource` (pending_request, active_run, usage_limit, proposed_plan, latest_run, no_run) says which signal decided; `runId` and `statusRun` describe that same run. ' +
  '`latestRunId`/`latestRunStatus` appear only when the newest run is not the one `state` describes: they are informational, and a cancelled newest run (a queued message promoted to steer or a cancelled queued run) does not mean the thread stopped. ' +
  '`model` is the thread\'s configured model and is canonical.';

// Contrato do bloco `execution` (src/execucao.mjs, docs/execution-snapshot.md).
const CONTRATO_EXECUCAO =
  'Execution contract: `execution` (contractVersion 1) is derived from ONE thread projection read and correlates runs, responses, requests, provider session and background work by ID; use it, not `state` alone, to decide whether to wait, continue or settle. ' +
  'A finished run is not finished work: `execution.background.pending` lists provider work that outlives the run (subagent, monitor, command, background_task; `holdsThread` false only for commands), `signals.backgroundWorkActive`/`backgroundWorkHoldsThread` are null when the read cannot prove absence (`background.knowledge` partial/unknown). ' +
  '`latestResponse.relation` says whether the latest assistant text belongs to the latest executed run (`signals.responseStale`); a run that ended without assistant text sets `signals.latestRunHasNoAssistantResponse`. Never treat an old response that says work is running as current state. ' +
  '`continuation.canStartNow` is true only with no active or queued run, no pending request/plan/usage limit and no background work holding the thread; `continuation.reasons` lists deterministic facts that leave work to pick up (background_work_ended_after_latest_run, latest_run_without_assistant_response, latest_run_failed); the target is always the same thread, never a new one. ' +
  '`coherence.status` shell_lagging means the top-level fields (from the shell) are older than `execution`; `execution` wins.';

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

/**
 * Sessão do provider da thread, escolhida como o T3 escolhe (mesma instância, a mais
 * recente). É informativa: o modelo dela pode ficar para trás após uma troca de modelo.
 */
export function resumoSessao(projecao, thread, modeloCanonico) {
  const sessao = (projecao.providerSessions ?? [])
    .filter((x) => !thread.providerInstanceId || x.providerInstanceId === undefined || x.providerInstanceId === thread.providerInstanceId)
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0];
  if (!sessao) return null;
  const divergente = Boolean(modeloCanonico?.model && sessao.model && sessao.model !== modeloCanonico.model);
  return {
    status: sessao.status,
    directory: sessao.cwd,
    model: sessao.model,
    informational: true,
    ...(divergente ? { note: `provider session still reports ${sessao.model}; the thread uses ${modeloCanonico.model} (\`activeRun.model\` while a run is active, otherwise \`model\`)` } : {}),
  };
}

/**
 * Shell e /bounded da mesma thread, relidos uma vez quando a shell não é da mesma versão
 * da projeção (outra mudança entrou entre as duas leituras). A projeção é uma transação;
 * a shell é só a primeira leitura, usada para autorização e para os campos do topo.
 */
/** Shell lida de novo: no OAuth all, `shell` devolve o inventário da invocação (em cache). */
export const lerShellFresca = (cliente, opcoes) => (typeof cliente.shellFresca === 'function' ? cliente.shellFresca(opcoes) : cliente.shell(opcoes));

export async function lerThreadCoerente({ r, cliente, signal, threadId, tentativas = 2 }) {
  let leitura;
  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    const shell = await (tentativa === 1 ? cliente.shell({ signal }) : lerShellFresca(cliente, { signal }));
    const thread = r.escopo.exigirThread(shell, threadId);
    const bounded = await cliente.thread(threadId, { signal });
    leitura = { shell, thread, bounded, tentativa };
    if (compararShell(thread, bounded.projection ?? {}).motivos.length === 0) break;
  }
  return leitura;
}

export function execucaoDaLeitura({ thread, bounded, tentativa }) {
  return derivarExecucao({
    projecao: bounded.projection ?? {},
    shellThread: thread,
    fonte: {
      kind: 'thread_snapshot',
      threadSequence: bounded.snapshotSequence ?? null,
      historyComplete: !bounded.hasMoreHistory,
      attempts: tentativa,
    },
  });
}

const resposta = jsonResult;

const erro = toolErrorMapper({
  expected: [ForaDoEscopo, ErroT3, Cancelada, CursorInvalido, EntradaInvalida],
  fallback: (e) => `failed to query T3: ${e?.message ?? e}`,
});

export function criarServidor({ ambientes, opcoesBusca = {}, opcoesProviders = {}, opcoesWorkset = {} }) {
  const servidor = new McpServer({ name: 't3-connector', version: VERSAO });
  const nomes = ambientes.registros.map((r) => r.alias).join(', ');
  const campoAmbiente = z.string().min(1).optional()
    .describe(`T3 environment (alias or environmentId): ${nomes}. Default when omitted: ${ambientes.padrao}. Project and thread IDs are only valid inside their own environment.`);

  /**
   * Registra a ferramenta com schema estrito: um parâmetro desconhecido (por exemplo um
   * nome antigo, como `ambiente`) é recusado pelo SDK, em vez de ser descartado e a
   * chamada cair no environment padrão. Ver docs/adr/0004.
   */
  const registrar = strictRegistrar(servidor);

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
      shape: {
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
      shape: {
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
        'Lists threads of the authorized projects of an environment with project, directory, model and state (running, needs_intervention, completed, failed, cancelled, no_run, unknown), most recently updated first. ' + CONTRATO_ESTADO + ' To find a thread by name use `search` (part of the title or threadId): `total` counts every match, not just the page. When `truncated: true`, repeat the call with `cursor` = `nextCursor` for the next page. Threads without a V2 run (imported history) only appear with includeNoRun; `hiddenNoRun` says how many were left out. Read-only.',
      shape: {
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
        'Includes archived threads (`archived`) and threads without a run. Results are ordered by environmentId and threadId; when `truncated: true`, repeat with `cursor` = `nextCursor`. ' + CONTRATO_ESTADO + ' Read-only.',
      shape: {
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

  const campoChave = z.string().min(1).max(200).describe('Your correlation label for this query (for example the title as the user said it); unique in the call and echoed in its result');
  const campoLimiteLote = z.number().int().min(1).max(20).optional().describe(`Maximum candidates returned for this query; default ${LIMITE_LOTE}. \`total\` and \`resolution\` always count every match`);
  const campoCursorLote = z.string().min(1).optional().describe('`nextCursor` of this same query from a previous call with the same queries and environments; omitted: first page');
  registrar(
    't3_thread_find_batch',
    {
      title: 'Resolve several thread references at once',
      description:
        `Resolves up to ${MAX_CONSULTAS} thread references (title, part of a title, or exact ID) in one call, reading each environment once. Use it instead of calling t3_buscar_threads once per name, for example before snoozing several threads. ` +
        'Each query has its own result, in the same order and with its `key`: `resolution` is `resolved` (exactly one candidate and every environment answered), `ambiguous` (more than one candidate, possibly in different environments or projects), `not_found` (zero candidates and every environment answered) or `inconclusive` (zero or one candidate but some environment failed, so the answer is unproven). ' +
        'Never pick a candidate of an ambiguous or inconclusive query on your own: show the candidates (environment, project, title, state) and ask the user. A resolved query gives the exact `environment.alias`, `threadId` and `project.projectId` to pass to write tools such as t3_thread_inbox_update_batch. ' +
        `Each environment has ${PRAZO_AMBIENTE_MS} ms and the whole call ${PRAZO_TOTAL_MS} ms; failures appear in \`environmentFailures\` (per query and for the call) and \`complete\` is false. ` +
        'Searches the threads each environment lists as live; deleted threads never appear and archived threads may be missing, so `not_found` only covers that universe. An invalid query (both or neither of search/threadId, `match` with threadId, repeated key) rejects the whole call before reading; an invalid cursor fails only its query (`status: "error"`). ' +
        'Candidates are ordered by environmentId and threadId. ' + CONTRATO_ESTADO + ' Read-only.',
      shape: {
        queries: z.array(z.union([
          z.strictObject({
            key: campoChave,
            search: z.string().min(1).describe('Part of the title or threadId, ignoring case and accents; with `match: "exact"`, the whole title or the exact ID'),
            match: z.enum(['partial', 'exact']).optional().describe('partial (substring, default) or exact (whole title, or exact ID)'),
            limit: campoLimiteLote,
            cursor: campoCursorLote,
          }),
          z.strictObject({
            key: campoChave,
            threadId: z.string().min(1).describe('Exact thread ID, compared literally'),
            limit: campoLimiteLote,
            cursor: campoCursorLote,
          }),
        ])).min(1).max(MAX_CONSULTAS).describe('One entry per reference to resolve: `{key, search, match?}` or `{key, threadId}`'),
        environments: z.array(z.string().min(1)).min(1).optional().describe(`Restrict every query to these environments (alias or environmentId): ${nomes}. Omitted: every configured environment`),
      },
      annotations: SO_LEITURA,
    },
    async (args, extra) => {
      try {
        return resposta(await buscarThreadsEmLote(ambientes, args, { ...opcoesBusca, signal: extra?.signal, resumir: (t, p) => resumoDaThread(t, p) }));
      } catch (e) {
        return erro(e);
      }
    },
  );

  registrar(
    't3_providers',
    {
      title: 'Provider instances of a T3 environment',
      description:
        'Lists the provider instances of one T3 environment from the same source as T3 Settings > Providers (`server.getConfig`), in T3 order and with nothing filtered: configured, default, disabled and unavailable instances all appear, with `enabled`, `installed`, `status` and `availability` as T3 reports them. ' +
        'Call it before the write actions thread.launch, thread.model-selection.set, provider.switch and delegated_task.request: `modelSelection.instanceId` is the exact `instanceId` here and `modelSelection.model` is a `models[].slug` of that instance; option ids and values come from `models[].capabilities.optionDescriptors`. ' +
        'IDs, display names and models belong to this environment only and are returned exactly as T3 sends them (keep case, underscores and hyphens); the same instanceId can have another display name or other models elsewhere. ' +
        'Each item keeps the T3 field names, limited to identity, state, runtime modes and models; `auth` carries only `status`. ' +
        'By default only the instances are listed; models with capabilities are large (tens of kB per environment), so pass `includeModels: true` with the chosen `instanceId`. Read-only.',
      shape: {
        environment: campoAmbiente,
        instanceId: z.string().min(1).optional().describe('Return only this instance; compared literally, case-sensitive'),
        includeModels: z.boolean().optional().describe('Include `models` with capabilities; default false. Use it with `instanceId`'),
      },
      annotations: SO_LEITURA,
    },
    noAmbiente(async ({ r, cliente, signal, instanceId, includeModels = false }) => {
      const todos = await lerProviders(cliente, { environmentIdEsperado: r.environmentId, signal, ...opcoesProviders });
      const providers = todos
        .filter((p) => instanceId === undefined || p.instanceId === instanceId)
        .map((p) => resumoProvider(p, { incluirModelos: includeModels }));
      return { source: 'server.getConfig', total: providers.length, providers };
    }),
  );

  registrar(
    't3_atencao',
    {
      title: 'What needs my attention in T3',
      description:
        'Threads of the authorized projects of an environment that need intervention (approval, question, plan, usage limit) or that failed and were not settled, with reason and identifier. ' + CONTRATO_ESTADO + ' Read-only.',
      shape: { environment: campoAmbiente },
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
    't3_workset',
    {
      title: 'Orchestrator workset across environments',
      description:
        'One call to rebuild an orchestration picture after losing context: every thread of the authorized projects in every configured environment (or only `environments`) that still needs a decision, in disjoint groups by this precedence: ' +
        `${GRUPOS.join(' > ')}. ` +
        'needs_intervention, running, background_pending (background tasks still pending, which can outlive a settle) and unknown include settled threads; the other groups only unsettled ones; snoozed holds unsettled threads whose snoozedUntil is still in the future. Settled idle threads and threads without a run are only counted. ' +
        '`completed` is a run outcome, not acceptance: completed_unsettled is work whose result still has to be absorbed and then continued, waited on or settled by you. ' +
        'Each item carries references and facts only (environment alias, threadId, projectId, state/stateSource/runId, pendingRequest, updatedAt, settled, snoozedUntil, pinned (null when the server does not report it), parent thread, linked PR); no conversation text. ' +
        'Groups are ordered by updatedAt, newest first, and cut at `limitPerGroup`; `counts` always counts every thread and `truncated` says how many were left out per group. ' +
        'Active queue, ready to consume without filtering: `actionable` (decide now: needs_intervention, unknown, failed_unsettled, completed_unsettled, cancelled_unsettled) and `inFlight` (running, background_pending), as {environment, threadId, group} in that group order. Settled idle threads, threads snoozed until a future time and archived threads are never in them; a pending request, an active run or background work keeps a thread in the queue even if settled or snoozed; an expired snooze returns the thread to its normal group. ' +
        '`archived` is listed apart and never mixed with today\'s work; while no validated source of archived threads exists it is {available: false, reason}, which does not mean there are none. ' +
        `Each environment has ${PRAZO_WORKSET_AMBIENTE} ms and the call ${PRAZO_WORKSET_TOTAL} ms; environments that fail are listed in \`environmentFailures\` with \`complete: false\`, and the groups still hold what the other environments returned, so an empty group with complete=false proves nothing. ` +
        'Next step per thread: t3_thread with that environment and threadId (add settlementContractVersion: 2 before deciding to settle). ' + CONTRATO_ESTADO + ' Read-only.',
      shape: {
        environments: z.array(z.string().min(1)).min(1).max(10).optional()
          .describe(`Environments to read (alias or environmentId): ${nomes}. Omitted: every configured environment`),
        limitPerGroup: z.number().int().min(1).max(100).optional().describe(`Maximum threads listed per group; default ${LIMITE_PADRAO}`),
      },
      annotations: SO_LEITURA,
    },
    async (args, extra) => {
      try {
        return resposta(await montarWorkset(ambientes, args, { ...opcoesWorkset, signal: extra?.signal, resumir: (t, p) => resumoDaThread(t, p) }));
      } catch (e) {
        return erro(e);
      }
    },
  );

  registrar(
    't3_thread',
    {
      title: 'Thread state and latest response',
      description:
        'Detailed state of an authorized thread, latest response and pending runtime requests. pendingRequests includes requestId, responseCapability, nextAction and content: user_input questions with IDs/options/field constraints, or approval prompt/options. Follow nextAction: answer questions with runtime-request.answer (answers keyed by question ID); approvals use runtime-request.approve (decision). thread.send does NOT answer a pending runtime request and can remain queued behind the blocked run. If contentAvailable is false, do not infer an answer: inspect the request in T3. Pass the thread environment. ' +
        CONTRATO_ESTADO + ' ' +
        '`activeRun` (present while a run is active) is that run with the model it executes; `latestRun` is the newest run and, when it differs from `activeRun`, is informational. ' +
        'Model precedence: `model` is what the thread runs next; `activeRun.model` is what the active run executes (fixed when the run was requested); `providerSession` (status, model) is the provider process as last reported and is informational only: it can keep the previous model after a model change and read `ready` while a run is active, so never use it to decide the model or the state. ' +
        'Message `streaming` flags do not decide the state either. ' +
        CONTRATO_EXECUCAO + ' ' +
        'With `settlementContractVersion` (1 or 2) the whole answer (latestResponse, pendingRequests, activeRun, latestRun, execution) is built from one validated observation of the full thread snapshot, and adds `settlement` from that same observation (when it cannot be observed coherently, `settlement.complete` is false with no observationId and the rest comes from the usual read): `blockers` (pending_request, active_run, queued_work, unresolved_work, observation_incomplete; background work comes from that same `execution`), `eligibleMechanically`, `observationId`, `expectedRunId`, lifecycle fields (settledAt, settledOverride, unsettledAt, snoozedUntil, pinnedAt, autoSettleDisabledAt, linkedPullRequests) with `fieldAvailability`, and `warnings` (e.g. linked_pr_merge_can_auto_settle). ' +
        'Version 2 (recommended) uses the codes of `execution.continuation.blockers` (active_run, queued_runs, pending_request, proposed_plan, usage_limit, usage_limit_auto_resume, background_work_active, background_work_unknown) plus observation_incomplete, so unknown background work blocks; its observationId (obs2_) also changes with the workspace, the reviewed response text and the background work. Version 1 is unchanged. ' +
        '`eligibleMechanically: true` only means nothing objective blocks a settle; it is never acceptance of the delivered scope, which is your decision. To settle with protection pass expectedRunId and observationId in thread.settle `settleGuard` with the same version. Read-only.',
      shape: {
        environment: campoAmbiente,
        threadId: z.string().min(1),
        maxCharacters: z.number().int().min(200).max(6000).optional().describe('Maximum length of the latest response; default 1500'),
        settlementContractVersion: z.union(SETTLEMENT_CONTRACT_VERSIONS.map((v) => z.literal(v))).optional()
          .describe('Pass 2 (or 1) to add the `settlement` facts of that contract version (full snapshot read; heavier). Omitted: the answer is unchanged'),
      },
      annotations: SO_LEITURA,
    },
    noAmbiente(async ({ r, cliente, signal, threadId, maxCharacters: maxCaracteres = 1500, settlementContractVersion }) => {
      let settlement = null;
      let shell;
      let thread;
      let projecao;
      let history;
      let execution;
      if (settlementContractVersion) {
        shell = await cliente.shell({ signal });
        r.escopo.exigirThread(shell, threadId);
        const lido = await lerObservacaoComDados({
          environmentId: r.environmentId,
          threadId,
          // Mesma ACL da leitura: thread de projeto não autorizado não é observada.
          lerShell: async () => {
            const atual = await lerShellFresca(cliente, { signal });
            return { ...atual, threads: (atual.threads ?? []).filter((t) => r.escopo.projetoPermitido(t.projectId)) };
          },
          lerCompleto: (id) => cliente.threadCompleto(id, { signal }),
          version: settlementContractVersion,
        });
        settlement = lido.observacao;
        if (lido.thread) {
          // O pacote inteiro (resposta, pedidos, runs, execution, settlement) vem da mesma
          // observação validada: expectedRunId nunca descreve um run cuja entrega não foi
          // mostrada, e os bloqueios de fundo do settlement são os de `execution`.
          thread = lido.thread;
          projecao = lido.snapshot.projection;
          history = { complete: true, payloadBudgetExceeded: false, source: 'full_snapshot' };
          execution = lido.execucao;
        }
      }
      if (!projecao) {
        // Sem opt-in, ou observação incompleta (settlement sem observationId: não serve de guard).
        const leitura = await lerThreadCoerente({ r, cliente, signal, threadId });
        ({ shell, thread } = leitura);
        projecao = leitura.bounded.projection;
        history = { complete: !leitura.bounded.hasMoreHistory, payloadBudgetExceeded: Boolean(leitura.bounded.payloadBudgetExceeded) };
        execution = execucaoDaLeitura(leitura);
      }
      const projeto = projetosPorId(shell).get(thread.projectId);
      const pendentes = pedidosPendentes(projecao);
      const resumo = resumoDaThread(thread, projeto, pendentes);
      const ativo = runAtivoDaShell(thread);
      const runDoAtivo = ativo && (projecao.runs ?? []).find((x) => x.id === ativo.runId);
      const runDoUltimo = (projecao.runs ?? []).find((x) => x.id === thread.latestRunId);
      const activeRun = ativo
        ? {
            runId: ativo.runId,
            ordinal: runDoAtivo?.ordinal ?? null,
            status: runDoAtivo?.status ?? ativo.status,
            model: resumoModelo(runDoAtivo?.modelSelection),
          }
        : null;
      return {
        ...resumo,
        pendingRequests: resumirPedidosRuntime(projecao, thread),
        providerSession: resumoSessao(projecao, thread, activeRun?.model ?? resumo.model),
        activeRun,
        // Último run pela shell (a mesma regra do T3); o snapshot pode não trazer todos os runs.
        latestRun: thread.latestRunId ? { runId: thread.latestRunId, ordinal: runDoUltimo?.ordinal ?? null, status: thread.status } : null,
        latestResponse: ultimaResposta(projecao, maxCaracteres),
        history,
        execution,
        ...(settlementContractVersion ? { settlement } : {}),
      };
    }),
  );

  registrar(
    't3_mensagens',
    {
      title: 'Recent thread messages',
      description:
        'Latest user and assistant messages of an authorized thread, oldest first, with truncated text. They come from the recent window of the thread; `history.complete` false means older messages exist outside it. Read-only.',
      shape: {
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
        'Without `runId` it follows the run the thread is executing (the active run), not a newer queued run that was cancelled or promoted to steer; `runId`, `statusRun` and `state` describe the followed run only. ' +
        'Returns immediately if the run already finished, if there is no run or if a request is pending. Reaching the deadline is not an error: it returns timedOut=true with the current state. ' +
        'A finished run is not finished work: the provider can keep background work (subagent, monitor, background command) after the run ends. With until=execution_idle the wait follows that work too and returns `execution` (same contract as t3_thread.execution). ' +
        'To follow a long thread, call again later, between conversation turns; in voice use 1000-2000 ms. Never interrupts or changes the thread. Read-only.',
      shape: {
        environment: z.string().min(1).describe(`Environment where the thread lives (required): ${nomes}`),
        threadId: z.string().min(1),
        timeoutMs: z.number().int().min(1).max(TETO_MS).describe(`Total deadline for the call in ms, 1-${TETO_MS}; voice: 1000-2000`),
        runId: z.string().min(1).optional().describe('Run to follow; default: the active run when the call starts, otherwise the latest run. Only with until=run_terminal'),
        until: z.enum(['run_terminal', 'execution_idle']).optional().describe('run_terminal (default): return when the followed run ends. execution_idle: return when the thread has no active or queued run, no pending intervention and no background work that holds it (subagent, monitor, unnamed task), stable for 1.5 s; the result carries `execution` and `backgroundClearedDuringWait`'),
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
