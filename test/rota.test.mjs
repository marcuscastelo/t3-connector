// Rota control-plane v1 em t3_ambientes: filtros duros, ordem lexicográfica explícita,
// carga do workset, frente existente vence, nunca despacha.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao, LOCAL, REMOTO } from './apoio.mjs';
import { thread } from './fixtures.mjs';
import { elegibilidadeProvider, ordenarCandidatos } from '../src/rota.mjs';

const modelo = { slug: 'gpt-6.1-sol', capabilities: { optionDescriptors: [{ id: 'reasoningEffort', type: 'select', options: [{ id: 'high' }, { id: 'low' }] }] } };
const provider = (extra = {}) => ({ instanceId: 'codex', enabled: true, installed: true, status: 'ready', auth: { status: 'authenticated' }, supportedRuntimeModes: ['full-access'], models: [modelo], ...extra });
const pedido = { model: 'gpt-6.1-sol', options: [{ id: 'reasoningEffort', value: 'high' }], runtimeMode: 'full-access' };
const sel = { instanceId: 'codex', model: 'gpt-6.1-sol', options: [{ id: 'reasoningEffort', value: 'high' }] };
const candidatos = () => [
  { environment: 'local', projectId: LOCAL.projeto, modelSelection: sel, runtimeMode: 'full-access' },
  { environment: 'remoto', projectId: REMOTO.projeto, modelSelection: sel, runtimeMode: 'full-access' },
];

async function rota(route, { d = dadosPadrao(), providers = { [LOCAL.environmentId]: [provider()], [REMOTO.environmentId]: [provider()] }, lerArquivadas = null } = {}) {
  const porBase = { 'http://127.0.0.1:3773/': LOCAL.environmentId, 'http://127.0.0.1:43773/': REMOTO.environmentId };
  const chamarImpl = async ({ baseUrl }) => { const env = porBase[String(baseUrl)]; return { environment: { environmentId: env }, providers: structuredClone(providers[env]) }; };
  const c = await conectarMcp(ambientesFalsos(d), { lerArquivadas }, { chamarImpl });
  const r = await c.callTool({ name: 't3_ambientes', arguments: { check: false, controlPlaneContractVersion: 1, route } });
  return r.isError ? r : dados(r);
}

test('elegibilidade: só ready+authenticated+modo+modelo+opções explícitos; ausência é capability_unknown', () => {
  assert.equal(elegibilidadeProvider(provider(), pedido).eligible, true);
  const casos = [
    [provider({ status: 'warning' }), 'provider_unavailable'],
    [provider({ enabled: false }), 'provider_unavailable'],
    [provider({ auth: { status: 'unauthenticated' } }), 'provider_unavailable'],
    [provider({ auth: undefined }), 'capability_unknown'],
    [provider({ supportedRuntimeModes: 'full-access' }), 'capability_unknown'],
    [provider({ supportedRuntimeModes: ['approval-required'] }), 'runtime_mode_unsupported'],
    [provider({ models: [{ slug: 'outro' }] }), 'provider_model_unavailable'],
    [provider({ availability: 'unavailable' }), 'provider_unavailable'],
    [provider({ models: [{ slug: 'gpt-6.1-sol' }] }), 'capability_unknown'],
    [undefined, 'provider_unavailable'],
  ];
  for (const [p, code] of casos) {
    const e = elegibilidadeProvider(p, pedido);
    assert.equal(e.eligible, false, code);
    assert.ok(e.reasons.some((x) => x.code === code), `${code}: ${JSON.stringify(e.reasons)}`);
  }
  assert.ok(elegibilidadeProvider(provider(), { ...pedido, options: [{ id: 'reasoningEffort', value: 'ultra' }] }).reasons.some((x) => x.code === 'model_option_unsupported'));
});

test('elegibilidade: supportedRuntimeModes ausente ou vazio é a regra do T3 para "todos os modos" (codex e claudeAgent ao vivo)', () => {
  // RuntimePolicy.ts:79-87 (8ed276c2): undefined ou [] roda o modo pedido; lista sem ele cai em approval-required.
  for (const modos of [undefined, []]) {
    const e = elegibilidadeProvider(provider({ supportedRuntimeModes: modos }), pedido);
    assert.equal(e.eligible, true, JSON.stringify(modos));
  }
  assert.ok(elegibilidadeProvider(provider({ supportedRuntimeModes: ['approval-required'] }), pedido).reasons.some((x) => x.code === 'runtime_mode_unsupported'));
  // Os outros fatos continuam obrigatórios: auth ausente segue desconhecido.
  assert.equal(elegibilidadeProvider(provider({ supportedRuntimeModes: undefined, auth: undefined }), pedido).eligible, false);
});

test('ordem: afinidade, branch, preferência, carga, intervenção, unknown, ID; mesma entrada embaralhada dá o mesmo ranking', () => {
  const c = (environmentId, ws, br, pref, inFlight, ni = 0, un = 0) => ({ environmentId, eligible: true, affinity: { workspacePenalty: ws, branchPenalty: br }, preferenceIndex: pref, load: { inFlight, needsIntervention: ni, unknown: un } });
  const base = () => [c('env-b', 1, 1, 0, 0), c('env-a', 1, 1, 0, 0), c('env-c', 0, 1, 1, 9), c('env-d', 1, 0, 0, 5), c('env-e', 1, 1, 0, 0, 1)];
  const ids = (l) => ordenarCandidatos(l).map((x) => x.environmentId);
  assert.deepEqual(ids(base()), ['env-c', 'env-d', 'env-a', 'env-b', 'env-e']);
  assert.deepEqual(ids(base().reverse()), ['env-c', 'env-d', 'env-a', 'env-b', 'env-e']);
  const semCarga = [{ ...c('env-z', 0, 0, 0, 0), load: null }, c('env-y', 1, 1, 0, 3)];
  assert.deepEqual(ids(semCarga), ['env-y']);
  assert.equal(semCarga[0].rank, null);
});

test('rota: recomenda o menos ocupado entre elegíveis, com carga do workset e reasons', async () => {
  const d = dadosPadrao();
  // Local: 0 running e 1 needs_intervention (t-local); remoto: 2 running, 0 intervenção.
  // inFlight vem antes de needsIntervention na ordem: local vence.
  d.remoto.shell.threads.push(thread({ id: 'roda-2', projectId: REMOTO.projeto, status: 'running', activeRunId: 'r2', activityRunStatus: 'running' }));
  const r = await rota({ candidates: candidatos() }, { d });
  assert.equal(r.route.decision, 'recommend_environment');
  assert.equal(r.route.recommendedEnvironmentId, LOCAL.environmentId);
  assert.equal(r.route.guarantee, 'recommendation_only');
  const [primeiro, segundo] = r.route.candidates;
  assert.equal(primeiro.environmentId, LOCAL.environmentId);
  assert.equal(primeiro.rank, 1);
  assert.equal(primeiro.load.needsIntervention, 1);
  assert.equal(segundo.load.running, 2);
  assert.equal(segundo.load.inFlight, 2);
  assert.ok(primeiro.reasons.some((x) => x.code === 'provider_model_available'));
});

test('rota: preferência explícita vence carga; afinidade observada vence preferência', async () => {
  // Sem preferência o local (menos ocupado) venceria; a preferência pelo remoto vem antes da carga.
  const pref = await rota({ candidates: candidatos(), affinity: { preferredEnvironments: ['remoto'] } });
  assert.equal(pref.route.recommendedEnvironmentId, REMOTO.environmentId);
  const d = dadosPadrao();
  d.remoto.shell.threads.push(thread({ id: 'w', projectId: REMOTO.projeto, worktreePath: '/home/dev/app-wt', branch: 'feat/x' }));
  const af = await rota({ candidates: candidatos(), affinity: { preferredEnvironments: ['local'], bindings: [{ environment: 'remoto', projectId: REMOTO.projeto, worktreePath: '/home/dev/app-wt' }] } }, { d });
  assert.equal(af.route.recommendedEnvironmentId, REMOTO.environmentId);
  assert.ok(af.route.candidates[0].reasons.some((x) => x.code === 'workspace_affinity_observed'));
});

test('rota: provider ausente/desconhecido e plataforma exigida falham fechado; nenhum elegível → no_eligible ou inconclusive', async () => {
  const sem = await rota({ candidates: candidatos() }, { providers: { [LOCAL.environmentId]: [provider({ status: 'disabled' })], [REMOTO.environmentId]: [provider({ instanceId: 'outro' })] } });
  assert.equal(sem.route.decision, 'no_eligible_environment');
  assert.equal(sem.route.recommendedEnvironmentId, null);
  const desconhecido = await rota({ candidates: candidatos() }, { providers: { [LOCAL.environmentId]: [provider({ auth: undefined })], [REMOTO.environmentId]: [provider({ installed: undefined })] } });
  assert.equal(desconhecido.route.decision, 'inconclusive');
  const plataforma = await rota({ candidates: candidatos(), constraints: { requiredPlatform: 'linux' } });
  assert.equal(plataforma.route.decision, 'inconclusive');
  assert.ok(plataforma.route.candidates.every((c) => c.reasons.some((x) => x.code === 'insufficient_evidence')));
  const fora = await rota({ candidates: candidatos(), constraints: { allowedEnvironments: ['local'] } });
  assert.equal(fora.route.recommendedEnvironmentId, LOCAL.environmentId);
  assert.ok(fora.route.candidates.find((c) => c.environmentId === REMOTO.environmentId).reasons.some((x) => x.code === 'environment_not_allowed'));
  const projeto = await rota({ candidates: [{ ...candidatos()[0], projectId: 'proj-alheio' }] });
  assert.ok(projeto.route.candidates[0].reasons.some((x) => x.code === 'project_unavailable'));
});

test('rota: frente existente vence o ranking; frente sem cobertura é inconclusive; frente ausente com all completo deixa recomendar', async () => {
  const d = dadosPadrao();
  d.local.shell.snapshotSequence = 3; d.remoto.shell.snapshotSequence = 3;
  d.local.shell.threads.push(thread({ id: 'dona', projectId: LOCAL.projeto, title: 'Frente CP' }));
  const arquivadas = async () => ({ snapshotSequence: 3, threads: [] });
  const existe = await rota({ candidates: candidatos(), front: { title: { value: 'Frente CP' } }, discoveryEnvironments: ['local', 'remoto'] }, { d, lerArquivadas: arquivadas });
  assert.equal(existe.route.decision, 'continue_existing');
  assert.equal(existe.route.recommendedEnvironmentId, null);
  assert.deepEqual(existe.route.existingTargets.map((t) => t.threadId), ['dona']);
  const semArquivo = await rota({ candidates: candidatos(), front: { title: { value: 'Outra frente' } }, discoveryEnvironments: ['local', 'remoto'] }, { d });
  assert.equal(semArquivo.route.decision, 'inconclusive');
  const nova = await rota({ candidates: candidatos(), front: { title: { value: 'Outra frente' } }, discoveryEnvironments: ['local', 'remoto'] }, { d, lerArquivadas: arquivadas });
  assert.equal(nova.route.decision, 'recommend_environment');
  assert.equal(nova.route.front.launchDisposition, 'candidate_new');
});

test('rota: entrada inválida recusa antes de ler; sem versão a resposta é a legada', async () => {
  const dois = await rota({ candidates: [candidatos()[0], candidatos()[0]] });
  assert.equal(dois.isError, true);
  assert.match(dois.content[0].text, /one candidate per environment/);
  const semDescoberta = await rota({ candidates: candidatos(), front: { title: { value: 'x' } } });
  assert.equal(semDescoberta.isError, true);
  const c = await conectarMcp(ambientesFalsos());
  const legado = dados(await c.callTool({ name: 't3_ambientes', arguments: { check: false } }));
  assert.equal('route' in legado, false);
  const semVersao = await c.callTool({ name: 't3_ambientes', arguments: { check: false, route: { candidates: candidatos() } } });
  assert.equal(semVersao.isError, true);
});
