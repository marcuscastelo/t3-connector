// Despacho protegido (control-plane v1, docs/design/control-plane-v1.md §5): preflight de
// thread.launch e thread.send e o mesmo cálculo refeito pelo Dispatcher logo antes do envio
// (`dispatchGuard` v1). Uma função, duas fontes: leitura (t3_dispatch_preflight) e escrita
// (Dispatcher), com o mesmo material, digest e códigos.
//
// Nada aqui decide trabalho em curso por conta própria: send usa a observação v2 do settlement
// (execution.continuation.blockers); launch usa a elegibilidade da rota e a busca de frente com
// population all. Preflight não reserva operationId, não grava nada e não concede escrita
// (`writeAuthorization: "not_checked"`); a verificação de caminho no host fica com o apply.
//
// Recorte v1 (decisão 3 da §9): workspace `root` e `existing_worktree` já preparados; criação de
// worktree é `workspace_creation_preflight_unsupported`; branch exigida sem leitor de refs é
// `workspace_evidence_unavailable`. steer/restart sem predicado observável de suporte são
// `delivery_capability_unknown`.

import { createHash } from 'node:crypto';
import { CONTROL_PLANE_CONTRACT_VERSION } from './control-plane.mjs';
import { parseAction } from './escrita/adapters.mjs';
import { elegibilidadeProvider } from './rota.mjs';
import { buscarFrentes, falhaSanitizada, lerShellFresca } from './busca-threads.mjs';
import { lerObservacaoComDados } from './settlement.mjs';
import { Cancelada } from './t3.mjs';

export const DISPATCH_GUARD_VERSIONS = Object.freeze([1]);
const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

// Blocker canônico de execution → recusa do despacho. Código novo não libera nada.
const RECUSA_BLOQUEIO = {
  active_run: 'dispatch_active_run',
  queued_runs: 'dispatch_queued_work',
  pending_request: 'dispatch_pending_request',
  proposed_plan: 'dispatch_unresolved_work',
  usage_limit: 'dispatch_unresolved_work',
  usage_limit_auto_resume: 'dispatch_unresolved_work',
  background_work_active: 'dispatch_unresolved_work',
  background_work_unknown: 'dispatch_unresolved_work',
};

/** Item mínimo da busca de duplicata: IDs só, igual nos dois lados (leitura e escrita). */
const resumirIds = (t) => ({ threadId: t.id, title: t.title, project: { projectId: t.projectId } });

function rootsDoProjeto(p) {
  return [p.workspaceRoot ?? p.cwd ?? p.directory, ...(Array.isArray(p.workspaceRoots) ? p.workspaceRoots : [])].filter(Boolean);
}

export function digestEntrada(action, input) {
  return `sha256:${sha([action, input])}`;
}

function resultado({ action, r, inputDigest, reasons, material, extra = {}, complete = true }) {
  const admissible = reasons.length === 0 && complete;
  return {
    controlPlaneContractVersion: CONTROL_PLANE_CONTRACT_VERSION,
    status: 'ok',
    complete,
    admissible,
    action,
    target: { environmentId: r.environmentId, ...(extra.target ?? {}) },
    inputDigest,
    observationId: admissible ? `dispatch1_${sha(material).slice(0, 32)}` : null,
    writeAuthorization: 'not_checked',
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'target')),
    reasons,
    guarantee: 'connector_preflight_and_observation',
  };
}

async function duplicatas(fontes, duplicateCheck) {
  const res = await buscarFrentes(fontes.ambientes, {
    controlPlaneContractVersion: CONTROL_PLANE_CONTRACT_VERSION,
    environments: duplicateCheck.environments,
    population: 'all',
    queries: [{ key: 'duplicate', selector: duplicateCheck.selector, limit: 5 }],
  }, { signal: fontes.signal, resumir: resumirIds, lerArquivadas: fontes.lerArquivadas });
  const q = res.results[0];
  const domain = res.queriedEnvironments.map((x) => x.environmentId).sort();
  return {
    resolution: q.resolution,
    populationComplete: q.coverage.populationComplete,
    environmentsComplete: q.coverage.environmentsComplete,
    domain,
    candidates: q.candidates.map((c) => ({ environmentId: c.environment.environmentId, threadId: c.threadId, archived: c.archived })),
    reasons: q.reasons,
  };
}

async function preflightLaunch({ r, input, parsed, expected, duplicateCheck }, fontes, reasons) {
  const ws = parsed.workspaceStrategy;
  if (ws.type === 'worktree') reasons.push({ code: 'workspace_creation_preflight_unsupported', source: 'connector' });
  if (input.runtimeMode === undefined) reasons.push({ code: 'dispatch_guard_required_fields_missing', field: 'runtimeMode', source: 'caller' });
  if (!duplicateCheck) reasons.push({ code: 'dispatch_guard_required_fields_missing', field: 'duplicateCheck', source: 'caller' });
  if (expected.projectId !== parsed.projectId) reasons.push({ code: 'dispatch_project_changed', source: 'caller' });

  let lido;
  try {
    lido = await fontes.ambientes.usar(r, async (cliente) => {
      const shell = await lerShellFresca(cliente, { signal: fontes.signal });
      const projeto = (shell.projects ?? []).find((p) => p.id === parsed.projectId && !p.deletedAt);
      const permitido = Boolean(projeto) && r.escopo.projetoPermitido(parsed.projectId);
      const providers = permitido ? await fontes.lerProviders(cliente, r, { signal: fontes.signal }) : null;
      return { projeto: permitido ? projeto : null, providers };
    }, { signal: fontes.signal });
  } catch (e) {
    if (e instanceof Cancelada) throw e;
    return { complete: false, extra: { environmentFailure: falhaSanitizada(e) }, material: null, reasons: [...reasons, { code: 'environment_unavailable', source: 'environment' }] };
  }
  let caminho = null;
  if (!lido.projeto) reasons.push({ code: 'project_unavailable', source: 'shell' });
  else {
    const roots = rootsDoProjeto(lido.projeto);
    caminho = ws.type === 'root' ? roots[0] ?? null : ws.type === 'existing_worktree' ? ws.worktreePath : null;
    if (ws.type === 'existing_worktree' && !roots.includes(caminho)) reasons.push({ code: 'workspace_scope_denied', source: 'shell' });
  }
  const branch = ws.branch ?? null;
  if (expected.workspace.type !== ws.type || (expected.workspace.path ?? null) !== caminho || (expected.workspace.branch ?? null) !== branch) {
    reasons.push({ code: 'dispatch_workspace_changed', source: 'caller' });
  }
  if (branch !== null) reasons.push({ code: 'workspace_evidence_unavailable', field: 'branch', source: 'connector' });

  const ms = parsed.modelSelection;
  let provider = { eligible: false };
  if (lido.providers) {
    const el = elegibilidadeProvider(lido.providers.find((p) => p?.instanceId === ms.instanceId), { model: ms.model, options: ms.options ?? [], runtimeMode: parsed.runtimeMode });
    provider = { eligible: el.eligible };
    reasons.push(...el.reasons);
  }
  let dup = null;
  let complete = true;
  if (duplicateCheck) {
    dup = await duplicatas(fontes, duplicateCheck);
    if (dup.resolution === 'resolved') reasons.push({ code: 'front_exists', source: 'shell', candidates: dup.candidates });
    else if (dup.resolution === 'ambiguous') reasons.push({ code: 'front_ambiguous', source: 'shell', candidates: dup.candidates });
    else if (dup.resolution !== 'not_found') { reasons.push({ code: 'front_discovery_incomplete', source: 'find', detail: dup.reasons.map((x) => x.code) }); complete = false; }
  }
  const workspace = { type: ws.type, path: caminho, pathVerification: 'on_apply', branch, branchKnowledge: branch === null ? 'not_required' : 'unavailable' };
  const material = ['dispatch1', 'thread.launch', r.environmentId, parsed.projectId, [workspace.type, workspace.path, workspace.branch],
    [ms.instanceId, ms.model, ms.options ?? [], parsed.runtimeMode, provider.eligible], dup ? [dup.resolution, dup.domain, dup.candidates.map((c) => [c.environmentId, c.threadId])] : null];
  return { complete, material, reasons, extra: { target: { projectId: parsed.projectId }, workspace, duplicateCheck: dup && { resolution: dup.resolution, populationComplete: dup.populationComplete, domain: dup.domain, candidates: dup.candidates }, execution: null } };
}

async function preflightSend({ r, parsed, expected }, fontes, reasons) {
  if (parsed.delivery === 'start_immediately' && parsed.onBackgroundWork === 'send') reasons.push({ code: 'dispatch_override_unsupported', field: 'onBackgroundWork', source: 'caller' });
  let lido;
  try {
    lido = await fontes.ambientes.usar(r, async (cliente) => {
      const shell = await lerShellFresca(cliente, { signal: fontes.signal });
      const obs = await lerObservacaoComDados({
        environmentId: r.environmentId,
        threadId: parsed.threadId,
        lerShell: async () => {
          const atual = await lerShellFresca(cliente, { signal: fontes.signal });
          return { ...atual, threads: (atual.threads ?? []).filter((t) => r.escopo.projetoPermitido(t.projectId)) };
        },
        lerCompleto: (id) => cliente.threadCompleto(id, { signal: fontes.signal }),
        version: 2,
      });
      return { shell, obs };
    }, { signal: fontes.signal });
  } catch (e) {
    if (e instanceof Cancelada) throw e;
    return { complete: false, extra: { environmentFailure: falhaSanitizada(e) }, material: null, reasons: [...reasons, { code: 'environment_unavailable', source: 'environment' }] };
  }
  const { obs, shell } = lido;
  if (!obs.thread) {
    return { complete: false, material: null, extra: { target: { threadId: parsed.threadId }, execution: null }, reasons: [...reasons, { code: 'dispatch_observation_incomplete', source: 'settlement', detail: obs.observacao.blockers.map((b) => b.reason ?? b.code) }] };
  }
  const thread = obs.thread;
  const execution = obs.execucao;
  const projeto = (shell.projects ?? []).find((p) => p.id === thread.projectId && !p.deletedAt);
  const binding = thread.worktreePath
    ? { type: 'existing_worktree', path: thread.worktreePath }
    : { type: 'root', path: projeto ? rootsDoProjeto(projeto)[0] ?? null : null };
  if (expected.projectId !== thread.projectId) reasons.push({ code: 'dispatch_project_changed', source: 'snapshot' });
  if (expected.workspace.type !== binding.type || (expected.workspace.path ?? null) !== binding.path) reasons.push({ code: 'dispatch_workspace_changed', source: 'snapshot' });
  if ((expected.workspace.branch ?? null) !== null) reasons.push({ code: 'workspace_evidence_unavailable', field: 'branch', source: 'connector' });

  const blockers = execution.continuation.blockers;
  const ativo = execution.runs.active?.runId ?? null;
  let expectedRunId = null;
  const recusar = (lista) => {
    for (const b of lista) reasons.push({ code: RECUSA_BLOQUEIO[b] ?? 'execution_blocker_unsupported', blocker: b, source: 'execution' });
  };
  if (parsed.delivery === 'start_immediately') recusar(blockers);
  else if (parsed.delivery === 'queue_after_active') {
    if (!ativo) reasons.push({ code: 'dispatch_no_active_run', source: 'execution' });
    expectedRunId = ativo;
    recusar(blockers.filter((b) => b !== 'active_run'));
  } else {
    // steer_active / restart_active: o alvo tem de ser o run ativo, mas nenhuma fonte observável
    // prova que o provider aceita steer/restart agora.
    expectedRunId = ativo;
    if (parsed.targetRunId !== ativo) reasons.push({ code: 'dispatch_run_changed', source: 'execution' });
    reasons.push({ code: 'delivery_capability_unknown', field: parsed.delivery, source: 'connector' });
    recusar(blockers.filter((b) => b !== 'active_run'));
  }
  const material = ['dispatch1', 'thread.send', r.environmentId, parsed.threadId, obs.observacao.observationId, [binding.type, binding.path], parsed.delivery, expectedRunId];
  return {
    complete: true,
    material,
    reasons,
    extra: {
      target: { threadId: parsed.threadId, projectId: thread.projectId },
      workspace: { ...binding, pathVerification: 'snapshot_metadata', branch: null, branchKnowledge: 'not_required' },
      expectedRunId,
      settlementObservationId: obs.observacao.observationId,
      execution: { contractVersion: execution.contractVersion, runs: execution.runs, continuation: execution.continuation, coherence: execution.coherence },
    },
  };
}

/**
 * Preflight de launch/send. `fontes`: { ambientes (registros/resolver/usar/identidade, com
 * r.escopo), lerProviders(cliente, r, {signal}), lerArquivadas(cliente, r, {signal}), signal }.
 * Entrada inválida é erro (EntradaInvalida do chamador); recusa normal é admissible:false.
 */
export async function preflightDespacho({ action, environment, input, expected, duplicateCheck }, fontes) {
  if (input?.dispatchGuard !== undefined) throw Object.assign(new Error('invalid_input: the preflight input must not carry dispatchGuard'), { codigo: 'invalid_input' });
  if (action === 'thread.send' && duplicateCheck !== undefined) throw Object.assign(new Error('invalid_input: duplicateCheck is only for thread.launch'), { codigo: 'invalid_input' });
  let parsed;
  try {
    parsed = parseAction(action, input).input;
  } catch (e) {
    throw Object.assign(new Error(`invalid_input: ${e?.issues?.[0]?.message ?? e.message}`), { codigo: 'invalid_input' });
  }
  const r = fontes.ambientes.resolver(environment);
  const inputDigest = digestEntrada(action, parsed);
  const reasons = [];
  const parte = action === 'thread.launch'
    ? await preflightLaunch({ r, input, parsed, expected, duplicateCheck }, fontes, reasons)
    : await preflightSend({ r, parsed, expected }, fontes, reasons);
  return resultado({ action, r, inputDigest, reasons: parte.reasons, material: parte.material, extra: parte.extra, complete: parte.complete });
}

/** Código de recusa no apply: sempre `dispatch_*` (sobrevive ao relay, sem texto interno). */
export const codigoRecusaApply = (code) => (code.startsWith('dispatch_') ? code : `dispatch_${code}`);

/**
 * Fachada de `ambientes` sobre as conexões de escrita, para o Dispatcher refazer o preflight com
 * o mesmo código: ACL = projetos do grant deste environment (ou todos os vivos, no OAuth all,
 * cujo consentimento não lista projetos). Environment fora do grant falha (cobertura incompleta).
 */
export function ambientesDeConexoes(conexoes, scope) {
  const registros = conexoes.map((c) => {
    const grant = scope?.environments?.find((e) => e.environmentId === c.registro.environmentId);
    const ids = grant?.projects ? new Set(grant.projects.map((p) => p.id)) : null;
    return { ...c.registro, conexao: c, grant, escopo: { projetoPermitido: (id) => (ids ? ids.has(id) : true) } };
  });
  const resolver = (chave) => {
    const r = registros.find((x) => x.alias === chave || x.environmentId === chave);
    if (!r) throw new Error('ambiente_desconhecido');
    return r;
  };
  return {
    registros,
    resolver,
    identidade: (r) => ({ alias: r.alias, environmentId: r.environmentId }),
    async usar(r, fn) {
      if (!r.grant) throw new Error('ambiente_fora_da_lease');
      const leitura = await r.conexao.cliente();
      const cliente = { ...leitura, rpc: (tag, payload) => r.conexao.adapter.native.rpc(tag, payload) };
      return fn(cliente, {});
    },
  };
}

/** Providers e arquivadas pelo RPC da conexão de escrita (mesmas fontes da leitura). */
export const fontesEscrita = (conexoes, scope) => ({
  ambientes: ambientesDeConexoes(conexoes, scope),
  lerProviders: async (cliente, r) => {
    const config = await cliente.rpc('server.getConfig', {});
    if (config?.environment?.environmentId !== r.environmentId || !Array.isArray(config.providers)) throw new Error('environment_mismatch');
    return config.providers;
  },
  lerArquivadas: (cliente) => cliente.rpc('orchestration.getArchivedShellSnapshot', {}),
});
