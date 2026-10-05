// t3_workset: reconstruir o quadro do orquestrador depois de perder o contexto, numa
// chamada, em todos os environments; completed não é settled; environment que falha não
// esconde o que os outros devolveram.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao, LOCAL, PROJETO_ALHEIO, REMOTO } from './apoio.mjs';
import { thread } from './fixtures.mjs';

const AGORA = Date.parse('2026-10-05T12:00:00.000Z');
const opcoes = { agora: AGORA };

function dadosBfs() {
  const d = dadosPadrao();
  d.local.shell.snapshotSequence = 900;
  d.local.shell.threads = [
    thread({ id: 'pedindo', projectId: LOCAL.projeto, status: 'waiting', activityRunStatus: 'waiting', pendingRuntimeRequest: { id: 'req-9', kind: 'user_input', createdAt: '2026-10-05T11:00:00.000Z' }, updatedAt: '2026-10-05T11:00:00.000Z' }),
    // Steer: o run mais novo foi cancelado, o anterior continua ativo.
    thread({ id: 'steer', projectId: LOCAL.projeto, status: 'cancelled', latestRunId: 'run-4', activeRunId: 'run-1', activityRunStatus: 'running', updatedAt: '2026-10-05T11:30:00.000Z' }),
    thread({ id: 'feita', projectId: LOCAL.projeto, status: 'completed', pinnedAt: null, lineage: { parentThreadId: 'pai', relationshipToParent: 'subagent', rootThreadId: 'pai' }, updatedAt: '2026-10-05T09:00:00.000Z' }),
    thread({ id: 'esquecida', projectId: LOCAL.projeto, status: 'completed', linkedPullRequest: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'open' }, updatedAt: '2026-10-01T09:00:00.000Z' }),
    thread({ id: 'liquidada', projectId: LOCAL.projeto, status: 'completed', settledAt: '2026-10-05T10:00:00.000Z' }),
    thread({ id: 'falhou', projectId: LOCAL.projeto, status: 'failed', lastError: 'boom' }),
    thread({ id: 'adiada', projectId: LOCAL.projeto, status: 'completed', snoozedUntil: '2026-10-06T12:00:00.000Z' }),
    thread({ id: 'adiamento-vencido', projectId: LOCAL.projeto, status: 'completed', snoozedUntil: '2026-10-04T12:00:00.000Z' }),
    thread({ id: 'parada', projectId: LOCAL.projeto, status: 'interrupted' }),
    thread({ id: 'sem-run', projectId: LOCAL.projeto, status: 'idle', latestRunId: null }),
    thread({ id: 'arquivada', projectId: LOCAL.projeto, status: 'completed', archivedAt: '2026-10-02T00:00:00.000Z' }),
    thread({ id: 'alheia', projectId: PROJETO_ALHEIO, status: 'waiting', pendingRuntimeRequest: { id: 'req-x', kind: 'command', createdAt: '2026-10-05T11:00:00.000Z' } }),
  ];
  d.remoto.shell.snapshotSequence = 40;
  d.remoto.shell.threads = [
    thread({ id: 'feita', projectId: REMOTO.projeto, title: 'Mesmo ID no Remoto', status: 'running', latestRunId: 'run-s1', activeRunId: 'run-s1' }),
  ];
  return d;
}

const ids = (grupo) => grupo.map((t) => `${t.environment}:${t.threadId}`);

test('t3_workset: reconstrói o BFS dos dois environments numa chamada, em grupos disjuntos', async () => {
  const chamadas = [];
  const c = await conectarMcp(ambientesFalsos(dadosBfs(), { chamadas }), undefined, undefined, opcoes);
  const w = dados(await c.callTool({ name: 't3_workset', arguments: {} }));
  assert.equal(w.complete, true);
  assert.equal(w.observedAt, '2026-10-05T12:00:00.000Z');
  assert.deepEqual(w.environmentFailures, []);
  assert.deepEqual(w.queriedEnvironments.map((e) => [e.alias, e.snapshotSequence]), [['local', 900], ['remoto', 40]]);
  assert.deepEqual(ids(w.groups.needs_intervention), ['local:pedindo']);
  assert.deepEqual(ids(w.groups.running), ['local:steer', 'remoto:feita']);
  assert.deepEqual(ids(w.groups.snoozed), ['local:adiada']);
  assert.deepEqual(ids(w.groups.failed_unsettled), ['local:falhou']);
  // completed != settled: só as não liquidadas, inclusive com adiamento vencido.
  assert.deepEqual(ids(w.groups.completed_unsettled).sort(), ['local:adiamento-vencido', 'local:esquecida', 'local:feita']);
  assert.deepEqual(ids(w.groups.cancelled_unsettled), ['local:parada']);
  assert.deepEqual(w.groups.unknown, []);
  assert.equal(w.counts.settledIdle, 1);
  assert.equal(w.counts.noRun, 1);
  // Projeto não autorizado e arquivadas não aparecem em lugar nenhum.
  const todos = Object.values(w.groups).flat().map((t) => t.threadId);
  assert.ok(!todos.includes('alheia') && !todos.includes('arquivada') && !todos.includes('liquidada'));
  // Uma leitura de shell por environment, nenhuma leitura de thread.
  assert.deepEqual(chamadas.filter((x) => !/ambiente|sessao/.test(x)).sort(), ['local:shell', 'remoto:shell']);
});

test('t3_workset: itens compactos com referências e fatos de decisão, sem texto', async () => {
  const c = await conectarMcp(ambientesFalsos(dadosBfs()), undefined, undefined, opcoes);
  const w = dados(await c.callTool({ name: 't3_workset', arguments: {} }));
  const pedindo = w.groups.needs_intervention[0];
  assert.deepEqual(pedindo.pendingRequest, { requestId: 'req-9', kind: 'user_input', since: '2026-10-05T11:00:00.000Z' });
  assert.equal(pedindo.stateSource, 'pending_request');
  const steer = w.groups.running.find((t) => t.threadId === 'steer');
  assert.equal(steer.runId, 'run-1');
  assert.equal(steer.stateSource, 'active_run');
  assert.equal(steer.latestRunId, 'run-4');
  const feita = w.groups.completed_unsettled.find((t) => t.threadId === 'feita');
  assert.equal(feita.settled, false);
  assert.equal(feita.pinned, false);
  assert.equal(feita.parentThreadId, 'pai');
  assert.equal(feita.relationshipToParent, 'subagent');
  const esquecida = w.groups.completed_unsettled.find((t) => t.threadId === 'esquecida');
  assert.deepEqual(esquecida.linkedPullRequest, { number: 7, url: 'https://github.com/o/r/pull/7', state: 'open' });
  // Campo que o servidor não informa é desconhecido, não false.
  assert.equal(esquecida.pinned, null);
  assert.equal(w.groups.snoozed[0].snoozedUntil, '2026-10-06T12:00:00.000Z');
  assert.ok(Object.values(w.groups).flat().every((t) => !('text' in t) && !('latestResponse' in t)));
  // O mesmo threadId em dois environments continua separado pelo alias.
  assert.equal(w.groups.running.find((t) => t.environment === 'remoto').title, 'Mesmo ID no Remoto');
});

test('t3_workset: environment que falha não esconde os itens dos que responderam', async () => {
  const d = dadosBfs();
  d.remoto.shell = () => { throw Object.assign(new Error('caiu'), { status: 503 }); };
  const c = await conectarMcp(ambientesFalsos(d), undefined, undefined, opcoes);
  const w = dados(await c.callTool({ name: 't3_workset', arguments: {} }));
  assert.equal(w.complete, false);
  assert.deepEqual(w.environmentFailures.map((f) => [f.alias, f.code]), [['remoto', 'failed']]);
  assert.deepEqual(w.queriedEnvironments.map((e) => e.alias), ['local']);
  assert.deepEqual(ids(w.groups.running), ['local:steer']);
  assert.equal(w.counts.needs_intervention, 1);
});

test('t3_workset: limitPerGroup corta a lista mas não a contagem; environments escolhidos e desconhecidos', async () => {
  const c = await conectarMcp(ambientesFalsos(dadosBfs()), undefined, undefined, opcoes);
  const w = dados(await c.callTool({ name: 't3_workset', arguments: { environments: ['local', 'env-local'], limitPerGroup: 1 } }));
  assert.deepEqual(w.queriedEnvironments.map((e) => e.alias), ['local']);
  assert.equal(w.groups.completed_unsettled.length, 1);
  assert.equal(w.counts.completed_unsettled, 3);
  assert.equal(w.truncated.completed_unsettled, 2);
  // Mais recente primeiro.
  assert.equal(w.groups.completed_unsettled[0].threadId, 'feita');
  const r = await c.callTool({ name: 't3_workset', arguments: { environments: ['nenhum'] } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not configured/);
});
