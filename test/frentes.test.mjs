// Control-plane v1 no t3_thread_find_batch: seletor estrutural, população active|all,
// relações e launchDisposition (docs/design/control-plane-v1.md §4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao, LOCAL, PROJETO_ALHEIO, REMOTO } from './apoio.mjs';
import { thread } from './fixtures.mjs';
import { casarSeletor, prDaUrl, relacoesDe } from '../src/busca-threads.mjs';

const V = { controlPlaneContractVersion: 1 };
// Sem leitor de arquivadas por padrão nos testes: `all` declara a lacuna.
async function lote(args, { d = dadosPadrao(), lerArquivadas = null } = {}) {
  const c = await conectarMcp(ambientesFalsos(d), { lerArquivadas });
  const r = await c.callTool({ name: 't3_thread_find_batch', arguments: args });
  return r.isError ? r : dados(r);
}
const pares = (r) => r.candidates.map((t) => `${t.environment.alias}:${t.threadId}`);
const comSequencia = (d, seq = 9) => { d.local.shell.snapshotSequence = seq; d.remoto.shell.snapshotSequence = seq; return d; };
const arquivadas = (porAmbiente, seq = 9) => async (_c, r) => ({ snapshotSequence: seq, threads: porAmbiente[r.alias] ?? [] });

test('seletor por branch: mesmo branch em dois environments é ambíguo, nunca escolhido', async () => {
  const d = dadosPadrao();
  d.local.shell.threads.push(thread({ id: 'dona-local', projectId: LOCAL.projeto, title: 'Frente X', branch: 'feat/x' }));
  d.remoto.shell.threads.push(thread({ id: 'dona-remota', projectId: REMOTO.projeto, title: 'Frente X', branch: 'feat/x' }));
  const r = await lote({ ...V, queries: [{ key: 'x', selector: { branch: 'feat/x' }, limit: 1 }] }, { d });
  const q = r.results[0];
  assert.equal(q.resolution, 'ambiguous');
  assert.equal(q.launchDisposition, 'choose_target');
  assert.equal(q.total, 2);
  assert.equal(q.returned, 1);
  assert.ok(q.reasons.some((x) => x.code === 'front_ambiguous'));
});

test('population all: arquivada da mesma sequence entra (ACL aplicada); frente única → continue_existing', async () => {
  const d = comSequencia(dadosPadrao());
  const r = await lote({ ...V, population: 'all', queries: [{ key: 'f', selector: { title: { value: 'Frente arquivada' } } }] }, {
    d,
    lerArquivadas: arquivadas({
      local: [
        thread({ id: 'arq-1', projectId: LOCAL.projeto, title: 'Frente arquivada', archivedAt: '2026-10-01T00:00:00.000Z' }),
        thread({ id: 'arq-alheia', projectId: PROJETO_ALHEIO, title: 'Frente arquivada', archivedAt: '2026-10-01T00:00:00.000Z' }),
      ],
    }),
  });
  const q = r.results[0];
  assert.deepEqual(pares(q), ['local:arq-1']);
  assert.equal(q.candidates[0].archived, true);
  assert.equal(q.resolution, 'resolved');
  assert.equal(q.launchDisposition, 'continue_existing');
  assert.deepEqual(q.coverage, { environmentsComplete: true, population: 'all', populationComplete: true, selectorEvidenceComplete: true, scope: 'authorized_projects' });
});

test('ausência só prova com all completo: candidate_new; active → inconclusive; sem fonte de arquivadas → inconclusive', async () => {
  const sel = { key: 'nova', selector: { title: { value: 'Nada assim' } } };
  const tudo = await lote({ ...V, population: 'all', queries: [sel] }, { d: comSequencia(dadosPadrao()), lerArquivadas: arquivadas({}) });
  assert.equal(tudo.results[0].resolution, 'not_found');
  assert.equal(tudo.results[0].launchDisposition, 'candidate_new');
  const ativa = await lote({ ...V, queries: [sel] });
  assert.equal(ativa.results[0].resolution, 'not_found');
  assert.equal(ativa.results[0].launchDisposition, 'inconclusive');
  assert.ok(ativa.results[0].reasons.some((x) => x.code === 'population_active_only'));
  const semFonte = await lote({ ...V, population: 'all', queries: [sel] }, { d: comSequencia(dadosPadrao()) });
  assert.equal(semFonte.results[0].resolution, 'inconclusive');
  assert.ok(semFonte.results[0].reasons.some((x) => x.code === 'archived_source_unavailable'));
});

test('arquivadas de outra sequence (repetida até o limite) ou inválidas nunca completam a população', async () => {
  let leituras = 0;
  const outra = async () => (leituras++, { snapshotSequence: 10, threads: [] });
  const r = await lote({ ...V, population: 'all', queries: [{ key: 'n', selector: { title: { value: 'Nada' } } }] }, { d: comSequencia(dadosPadrao()), lerArquivadas: outra });
  assert.equal(r.results[0].resolution, 'inconclusive');
  assert.ok(r.results[0].reasons.some((x) => x.code === 'archived_sequence_mismatch'));
  assert.equal(leituras, 6, 'três tentativas por environment');
  const invalida = await lote({ ...V, population: 'all', queries: [{ key: 'n', selector: { title: { value: 'Nada' } } }] }, { d: comSequencia(dadosPadrao()), lerArquivadas: async () => ({ snapshotSequence: 9, threads: [{ id: 'sem-projeto' }] }) });
  assert.ok(invalida.results[0].reasons.some((x) => x.code === 'archived_source_invalid'));
});

test('linha ativa sem projectId (ou malformada) torna a população incompleta, nunca candidate_new (revisão 334a1840 P2)', async () => {
  const sel = { key: 'nova', selector: { title: { value: 'Nada assim' } } };
  for (const ruim of [{ ...thread({ id: 'sem-projeto' }), projectId: undefined }, { id: 'sem-status', projectId: LOCAL.projeto }, null]) {
    const d = comSequencia(dadosPadrao());
    d.remoto.shell.threads.push(ruim);
    const r = await lote({ ...V, population: 'all', queries: [sel] }, { d, lerArquivadas: arquivadas({}) });
    const q = r.results[0];
    assert.equal(q.resolution, 'inconclusive', JSON.stringify(ruim));
    assert.equal(q.launchDisposition, 'inconclusive');
    assert.equal(q.coverage.populationComplete, false);
    assert.ok(q.reasons.some((x) => x.code === 'active_source_invalid' && x.environmentId === REMOTO.environmentId));
  }
  // A busca legada também não afirma cobertura completa sobre dado malformado (revisão
  // aacaf76, P2); com dado bem formado a resposta legada não muda (testes de busca-lote).
  const d = dadosPadrao();
  d.remoto.shell.threads.push({ ...thread({ id: 'sem-projeto' }), projectId: undefined });
  const legado = await lote({ queries: [{ key: 'c', threadId: 't-comum' }] }, { d });
  assert.equal(legado.results[0].resolution, 'ambiguous');
  assert.equal(legado.results[0].complete, false);
  assert.equal('coverage' in legado.results[0], false);
});

test('título ausente ou nulo (ativa ou arquivada) não prova ausência; ativa e arquivada divergentes também não (revisão a8d1170 P2)', async () => {
  const sel = { key: 'x', selector: { title: { value: 'Front X' } } };
  for (const semTitulo of [{ ...thread({ id: 'hidden', projectId: LOCAL.projeto }), title: undefined }, thread({ id: 'hidden', projectId: LOCAL.projeto, title: null })]) {
    const ativa = comSequencia(dadosPadrao());
    ativa.local.shell.threads.push(semTitulo);
    const r1 = (await lote({ ...V, population: 'all', queries: [sel] }, { d: ativa, lerArquivadas: arquivadas({}) })).results[0];
    assert.equal(r1.launchDisposition, 'inconclusive');
    assert.equal(r1.coverage.selectorEvidenceComplete, false);
    const r2 = (await lote({ ...V, population: 'all', queries: [sel] }, { d: comSequencia(dadosPadrao()), lerArquivadas: arquivadas({ local: [{ ...semTitulo, archivedAt: '2026-10-01T00:00:00.000Z' }] }) })).results[0];
    assert.equal(r2.launchDisposition, 'inconclusive');
  }
  // Mesma thread ativa ("Other") e arquivada ("Front X"): conflito, nunca candidate_new.
  const d = comSequencia(dadosPadrao());
  d.local.shell.threads.push(thread({ id: 'dupla', projectId: LOCAL.projeto, title: 'Other' }));
  const conflito = (await lote({ ...V, population: 'all', queries: [sel] }, { d, lerArquivadas: arquivadas({ local: [thread({ id: 'dupla', projectId: LOCAL.projeto, title: 'Front X', archivedAt: '2026-10-01T00:00:00.000Z' })] }) })).results[0];
  assert.equal(conflito.launchDisposition, 'inconclusive');
  assert.ok(conflito.reasons.some((x) => x.code === 'population_conflict'));
  // Mesma thread nas duas fontes, concordando: conta uma vez, sem conflito.
  const d2 = comSequencia(dadosPadrao());
  d2.local.shell.threads.push(thread({ id: 'igual', projectId: LOCAL.projeto, title: 'Front X' }));
  const igual = (await lote({ ...V, population: 'all', queries: [sel] }, { d: d2, lerArquivadas: arquivadas({ local: [thread({ id: 'igual', projectId: LOCAL.projeto, title: 'Front X', archivedAt: '2026-10-01T00:00:00.000Z' })] }) })).results[0];
  assert.equal(igual.launchDisposition, 'continue_existing');
  assert.equal(igual.total, 1);
});

test('evidência malformada não prova ausência: PR sem URL, branch não textual, search v1 sem título, lineage divergente (revisão 737d9be P2)', async () => {
  const todos = (d, queries, extra = {}) => lote({ ...V, population: 'all', queries }, { d, lerArquivadas: arquivadas(extra) });
  // PR que não dá para atribuir (URL inválida, sem número).
  const pr = { pullRequest: { host: 'github.com', repository: 'owner/repo', number: 12 } };
  for (const link of [{ url: 'bad' }, { number: 12 }, {}, 'texto']) {
    const d = comSequencia(dadosPadrao());
    d.local.shell.threads.push(thread({ id: 'pr', projectId: LOCAL.projeto, linkedPullRequest: link }));
    const q = (await todos(d, [{ key: 'p', selector: pr }])).results[0];
    assert.equal(q.launchDisposition, 'inconclusive', JSON.stringify(link));
    assert.equal(q.coverage.selectorEvidenceComplete, false);
  }
  // E lógico: branch desconhecida continua desconhecida mesmo com o PR casando.
  assert.equal(casarSeletor(thread({ linkedPullRequest: { url: 'https://github.com/owner/repo/pull/12' }, branch: 7 }), { ...pr, branch: 'feat/x' }, 'e'), 'unknown');
  assert.equal(casarSeletor(thread({ branch: 7 }), { branch: 'feat/x' }, 'e'), 'unknown');
  // search/threadId v1 seguem a mesma regra de evidência.
  for (const match of ['exact', 'partial']) {
    const d = comSequencia(dadosPadrao());
    d.local.shell.threads.push(thread({ id: 'sem-titulo', projectId: LOCAL.projeto, title: null }));
    const q = (await todos(d, [{ key: 's', search: 'Front X', match }])).results[0];
    assert.equal(q.launchDisposition, 'inconclusive', match);
    assert.equal(q.coverage.selectorEvidenceComplete, false);
  }
  // Mesma filha ativa (sem pai) e arquivada (pai = root): conflito, árvore não completa.
  const d = comSequencia(dadosPadrao());
  for (const amb of ['local', 'remoto']) d[amb].shell.threads = d[amb].shell.threads.map((t) => ({ ...t, lineage: {} }));
  d.local.shell.threads.push(thread({ id: 'root', projectId: LOCAL.projeto, title: 'Raiz', lineage: {} }), thread({ id: 'child', projectId: LOCAL.projeto, title: 'Filha', lineage: {} }));
  const r = (await todos(d, [{ key: 'r', selector: { threadId: 'root' }, relations: { direction: 'children' } }], { local: [thread({ id: 'child', projectId: LOCAL.projeto, title: 'Filha', lineage: { parentThreadId: 'root' }, archivedAt: '2026-10-01T00:00:00.000Z' })] })).results[0];
  assert.equal(r.coverage.populationComplete, false);
  assert.ok(r.reasons.some((x) => x.code === 'population_conflict'));
  assert.equal(r.relations.complete, false);
});

test('campo do seletor ausente na shell não prova nada: selector_evidence_unavailable', async () => {
  const d = comSequencia(dadosPadrao());
  for (const amb of ['local', 'remoto']) d[amb].shell.threads = d[amb].shell.threads.map(({ branch, ...t }) => t);
  const r = await lote({ ...V, population: 'all', queries: [{ key: 'b', selector: { branch: 'feat/y' } }] }, { d, lerArquivadas: arquivadas({}) });
  assert.equal(r.results[0].resolution, 'inconclusive');
  assert.equal(r.results[0].coverage.selectorEvidenceComplete, false);
  assert.equal(r.results[0].launchDisposition, 'inconclusive');
});

test('PR: casa host+repositório+número; mesmo número em outro repositório não casa; sem URL é desconhecido', () => {
  assert.deepEqual(prDaUrl('https://github.com/Marcus/T3-Connector/pull/12'), { host: 'github.com', repository: 'marcus/t3-connector', number: 12 });
  assert.deepEqual(prDaUrl('https://gitlab.com/g/sub/proj/-/merge_requests/7'), { host: 'gitlab.com', repository: 'g/sub/proj', number: 7 });
  assert.equal(prDaUrl('não é url'), null);
  const sel = { pullRequest: { host: 'github.com', repository: 'marcus/t3-connector', number: 12 } };
  assert.equal(casarSeletor(thread({ linkedPullRequest: { number: 12, url: 'https://github.com/marcus/t3-connector/pull/12' } }), sel, 'e'), 'match');
  assert.equal(casarSeletor(thread({ linkedPullRequest: { number: 12, url: 'https://github.com/outro/repo/pull/12' } }), sel, 'e'), 'no');
  assert.equal(casarSeletor(thread({ linkedPullRequest: { number: 12 } }), sel, 'e'), 'unknown');
  assert.equal(casarSeletor(thread(), sel, 'e'), 'unknown');
  assert.equal(casarSeletor(thread({ linkedPullRequest: null, pullRequests: [] }), sel, 'e'), 'no');
});

test('seletor E lógico com projectIds qualificados; projectIds sozinho é recusado antes de ler', async () => {
  const d = dadosPadrao();
  d.local.shell.threads.push(thread({ id: 'a', projectId: LOCAL.projeto, title: 'Igual' }));
  d.remoto.shell.threads.push(thread({ id: 'a', projectId: REMOTO.projeto, title: 'Igual' }));
  const r = await lote({ ...V, queries: [{ key: 'q', selector: { title: { value: 'igual' }, projectIds: [{ environment: 'remoto', projectId: REMOTO.projeto }] } }] }, { d });
  assert.deepEqual(pares(r.results[0]), ['remoto:a']);
  const so = await lote({ ...V, queries: [{ key: 'q', selector: { projectIds: [{ environment: 'local', projectId: LOCAL.projeto }] } }] });
  assert.equal(so.isError, true);
  assert.match(so.content[0].text, /at least one of/);
});

test('relações: BFS por lineage, profundidade, teto, ciclo e lineage ausente', () => {
  const l = (id, pai, extra = {}) => thread({ id, lineage: pai ? { parentThreadId: pai, relationshipToParent: 'subagent' } : {}, ...extra });
  const linhas = [l('raiz'), l('f1', 'raiz'), l('f2', 'raiz'), l('n1', 'f1'), l('bisneto', 'n1')];
  const filhos = relacoesDe('raiz', linhas, 'env-a', { direction: 'children' });
  assert.deepEqual(filhos.nodes.map((n) => `${n.depth}:${n.threadId}`), ['1:f1', '1:f2']);
  assert.equal(filhos.complete, true);
  assert.equal(filhos.deeperExists, true);
  const desc = relacoesDe('raiz', linhas, 'env-a', { direction: 'descendants', maxDepth: 3 });
  assert.deepEqual(desc.nodes.map((n) => `${n.depth}:${n.threadId}`), ['1:f1', '1:f2', '2:n1', '3:bisneto']);
  const teto = relacoesDe('raiz', linhas, 'env-a', { direction: 'descendants', limit: 2 });
  assert.equal(teto.truncated, true);
  assert.equal(teto.complete, false);
  const ciclo = relacoesDe('a', [l('a', 'b'), l('b', 'a')], 'env-a', { direction: 'descendants', maxDepth: 4 });
  assert.deepEqual(ciclo.unresolved, [{ environmentId: 'env-a', threadId: 'a', code: 'lineage_cycle' }]);
  assert.equal(ciclo.complete, false);
  const sem = relacoesDe('raiz', [thread({ id: 'raiz' })], 'env-a');
  assert.equal(sem.complete, false);
  assert.equal(sem.reason, 'lineage_unavailable');
  // Lineage malformado também não prova "sem filhos".
  for (const lineage of [null, 'raiz', [], { parentThreadId: 7 }]) {
    const r = relacoesDe('raiz', [l('raiz'), thread({ id: 'x', lineage })], 'env-a');
    assert.equal(r.complete, false, JSON.stringify(lineage));
  }
});

test('relações pela tool: árvore por candidato, no environment do candidato', async () => {
  const d = dadosPadrao();
  for (const amb of ['local', 'remoto']) d[amb].shell.threads = d[amb].shell.threads.map((t) => ({ ...t, lineage: {} }));
  d.local.shell.threads.push(thread({ id: 'dona', projectId: LOCAL.projeto, title: 'Dona', lineage: {} }), thread({ id: 'filha', projectId: LOCAL.projeto, title: 'Filha', lineage: { parentThreadId: 'dona', relationshipToParent: 'subagent' } }));
  d.remoto.shell.threads.push(thread({ id: 'filha', projectId: REMOTO.projeto, title: 'Outra', lineage: { parentThreadId: 'dona' } }));
  const r = await lote({ ...V, queries: [{ key: 'd', selector: { title: { value: 'Dona' } }, relations: { direction: 'children' } }] }, { d });
  const tree = r.results[0].relations.trees[0];
  assert.deepEqual(tree.root, { environmentId: LOCAL.environmentId, threadId: 'dona' });
  assert.deepEqual(tree.nodes.map((n) => `${n.environmentId}:${n.threadId}`), [`${LOCAL.environmentId}:filha`]);
});

test('compatibilidade: sem controlPlaneContractVersion a resposta é a legada e seletor é recusado', async () => {
  const legado = await lote({ queries: [{ key: 'c', threadId: 't-comum' }] });
  assert.equal('coverage' in legado.results[0], false);
  assert.equal('launchDisposition' in legado.results[0], false);
  const sel = await lote({ queries: [{ key: 's', selector: { branch: 'x' } }] });
  assert.equal(sel.isError, true);
  const pop = await lote({ population: 'all', queries: [{ key: 'c', threadId: 't-comum' }] });
  assert.equal(pop.isError, true);
  const v1 = await lote({ ...V, queries: [{ key: 'c', threadId: 't-comum' }] });
  assert.equal(v1.controlPlaneContractVersion, 1);
  assert.equal(v1.results[0].resolution, 'ambiguous');
});
