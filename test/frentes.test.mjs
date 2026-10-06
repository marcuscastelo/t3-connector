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
