// Servidor MCP somente leitura. Cada chamada pode escolher o environment (`environment`),
// e então só enxerga os projectIds autorizados nele: thread de outro projeto é recusada
// mesmo que o token do T3 alcance o environment inteiro. Sem `environment` não há padrão:
// listagens e descoberta varrem todos os environments e cada item diz de onde veio;
// leitura de thread por ID localiza o ID em todos e só prossegue se ele existir num só.
// Ver docs/adr/0005.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jsonResult, strictRegistrar, toolErrorMapper } from 'mcp-connector-kit';
import { z } from 'zod';
import {
  estadoDaThread,
  marcadorWoke,
  pedidosPendentes,
  resumoModelo,
  runAtivoDaShell,
  ultimaResposta,
} from './estado.mjs';
import { ForaDoEscopo } from './ambientes.mjs';
import { aguardarThread, TETO_MS } from './espera.mjs';
import { buscarThreads } from './busca-threads.mjs';
import { assinaturaCoberta, EntradaInvalida, PRAZO_AMBIENTE_MS, PRAZO_TOTAL_MS, resumoCobertura, traduzirCursorInvalido, varrerAmbientes } from './varredura.mjs';
import { lerProviders, resumoProvider } from './providers.mjs';
import { casaBusca, comparador, CursorInvalido, normalizar, paginar } from './paginacao.mjs';
import { Cancelada, ErroT3 } from './t3.mjs';
import { resumirPedidosRuntime } from './pedidos-runtime.mjs';
import { lerThreadsEmLote, MAX_ALVOS, PRAZO_MAX_MS, PRAZO_PADRAO_MS } from './leitura-lote.mjs';
import { LIMITE_MAXIMO, LIMITE_PADRAO, snapshotPlanoControle } from './plano-controle.mjs';

export const VERSAO = '0.15.0';
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

// Marcador Woke: ortogonal ao `state`, derivado como no T3 (ver marcadorWoke em estado.mjs).
const CONTRATO_WOKE =
  'Woke contract: `woke: true` means the thread woke from a snooze (its snooze time passed, or it raised its hand early: pending request, fresh failure, or a run completed after the snooze) and nobody has acknowledged it yet, matching the "Woke" marker in the T3 sidebar. ' +
  '`wokeAt` is when it woke and can stay set after acknowledgement; null when the thread never snoozed or is still snoozed. ' +
  '`woke: null` means this T3 server does not expose enough shared state (snooze or visited watermark) to decide. ' +
  '`woke` is independent of `state` and of `settled`, it is unrelated to the `completionWake` policy of delegated tasks, and reading never acknowledges it.';

// Contrato de escopo das leituras sem `environment`, repetido nas descrições.
const CONTRATO_ESCOPO =
  'Scope contract: without `environment` every configured environment is queried and each item carries `environment: {alias, environmentId, name}`; ' +
  `each environment has ${PRAZO_AMBIENTE_MS} ms and the whole call ${PRAZO_TOTAL_MS} ms. ` +
  '`queriedEnvironments` lists the ones that answered (with `found`), `environmentFailures` the ones that failed, timed out or refused the query, and `complete` is false whenever any failed: a result with `complete: false` is partial, so an empty list then does not prove absence. ' +
  'With `environment` only that one is read and a failure there is an error.';

function projetosPorId(shell) {
  return new Map((shell.projects ?? []).map((p) => [p.id, p]));
}

export function resumoDaThread(thread, projeto, pendentes = [], agora = new Date().toISOString()) {
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
    ...marcadorWoke(thread, agora),
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
 * Detalhe de uma thread autorizada (o resultado de t3_thread), julgado sobre `shell`.
 * Compartilhado por t3_thread e t3_thread_read_batch para manter um contrato só.
 */
export async function detalheDaThread({ r, cliente, shell, threadId, signal, maxCaracteres = 1500 }) {
  const thread = r.escopo.exigirThread(shell, threadId);
  const projeto = projetosPorId(shell).get(thread.projectId);
  const bounded = await cliente.thread(threadId, { signal });
  const projecao = bounded.projection;
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
    history: { complete: !bounded.hasMoreHistory, payloadBudgetExceeded: Boolean(bounded.payloadBudgetExceeded) },
  };
}

const resposta = jsonResult;

const erro = toolErrorMapper({
  expected: [ForaDoEscopo, ErroT3, Cancelada, CursorInvalido, EntradaInvalida],
  fallback: (e) => `failed to query T3: ${e?.message ?? e}`,
});

const identidadeCompleta = (ambientes, r, info) => ({ ...ambientes.identidade(r), name: info?.nome ?? null });

/**
 * Listagem sobre `ambientes`. `colher(ctx)` lê um environment e devolve `{ itens, ...extras }`,
 * cada item já com `environment`; `montar({ colhidos, args, cobertura })` fecha a resposta
 * como `{ campos, lista: { nome, itens } }`. Com `environment`, só aquele environment é
 * lido e qualquer falha nele é erro (como sempre foi). Sem `environment`, a varredura lê
 * todos: falha de um vira `environmentFailures` e `complete: false`, nunca uma lista
 * que pareceria completa. Compartilhada pelas ferramentas MCP e pelo núcleo ops.
 */
export async function executarListagem(ambientes, { colher, montar }, args, { signal, opcoesBusca = {} } = {}) {
  // Um só instante por chamada: o marcador Woke depende do relógio.
  const agora = new Date().toISOString();
  let varredura;
  let explicito = null;
  if (args.environment !== undefined) {
    explicito = ambientes.resolver(args.environment);
    const r = explicito;
    const { valor, info } = await ambientes.usar(r, async (cliente, info) => ({
      valor: await colher({ ...args, r, cliente, info, signal, agora, ambiente: identidadeCompleta(ambientes, r, info), explicito: true }),
      info,
    }), { signal });
    const ambiente = identidadeCompleta(ambientes, r, info);
    varredura = {
      sucesso: [{ r, ambiente, valor }],
      falhas: [],
      cobertura: { filter: r.environmentId, selected: [r.environmentId], answered: [r.environmentId] },
    };
  } else {
    varredura = await varrerAmbientes(ambientes, {
      signal,
      ...opcoesBusca,
      porAmbiente: (r, cliente, info, sinal) =>
        colher({ ...args, r, cliente, info, signal: sinal, agora, ambiente: identidadeCompleta(ambientes, r, info), explicito: false }),
    });
  }
  const { campos, lista } = montar({ args, colhidos: varredura.sucesso.map((x) => x.valor), cobertura: varredura.cobertura, falhas: varredura.falhas });
  return {
    ...(explicito ? { environment: ambientes.identidade(explicito) } : {}),
    ...campos,
    ...resumoCobertura(varredura),
    [lista.nome]: lista.itens,
  };
}

/** Pagina itens já varridos, com o cursor amarrado aos filtros e à cobertura. */
function paginarCoberto({ itens, partes, cobertura, cursor, limite, chave, comparar, versao }) {
  const consulta = assinaturaCoberta(partes, cobertura);
  try {
    return paginar({ itens: itens.sort((a, b) => comparar(chave(a), chave(b))), consulta, cursor, limite, chave, comparar, versao });
  } catch (e) {
    throw traduzirCursorInvalido(e, cursor, consulta);
  }
}

/**
 * Schemas (shapes zod) das leituras, por ferramenta. `nomes` só entra nas descrições do
 * campo `environment`. O núcleo ops valida com as mesmas shapes, com `environment` = o seu.
 */
export function formasLeitura(nomes) {
  const campoAmbiente = z.string().min(1).optional()
    .describe(`Restrict to one T3 environment (alias or environmentId): ${nomes}. Omitted: every configured environment is queried and each item says which one it came from. Project and thread IDs are only valid inside their own environment.`);
  const campoAmbienteDaThread = z.string().min(1).optional()
    .describe(`Environment where the thread lives (alias or environmentId): ${nomes}. Omitted: the thread ID is located across every configured environment and read only when every environment answered and exactly one has it; refused when it exists in more than one, when none has it, or when any environment failed or timed out (then the ID could still live there, so pass \`environment\` or retry).`);
  const campoCursor = z.string().min(1).optional()
    .describe('`nextCursor` from the previous page, with the same `environment` (or none) and filters; omitted: first page');
  return {
    t3_ambientes: {
      check: z.boolean().optional().describe('Try to connect to each environment (up to 4 s); default true'),
    },
    t3_projetos: {
      environment: campoAmbiente,
      search: z.string().min(1).optional().describe('Filter by part of the title or projectId, ignoring case and accents'),
      limit: z.number().int().min(1).optional().describe('Maximum projects per page; `total` always counts every match'),
      cursor: campoCursor,
    },
    t3_threads: {
      environment: campoAmbiente,
      projectId: z.string().optional().describe('Restrict to one authorized project; a projectId belongs to one environment, so without `environment` only the environment that authorizes it contributes'),
      state: z.enum(ESTADOS).optional().describe('Filter by state'),
      includeNoRun: z.boolean().optional().describe('Include threads without a V2 run; default false'),
      woke: z.boolean().optional().describe('Filter by the Woke marker: true = only woke threads, false = only threads not woke; omitted: no filter. Refused when the server cannot decide the marker for a matching thread'),
      search: z.string().min(1).optional().describe('Filter by part of the title or threadId, ignoring case and accents'),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum threads per page; default 20'),
      cursor: campoCursor,
    },
    t3_buscar_threads: {
      search: z.string().min(1).optional().describe('Part of the title or threadId, ignoring case and accents; exclusive with threadId'),
      threadId: z.string().min(1).optional().describe('Exact thread ID, compared literally; exclusive with search'),
      match: z.enum(['partial', 'exact']).optional().describe('With search: partial (substring, default) or exact (whole title, or exact ID)'),
      environment: z.string().min(1).optional().describe(`Restrict the search to one environment (alias or environmentId): ${nomes}. Omitted: every configured environment`),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum threads per page; default 20. `total` counts every match in the environments that answered'),
      cursor: z.string().min(1).optional().describe('`nextCursor` from the previous page of the same search; omitted: first page'),
    },
    t3_providers: {
      environment: campoAmbiente,
      instanceId: z.string().min(1).optional().describe('Return only this instance; compared literally, case-sensitive'),
      includeModels: z.boolean().optional().describe('Include `models` with capabilities; default false. Use it with `instanceId`'),
    },
    t3_atencao: { environment: campoAmbiente },
    t3_control_plane: {
      environment: z.string().min(1).optional().describe(`Restrict the snapshot to one environment (alias or environmentId): ${nomes}. Omitted: every configured environment`),
      limit: z.number().int().min(1).max(LIMITE_MAXIMO).optional().describe(`Maximum threads per list (needsIntervention, running, ready); default ${LIMITE_PADRAO}. \`total\` counts every match in the environments that answered`),
    },
    t3_thread: {
      environment: campoAmbienteDaThread,
      threadId: z.string().min(1),
      maxCharacters: z.number().int().min(200).max(6000).optional().describe('Maximum length of the latest response; default 1500'),
    },
    t3_thread_read_batch: {
      items: z.array(z.object({
        environment: z.string().min(1).describe(`Environment of this thread (alias or environmentId): ${nomes}`),
        threadId: z.string().min(1),
      }).strict()).min(1).max(MAX_ALVOS).describe(`Targets to read, 1-${MAX_ALVOS}; the answer keeps this order`),
      maxCharacters: z.number().int().min(200).max(6000).optional().describe('Maximum length of each latest response; default 1500'),
      timeoutMs: z.number().int().min(1000).max(PRAZO_MAX_MS).optional().describe(`Deadline for the whole call in ms; default ${PRAZO_PADRAO_MS}`),
    },
    t3_mensagens: {
      environment: campoAmbienteDaThread,
      threadId: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional().describe('Number of messages; default 6'),
      maxCharacters: z.number().int().min(100).max(4000).optional().describe('Maximum characters per message; default 800'),
    },
    t3_aguardar_thread: {
      environment: z.string().min(1).describe(`Environment where the thread lives (required): ${nomes}`),
      threadId: z.string().min(1),
      timeoutMs: z.number().int().min(1).max(TETO_MS).describe(`Total deadline for the call in ms, 1-${TETO_MS}; voice: 1000-2000`),
      runId: z.string().min(1).optional().describe('Run to follow; default: the active run when the call starts, otherwise the latest run'),
      includeLatestResponse: z.boolean().optional().describe('Include the latest assistant response of that run; default false'),
      maxCharacters: z.number().int().min(100).max(4000).optional().describe('Maximum length of the latest response; default 800'),
    },
  };
}

/** t3_projetos: projetos autorizados com contagem de threads rodando e pedindo intervenção. */
export const LISTAGEM_PROJETOS = {
  async colher({ r, cliente, signal, ambiente, search: busca }) {
    const shell = await cliente.shell({ signal });
    const threads = r.escopo.threadsVisiveis(shell);
    const itens = (shell.projects ?? [])
      .filter((p) => r.escopo.projetoPermitido(p.id))
      .filter((p) => casaBusca(busca, p.title, p.id))
      .map((p) => {
        const doProjeto = threads.filter((t) => t.projectId === p.id).map((t) => estadoDaThread(t).state);
        return {
          projectId: p.id,
          title: p.title,
          environment: ambiente,
          directory: p.workspaceRoot,
          runningThreads: doProjeto.filter((e) => e === 'running').length,
          threadsNeedingIntervention: doProjeto.filter((e) => e === 'needs_intervention').length,
        };
      });
    return { itens };
  },
  montar({ args: { search: busca, limit: limite, cursor }, colhidos, cobertura }) {
    const chave = (p) => [normalizar(p.title), p.environment.environmentId, p.projectId];
    const { pagina, truncado, proximoCursor } = paginarCoberto({
      itens: colhidos.flatMap((x) => x.itens),
      partes: ['t3_projetos', normalizar(busca ?? '')],
      cobertura,
      cursor,
      limite,
      chave,
      comparar: comparador(),
    });
    return {
      campos: {
        total: colhidos.reduce((n, x) => n + x.itens.length, 0),
        ...(busca ? { search: busca } : {}),
        returned: pagina.length,
        truncated: truncado,
        ...(proximoCursor ? { nextCursor: proximoCursor } : {}),
      },
      lista: { nome: 'projects', itens: pagina },
    };
  },
};

/** t3_threads: threads com estado canônico, filtros e paginação. */
export const LISTAGEM_THREADS = {
  async colher({ r, cliente, signal, agora, ambiente, explicito, projectId, state: estado, includeNoRun: incluirSemExecucao = false, woke, search: busca }) {
    if (projectId && !r.escopo.projetoPermitido(projectId)) {
      // Pedido explícito neste environment: recusa. Varredura: este environment só não
      // tem o projeto; a resposta diz se nenhum tinha.
      if (explicito) r.escopo.exigirProjeto(projectId);
      return { itens: [], ocultas: 0, semProjeto: true };
    }
    const shell = await cliente.shell({ signal });
    const projetos = projetosPorId(shell);
    const candidatas = r.escopo
      .threadsVisiveis(shell)
      .filter((t) => !projectId || t.projectId === projectId)
      .filter((t) => casaBusca(busca, t.title, t.id))
      .map((t) => ({ ...resumoDaThread(t, projetos.get(t.projectId), [], agora), environment: ambiente }));
    const passaEstado = (t) => (estado ? t.state === estado : incluirSemExecucao || t.state !== 'no_run');
    // Recusa em vez de devolver uma lista que pareceria completa sem as indecidíveis.
    if (woke !== undefined && candidatas.some((t) => t.woke === null && passaEstado(t))) {
      throw new EntradaInvalida('the woke filter is unavailable here: this T3 server does not expose the snooze or visited state needed to decide the Woke marker; repeat without `woke`');
    }
    const porWoke = woke === undefined ? candidatas : candidatas.filter((t) => t.woke === woke);
    const itens = porWoke.filter(passaEstado);
    return { itens, ocultas: estado || incluirSemExecucao ? 0 : porWoke.length - itens.length, semProjeto: false };
  },
  montar({ args: { projectId, state: estado, includeNoRun: incluirSemExecucao = false, woke, search: busca, limit: limite = 20, cursor }, colhidos, cobertura, falhas }) {
    if (projectId && colhidos.length && colhidos.every((x) => x.semProjeto)) {
      const pendentes = falhas.length ? `; environments that did not answer: ${falhas.map((f) => `${f.alias} (${f.code})`).join(', ')}` : '';
      throw new ForaDoEscopo(`project ${projectId} is not among the authorized projects of any environment that answered (${cobertura.answered.join(', ')})${pendentes}`);
    }
    const chave = (t) => [t.updatedAt ?? '', t.environment.environmentId, t.threadId];
    const comparar = comparador([true, false, false]);
    const { pagina, truncado, proximoCursor, alterados } = paginarCoberto({
      itens: colhidos.flatMap((x) => x.itens),
      partes: ['t3_threads', projectId ?? null, estado ?? null, incluirSemExecucao, normalizar(busca ?? ''), ...(woke === undefined ? [] : [{ woke }])],
      cobertura,
      cursor,
      limite,
      chave,
      comparar,
      versao: (t) => t.updatedAt ?? '',
    });
    const ocultas = colhidos.reduce((n, x) => n + x.ocultas, 0);
    return {
      campos: {
        total: colhidos.reduce((n, x) => n + x.itens.length, 0),
        ...(busca ? { search: busca } : {}),
        returned: pagina.length,
        truncated: truncado,
        ...(proximoCursor ? { nextCursor: proximoCursor } : {}),
        ...(alterados ? { changedSinceStart: alterados } : {}),
        ...(ocultas ? { hiddenNoRun: ocultas } : {}),
      },
      lista: { nome: 'threads', itens: pagina },
    };
  },
};

/** t3_providers: provider instances de server.getConfig, sem filtrar. */
export const listagemProviders = (opcoesProviders = {}) => ({
  async colher({ r, cliente, signal, ambiente, instanceId, includeModels = false }) {
    const todos = await lerProviders(cliente, { environmentIdEsperado: r.environmentId, signal, ...opcoesProviders });
    const itens = todos
      .filter((p) => instanceId === undefined || p.instanceId === instanceId)
      .map((p) => ({ ...resumoProvider(p, { incluirModelos: includeModels }), environment: ambiente }));
    return { itens };
  },
  montar({ colhidos }) {
    const itens = colhidos.flatMap((x) => x.itens);
    return { campos: { source: 'server.getConfig', total: itens.length }, lista: { nome: 'providers', itens } };
  },
});

/** t3_atencao: threads pedindo intervenção ou com falha não assentada. */
export const LISTAGEM_ATENCAO = {
  async colher({ r, cliente, signal, agora, ambiente }) {
    const shell = await cliente.shell({ signal });
    const projetos = projetosPorId(shell);
    const itens = r.escopo
      .threadsVisiveis(shell)
      .map((t) => ({ ...resumoDaThread(t, projetos.get(t.projectId), [], agora), environment: ambiente }))
      .filter((t) => t.state === 'needs_intervention' || (t.state === 'failed' && !t.settled));
    return { itens };
  },
  montar({ colhidos }) {
    const itens = colhidos.flatMap((x) => x.itens);
    return { campos: { total: itens.length }, lista: { nome: 'threads', itens } };
  },
};

/** t3_thread: detalhe sobre uma shell lida agora. */
export async function lerThreadDetalhada({ r, cliente, signal, threadId, maxCharacters: maxCaracteres = 1500, shell }) {
  return detalheDaThread({ r, cliente, shell: shell ?? await cliente.shell({ signal }), threadId, signal, maxCaracteres });
}

/** t3_mensagens: últimas mensagens de usuário e assistente da janela recente. */
export async function mensagensDaThread({ r, cliente, signal, threadId, limit: limite = 6, maxCharacters: maxCaracteres = 800, shell }) {
  r.escopo.exigirThread(shell ?? await cliente.shell({ signal }), threadId);
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
}

export function criarServidor({ ambientes, opcoesBusca = {}, opcoesProviders = {} }) {
  const servidor = new McpServer({ name: 't3-connector', version: VERSAO });
  const nomes = ambientes.registros.map((r) => r.alias).join(', ');
  const formas = formasLeitura(nomes);

  /**
   * Registra a ferramenta com schema estrito: um parâmetro desconhecido (por exemplo um
   * nome antigo, como `ambiente`) é recusado pelo SDK, em vez de ser descartado e a
   * chamada cair no environment padrão. Ver docs/adr/0004.
   */
  const registrar = strictRegistrar(servidor);

  /** Ferramenta de listagem (ver executarListagem). */
  const listagem = (definicao) => async (args, extra) => {
    try {
      return resposta(await executarListagem(ambientes, definicao, args, { signal: extra?.signal, opcoesBusca }));
    } catch (e) {
      return erro(e);
    }
  };

  const nomesDe = (lista) => lista.map((x) => x.alias).join(', ');

  /**
   * Localiza um threadId em todos os environments, só pela shell e com a ACL de cada um.
   * Só resolve quando todos responderam e exatamente um tem a thread. Mais de um: recusa.
   * Varredura incompleta (algum environment falhou ou não respondeu): recusa mesmo que um
   * respondente a tenha, porque o ID pode existir também no que não respondeu e a
   * ambiguidade não pode ser descartada. Nenhum a tem com todos respondendo: ausência
   * definitiva. Threads arquivadas contam, como em `exigirThread`.
   */
  async function localizarThread(threadId, signal) {
    const varredura = await varrerAmbientes(ambientes, {
      signal,
      ...opcoesBusca,
      async porAmbiente(r, cliente, _info, sinal) {
        const shell = await cliente.shell({ signal: sinal });
        try {
          r.escopo.exigirThread(shell, threadId);
          return 1;
        } catch (e) {
          if (e instanceof ForaDoEscopo) return 0;
          throw e;
        }
      },
    });
    const onde = varredura.sucesso.filter((x) => x.valor);
    const localizacao = resumoCobertura(varredura, (valor) => valor);
    if (onde.length > 1) {
      throw new EntradaInvalida(`thread ${threadId} exists in more than one environment (${nomesDe(onde.map((x) => x.ambiente))}); pass \`environment\` to choose one`);
    }
    if (varredura.falhas.length) {
      const semResposta = varredura.falhas.map((f) => `${f.alias} (${f.code})`).join(', ');
      const achado = onde.length
        ? `it was found in environment ${onde[0].ambiente.alias}, but `
        : varredura.sucesso.length ? `it was not found in ${nomesDe(varredura.sucesso.map((x) => x.ambiente))}, and ` : '';
      throw new EntradaInvalida(`thread ${threadId} could not be resolved without \`environment\`: ${achado}${semResposta} did not answer, so the ID could also live there and the ambiguity cannot be ruled out; pass \`environment\`${onde.length ? ` (${onde[0].ambiente.alias} to read the one found)` : ''} or retry later`);
    }
    if (onde.length === 1) return { r: onde[0].r, localizacao };
    throw new ForaDoEscopo(`thread ${threadId} not found in the authorized projects of any environment (every environment answered: ${nomesDe(varredura.sucesso.map((x) => x.ambiente))})`);
  }

  /**
   * Leitura de uma thread por ID. Com `environment`, lê só nele, sem procurar em outro.
   * Sem `environment`, localiza o ID em todos e lê onde ele existe; a resposta diz o
   * environment e, em `environmentDiscovery`, o que foi varrido.
   */
  const naThread = (fn) => async (args, extra) => {
    try {
      const signal = extra?.signal;
      let r;
      let localizacao = null;
      if (args.environment !== undefined) r = ambientes.resolver(args.environment);
      else ({ r, localizacao } = await localizarThread(args.threadId, signal));
      const dados = await ambientes.usar(r, (cliente) => fn({ ...args, r, cliente, signal }), { signal });
      return resposta({ environment: ambientes.identidade(r), ...(localizacao ? { environmentDiscovery: localizacao } : {}), ...dados });
    } catch (e) {
      return erro(e);
    }
  };

  registrar(
    't3_ambientes',
    {
      title: 'Configured T3 environments',
      description:
        'Lists the T3 environments this connector can read (e.g. local = this machine, remoto = another one over SSH), with the transport and whether each responds right now. There is no default environment: listing and discovery tools called without `environment` query every environment listed here; pass the alias in `environment` to restrict a read to one. Read-only.',
      shape: formas.t3_ambientes,
      annotations: SO_LEITURA,
    },
    async ({ check = true }, extra) => {
      try {
        return resposta({ environments: await ambientes.listar({ verificar: check, signal: extra?.signal }) });
      } catch (e) {
        return erro(e);
      }
    },
  );


  registrar(
    't3_projetos',
    {
      title: 'Authorized T3 projects',
      description:
        'Lists the authorized projects of every T3 environment (or only of `environment`), each with its `environment`, directory and counts of threads running or needing intervention, ordered by title. `total` comes before the list; use `search` (part of the title or projectId) and `limit` in environments with many projects. When `truncated: true`, repeat the call with `cursor` = `nextCursor` for the next page. ' + CONTRATO_ESCOPO + ' Read-only.',
      shape: formas.t3_projetos,
      annotations: SO_LEITURA,
    },
    listagem(LISTAGEM_PROJETOS),
  );

  registrar(
    't3_threads',
    {
      title: 'T3 threads',
      description:
        'Lists threads of the authorized projects of every T3 environment (or only of `environment`), each with its `environment`, project, directory, model and state (running, needs_intervention, completed, failed, cancelled, no_run, unknown), most recently updated first. ' + CONTRATO_ESTADO + ' ' + CONTRATO_WOKE + ' Use `woke: true` to list only woke threads; the filter is evaluated at read time, so a snooze expiring or an acknowledgement can change the selection between pages without changing `updatedAt`; an environment whose server cannot decide the marker refuses the filter (in `environmentFailures` when several are queried). To find a thread by name use `search` (part of the title or threadId): `total` counts every match, not just the page. When `truncated: true`, repeat the call with `cursor` = `nextCursor` for the next page. Threads without a V2 run (imported history) only appear with includeNoRun; `hiddenNoRun` says how many were left out. ' + CONTRATO_ESCOPO + ' Read-only.',
      shape: formas.t3_threads,
      annotations: SO_LEITURA,
    },
    listagem(LISTAGEM_THREADS),
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
      shape: formas.t3_buscar_threads,
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
    't3_providers',
    {
      title: 'Provider instances of the T3 environments',
      description:
        'Lists the provider instances of every T3 environment (or only of `environment`), each with its `environment`, from the same source as T3 Settings > Providers (`server.getConfig`), in T3 order and with nothing filtered: configured, default, disabled and unavailable instances all appear, with `enabled`, `installed`, `status` and `availability` as T3 reports them. ' +
        'Optional before the write actions thread.launch, thread.model-selection.set, provider.switch and delegated_task.request, which validate modelSelection themselves and answer an invalid one with the offered values; use it to browse. `modelSelection.instanceId` is the exact `instanceId` here and `modelSelection.model` is a `models[].slug` of that instance; option ids and values come from `models[].capabilities.optionDescriptors`. ' +
        'IDs, display names and models belong to this environment only and are returned exactly as T3 sends them (keep case, underscores and hyphens); the same instanceId can have another display name or other models elsewhere. ' +
        'Each item keeps the T3 field names, limited to identity, state, runtime modes and models; `auth` carries only `status`. ' +
        'By default only the instances are listed; models with capabilities are large (tens of kB per environment), so pass `includeModels: true` with the chosen `instanceId` and `environment`. ' + CONTRATO_ESCOPO + ' Read-only.',
      shape: formas.t3_providers,
      annotations: SO_LEITURA,
    },
    listagem(listagemProviders(opcoesProviders)),
  );

  registrar(
    't3_atencao',
    {
      title: 'What needs my attention in T3',
      description:
        'Threads of the authorized projects of every T3 environment (or only of `environment`) that need intervention (approval, question, plan, usage limit) or that failed and were not settled, each with its `environment`, reason and identifier. ' + CONTRATO_ESTADO + ' ' + CONTRATO_ESCOPO + ' Read-only.',
      shape: formas.t3_atencao,
      annotations: SO_LEITURA,
    },
    listagem(LISTAGEM_ATENCAO),
  );

  registrar(
    't3_control_plane',
    {
      title: 'Control plane snapshot across environments',
      description:
        'One call for what to act on next, across every configured environment (or only `environment`), each with its own ACL: threads `running`, threads in `needsIntervention`, and `ready` threads (latest run completed, failed or cancelled and not settled nor snoozed, or woke), each with `environment: {alias, environmentId, name}`, project, branch, directory, model, the canonical `state`, `activeRun`, a `pendingRequest` summary (requestId, kind, reason, since) and `next` (the t3_thread call that reads it). ' +
        '`ready` is potentially actionable, not acceptance: `readyReasons` says why and `blockers: [background_work_pending]` (with `actionableNow: false`) marks background work the shell reports. ' +
        `Each environment has ${PRAZO_AMBIENTE_MS} ms and the whole call ${PRAZO_TOTAL_MS} ms. Environments that fail or time out are listed in \`environmentFailures\` and \`complete\` is false: their threads are missing from every list and count, so the answer is NOT a global view; never conclude that nothing needs attention from an incomplete snapshot. ` +
        'Each environment is one shell read (`snapshotSequence`, `readAt`, counts by state in `queriedEnvironments`); environments are not read at one instant. Each list is ordered by `updatedAt` (newest first) and cut at `limit` with `total` and `truncated`; for more use t3_threads with `state` in that environment. Request content and answers are read with t3_thread. ' +
        CONTRATO_ESTADO + ' ' + CONTRATO_WOKE + ' Read-only.',
      shape: formas.t3_control_plane,
      annotations: SO_LEITURA,
    },
    async (args, extra) => {
      try {
        return resposta(await snapshotPlanoControle(ambientes, args, { ...opcoesBusca, signal: extra?.signal, resumir: resumoDaThread }));
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
        'Detailed state of an authorized thread, latest response and pending runtime requests. pendingRequests includes requestId, responseCapability, nextAction and content: user_input questions with IDs/options/field constraints, or approval prompt/options. Follow nextAction: answer questions with runtime-request.answer (answers keyed by question ID); approvals use runtime-request.approve (decision). thread.send does NOT answer a pending runtime request and can remain queued behind the blocked run. If contentAvailable is false, do not infer an answer: inspect the request in T3. Pass the thread environment when known; without it the ID is located across every environment and read only when all answered and exactly one has it (`environmentDiscovery` says what was queried); it is refused when the ID exists in more than one, in none, or when any environment failed or timed out, because the ID could still live there. ' +
        CONTRATO_ESTADO + ' ' + CONTRATO_WOKE + ' ' +
        '`activeRun` (present while a run is active) is that run with the model it executes; `latestRun` is the newest run and, when it differs from `activeRun`, is informational. ' +
        'Model precedence: `model` is what the thread runs next; `activeRun.model` is what the active run executes (fixed when the run was requested); `providerSession` (status, model) is the provider process as last reported and is informational only: it can keep the previous model after a model change and read `ready` while a run is active, so never use it to decide the model or the state. ' +
        'Message `streaming` flags do not decide the state either. Read-only.',
      shape: formas.t3_thread,
      annotations: SO_LEITURA,
    },
    naThread(lerThreadDetalhada),
  );

  registrar(
    't3_thread_read_batch',
    {
      title: 'State of several threads in one call',
      description:
        `Reads up to ${MAX_ALVOS} threads in one call, each named by \`{environment, threadId}\` (environment required per item; threads of different environments can be mixed). ` +
        'Each successful item carries in `thread` exactly what t3_thread returns for it: canonical `state`, `activeRun`, `latestRun`, `pendingRequests` with requestId/content/nextAction, `latestResponse` and `history`. ' +
        'Failure is per item: `items` keeps the input order with one entry per input (`index`), `status: "ok"` with `thread`, or `status: "error"` with `error: {code, reason}` ' +
        '(environment_not_allowed, thread_not_found, timeout, unavailable, environment_mismatch, http_<status>, connection_refused, global_timeout, failed); a broken target never hides the others and is never an empty success. ' +
        '`allSucceeded` is true only when every item is ok; `complete` is false when some item failed for a transient reason (deadline, environment down) and rereading it may succeed. ' +
        'Each environment is read from one shell observation per call (`environments[].observedAt`, also on each item); the thread projection is read right after, as in t3_thread. A repeated target is read once and answered at each position. ' +
        `\`timeoutMs\` (default ${PRAZO_PADRAO_MS}, max ${PRAZO_MAX_MS}) bounds the whole call, not each item. Reading never answers, approves or acknowledges anything. ` +
        CONTRATO_ESTADO + ' ' + CONTRATO_WOKE + ' Read-only.',
      shape: formas.t3_thread_read_batch,
      annotations: SO_LEITURA,
    },
    async ({ items, maxCharacters: maxCaracteres = 1500, timeoutMs }, extra) => {
      try {
        return resposta(await lerThreadsEmLote(ambientes, { items, timeoutMs }, {
          signal: extra?.signal,
          ler: ({ r, cliente, shell, threadId, signal }) => detalheDaThread({ r, cliente, shell, threadId, signal, maxCaracteres }),
        }));
      } catch (e) {
        return erro(e);
      }
    },
  );

  registrar(
    't3_mensagens',
    {
      title: 'Recent thread messages',
      description:
        'Latest user and assistant messages of an authorized thread, oldest first, with truncated text. They come from the recent window of the thread; `history.complete` false means older messages exist outside it. Pass the thread environment when known; without it the ID is located across every environment and read only when all answered and exactly one has it; refused when it exists in more than one, in none, or when any environment failed or timed out. Read-only.',
      shape: formas.t3_mensagens,
      annotations: SO_LEITURA,
    },
    naThread(mensagensDaThread),
  );

  registrar(
    't3_aguardar_thread',
    {
      title: 'Wait a few seconds for a thread',
      description:
        `Short wait (up to ${TETO_MS} ms) for the run of an authorized thread to finish or to request intervention, driven by T3 events, without polling. ` +
        'Without `runId` it follows the run the thread is executing (the active run), not a newer queued run that was cancelled or promoted to steer; `runId`, `statusRun` and `state` describe the followed run only. ' +
        'Returns immediately if the run already finished, if there is no run or if a request is pending. Reaching the deadline is not an error: it returns timedOut=true with the current state. ' +
        'To follow a long thread, call again later, between conversation turns; in voice use 1000-2000 ms. Never interrupts or changes the thread. Read-only.',
      shape: formas.t3_aguardar_thread,
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
