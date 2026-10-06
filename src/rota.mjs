// Rota entre environments (control-plane v1, docs/design/control-plane-v1.md §3): recomenda
// onde lançar trabalho novo a partir de fatos que o connector observa. Nunca despacha, nunca
// troca de host sozinho e nunca lê contas, quota ou papéis (isso é do fleet).
//
// Filtros duros, nesta ordem: environment permitido e respondendo, projeto vivo e autorizado,
// provider da instância pedida habilitado, instalado, `ready`, autenticado, com o modo de
// execução declarado e o modelo/opções exatos. Valor ausente ou desconhecido é
// `capability_unknown`, nunca sucesso (decisão 4 da §9). Plataforma exigida sem fonte é
// `insufficient_evidence`.
//
// Ordem dos elegíveis (lexicográfica, ascendente): afinidade de workspace, afinidade de branch,
// índice da preferência explícita, inFlight, needsIntervention, unknown, environmentId. Carga =
// grupos disjuntos do workset (running + background_pending), contados antes de truncar; sem
// carga o candidato não entra no ranking (`load_unknown`). Frente existente vence qualquer
// ranking: `continue_existing`.

import { CONTROL_PLANE_CONTRACT_VERSION } from './control-plane.mjs';
import { buscarFrentes, correrComSinal, falhaSanitizada, lerShellFresca } from './busca-threads.mjs';
import { montarWorkset } from './workset.mjs';
import { comparador } from './paginacao.mjs';
import { Cancelada } from './t3.mjs';

export const MAX_CANDIDATOS = 10;
export const PRAZO_ROTA_MS = 10000;

const fonte = 'server.getConfig';

/**
 * Elegibilidade de uma instância para (modelo, opções, modo). Pura. `reasons` diz cada filtro que
 * falhou; `eligible` só com todos os fatos positivos presentes.
 */
export function elegibilidadeProvider(provider, { model, options = [], runtimeMode }) {
  const reasons = [];
  const r = (code, field, extra = {}) => reasons.push({ code, source: fonte, ...(field ? { field } : {}), ...extra });
  if (!provider) { r('provider_unavailable', 'instanceId'); return { eligible: false, reasons }; }
  for (const campo of ['enabled', 'installed']) {
    if (provider[campo] === undefined) r('capability_unknown', campo);
    else if (provider[campo] !== true) r('provider_unavailable', campo);
  }
  if (provider.status === undefined) r('capability_unknown', 'status');
  else if (provider.status !== 'ready') r('provider_unavailable', 'status', { value: provider.status });
  if (provider.availability === 'unavailable') r('provider_unavailable', 'availability');
  const auth = provider.auth?.status;
  if (auth === undefined) r('capability_unknown', 'auth.status');
  else if (auth !== 'authenticated') r('provider_unavailable', 'auth.status', { value: auth });
  if (!Array.isArray(provider.supportedRuntimeModes)) r('capability_unknown', 'supportedRuntimeModes');
  else if (!provider.supportedRuntimeModes.includes(runtimeMode)) r('runtime_mode_unsupported', 'supportedRuntimeModes', { value: runtimeMode });
  if (!Array.isArray(provider.models)) r('capability_unknown', 'models');
  else {
    const m = provider.models.find((x) => x?.slug === model);
    if (!m) r('provider_model_unavailable', 'models', { value: model });
    else if (options.length) {
      const descritores = m.capabilities?.optionDescriptors;
      if (!Array.isArray(descritores)) r('capability_unknown', 'optionDescriptors');
      else for (const o of options) {
        const d = descritores.find((x) => x?.id === o.id);
        const valido = d && (d.type !== 'select' || (Array.isArray(d.options) && d.options.some((x) => x?.id === o.value)));
        if (!valido) r('model_option_unsupported', 'optionDescriptors', { option: o.id });
      }
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

/** Chave de ordem e ranking dos candidatos elegíveis com carga. Pura e independente da ordem de entrada. */
export function ordenarCandidatos(candidatos) {
  const comparar = comparador();
  const ranqueaveis = candidatos.filter((c) => c.eligible && c.load);
  for (const c of ranqueaveis) {
    c.orderKey = [c.affinity.workspacePenalty, c.affinity.branchPenalty, c.preferenceIndex, c.load.inFlight, c.load.needsIntervention, c.load.unknown, c.environmentId];
  }
  ranqueaveis.sort((a, b) => {
    for (let i = 0; i < 6; i++) if (a.orderKey[i] !== b.orderKey[i]) return a.orderKey[i] - b.orderKey[i];
    return comparar([a.environmentId], [b.environmentId]);
  });
  ranqueaveis.forEach((c, i) => { c.rank = i + 1; });
  for (const c of candidatos) if (!ranqueaveis.includes(c)) { c.rank = null; c.orderKey = null; }
  return ranqueaveis;
}

function validarRota(ambientes, route) {
  const erros = [];
  if (!route.candidates?.length || route.candidates.length > MAX_CANDIDATOS) erros.push(`pass 1-${MAX_CANDIDATOS} candidates`);
  const vistos = new Set();
  for (const c of route.candidates ?? []) {
    const r = ambientes.resolver(c.environment);
    if (vistos.has(r.environmentId)) erros.push(`at most one candidate per environment (${r.alias})`);
    vistos.add(r.environmentId);
  }
  if (route.front && !route.discoveryEnvironments?.length) erros.push('`discoveryEnvironments` is required with `front`');
  if (erros.length) throw Object.assign(new Error(`invalid_input: ${erros.join('; ')}`), { codigo: 'invalid_input' });
}

/** Lê projeto, shell e providers de um candidato, com o prazo do environment. */
async function lerCandidato(ambientes, r, c, { signal, lerProviders }) {
  return correrComSinal(ambientes.usar(r, async (cliente) => {
    const shell = await lerShellFresca(cliente, { signal });
    const projeto = (shell.projects ?? []).find((p) => p.id === c.projectId && !p.deletedAt);
    const autorizado = Boolean(projeto) && r.escopo.projetoPermitido(c.projectId);
    const providers = autorizado ? await lerProviders(cliente, { environmentIdEsperado: r.environmentId, signal }) : null;
    return { shell, projeto, autorizado, providers };
  }, { signal }), signal);
}

function afinidade(r, c, lido, bindings) {
  const meus = bindings.filter((b) => b.environmentId === r.environmentId && b.projectId === c.projectId);
  const reasons = [];
  const threads = (lido.shell.threads ?? []).filter((t) => t.projectId === c.projectId && !t.deletedAt && r.escopo.projetoPermitido(t.projectId));
  let workspacePenalty = 1;
  let branchPenalty = 1;
  for (const b of meus) {
    if (b.worktreePath !== undefined) {
      const visto = lido.projeto?.workspaceRoot === b.worktreePath || threads.some((t) => t.worktreePath === b.worktreePath);
      if (visto) { workspacePenalty = 0; reasons.push({ code: 'workspace_affinity_observed', source: 'shell' }); }
      else reasons.push({ code: 'affinity_unknown', field: 'worktreePath', source: 'shell' });
    }
    if (b.branch !== undefined) {
      if (threads.some((t) => t.branch === b.branch)) { branchPenalty = 0; reasons.push({ code: 'branch_affinity_observed', source: 'shell' }); }
      else reasons.push({ code: 'affinity_unknown', field: 'branch', source: 'shell' });
    }
  }
  return { workspacePenalty, branchPenalty, reasons };
}

/**
 * Recomendação de rota. `deps.lerProviders(cliente, {environmentIdEsperado, signal})`,
 * `deps.resumir(thread, projeto)`, `deps.lerArquivadas` (frente com population all).
 */
export async function rotear(ambientes, route, { signal, lerProviders, resumir, lerArquivadas = null, prazoMs = PRAZO_ROTA_MS, opcoesWorkset = {}, opcoesBusca = {} } = {}) {
  validarRota(ambientes, route);
  const total = AbortSignal.timeout(prazoMs);
  const sinal = signal ? AbortSignal.any([signal, total]) : total;
  const permitidos = route.constraints?.allowedEnvironments ? new Set(route.constraints.allowedEnvironments.map((e) => ambientes.resolver(e).environmentId)) : null;
  const preferidos = route.affinity?.preferredEnvironments?.map((e) => ambientes.resolver(e).environmentId) ?? null;
  const bindings = (route.affinity?.bindings ?? []).map((b) => ({ ...b, environmentId: ambientes.resolver(b.environment).environmentId }));
  let completo = true;

  const candidatos = await Promise.all(route.candidates.map(async (c) => {
    const r = ambientes.resolver(c.environment);
    const item = { environmentId: r.environmentId, alias: r.alias, projectId: c.projectId, eligible: false, rank: null, load: null, orderKey: null, reasons: [] };
    const preferenceIndex = !preferidos ? 0 : preferidos.includes(r.environmentId) ? preferidos.indexOf(r.environmentId) : preferidos.length;
    if (permitidos && !permitidos.has(r.environmentId)) { item.reasons.push({ code: 'environment_not_allowed', source: 'caller' }); return item; }
    let lido;
    try {
      lido = await lerCandidato(ambientes, r, c, { signal: sinal, lerProviders });
    } catch (e) {
      if (signal?.aborted || e instanceof Cancelada) throw new Cancelada();
      completo = false;
      item.reasons.push({ code: 'environment_unavailable', source: 'environment', ...falhaSanitizada(e) });
      return item;
    }
    if (!lido.autorizado) { item.reasons.push({ code: 'project_unavailable', source: 'shell' }); return item; }
    const provider = lido.providers.find((p) => p?.instanceId === c.modelSelection.instanceId);
    const el = elegibilidadeProvider(provider, { model: c.modelSelection.model, options: c.modelSelection.options ?? [], runtimeMode: c.runtimeMode });
    item.reasons.push(...el.reasons);
    if (route.constraints?.requiredPlatform) item.reasons.push({ code: 'insufficient_evidence', field: 'platform', source: 'connector' });
    item.eligible = el.eligible && !route.constraints?.requiredPlatform;
    if (item.eligible) item.reasons.push({ code: 'provider_model_available', source: fonte });
    const af = afinidade(r, c, lido, bindings);
    item.affinity = { workspacePenalty: af.workspacePenalty, branchPenalty: af.branchPenalty };
    item.reasons.push(...af.reasons);
    item.preferenceIndex = preferenceIndex;
    if (preferidos && preferenceIndex < preferidos.length) item.reasons.push({ code: 'explicit_host_preference', source: 'caller', index: preferenceIndex });
    return item;
  }));

  // Carga: um workset das environments elegíveis (grupos disjuntos, contagens antes de truncar).
  const elegiveis = candidatos.filter((c) => c.eligible);
  if (elegiveis.length) {
    const w = await montarWorkset(ambientes, { environments: elegiveis.map((c) => c.environmentId), limitPerGroup: 1 }, { ...opcoesWorkset, signal: sinal, resumir });
    for (const c of elegiveis) {
      const q = w.queriedEnvironments.find((x) => x.environmentId === c.environmentId);
      if (!q) { completo = false; c.reasons.push({ code: 'load_unknown', source: 'workset' }); continue; }
      const k = q.counts;
      c.load = { running: k.running, backgroundPending: k.background_pending, inFlight: k.running + k.background_pending, needsIntervention: k.needs_intervention, unknown: k.unknown, scope: 'authorized_active_threads', coverageComplete: true };
    }
  }
  const ranking = ordenarCandidatos(candidatos);

  // Frente: existente vence o ranking; ambígua ou sem cobertura não deixa recomendar.
  let frente = null;
  if (route.front) {
    const achado = await buscarFrentes(ambientes, {
      controlPlaneContractVersion: CONTROL_PLANE_CONTRACT_VERSION,
      environments: route.discoveryEnvironments,
      population: 'all',
      queries: [{ key: 'front', selector: route.front, limit: 5 }],
    }, { ...opcoesBusca, signal: sinal, resumir, lerArquivadas });
    frente = achado.results[0];
    if (!frente.complete) completo = false;
  }
  const alvos = frente ? frente.candidates.map((t) => ({ environmentId: t.environment.environmentId, threadId: t.threadId, projectId: t.project?.projectId ?? null, archived: t.archived })) : [];
  let decision;
  if (frente && frente.launchDisposition === 'continue_existing') decision = 'continue_existing';
  else if (frente && frente.launchDisposition === 'choose_target') decision = 'choose_target';
  else if (frente && frente.launchDisposition !== 'candidate_new') decision = 'inconclusive';
  else if (ranking.length) decision = 'recommend_environment';
  else if (candidatos.some((c) => c.reasons.some((x) => ['capability_unknown', 'environment_unavailable', 'load_unknown', 'insufficient_evidence'].includes(x.code)))) decision = 'inconclusive';
  else decision = 'no_eligible_environment';

  const ordem = (x) => [x.rank ?? Number.MAX_SAFE_INTEGER, x.environmentId];
  const comparar = comparador();
  candidatos.sort((a, b) => (ordem(a)[0] - ordem(b)[0]) || comparar([a.environmentId], [b.environmentId]));
  return {
    decision,
    recommendedEnvironmentId: decision === 'recommend_environment' ? ranking[0].environmentId : null,
    existingTargets: decision === 'continue_existing' || decision === 'choose_target' ? alvos : [],
    ...(frente ? { front: { resolution: frente.resolution, launchDisposition: frente.launchDisposition, coverage: frente.coverage, reasons: frente.reasons } } : {}),
    candidates: candidatos.map(({ alias, ...c }) => c),
    complete: completo,
    guarantee: 'recommendation_only',
  };
}
