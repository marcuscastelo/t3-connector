import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotPlanoControle } from '../src/plano-controle.mjs';
import { resumoDaThread } from '../src/servidor.mjs';
import { Cancelada, ErroT3 } from '../src/t3.mjs';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao, LOCAL, REMOTO } from './apoio.mjs';
import { thread } from './fixtures.mjs';

const nunca = () => new Promise(() => {});
const recusa = (status) => () => Promise.reject(new ErroT3(`T3 respondeu ${status} em /api/orchestration/shell`, { status }));
const futuro = () => new Date(Date.now() + 3600_000).toISOString();
const passado = (min) => new Date(Date.now() - min * 60_000).toISOString();

async function snapshot(args = {}, { d = dadosPadrao(), chamadas, opcoes } = {}) {
  const c = await conectarMcp(ambientesFalsos(d, { chamadas }), opcoes);
  return c.callTool({ name: 't3_control_plane', arguments: args });
}

const pares = (lista) => lista.threads.map((t) => `${t.environment.alias}:${t.threadId}`);

test('sem environment cobre todos os environments, com o environment em cada item', async () => {
  const chamadas = [];
  const r = dados(await snapshot({}, { chamadas }));
  assert.equal(r.contractVersion, 1);
  assert.equal(r.scope, 'all_environments');
  assert.equal(r.complete, true);
  assert.equal('incompleteReason' in r, false);
  assert.deepEqual(r.environmentFailures, []);
  assert.equal(r.coherence.mode, 'per_environment');
  assert.deepEqual(r.queriedEnvironments.map((a) => [a.alias, a.visibleThreads]), [['local', 2], ['remoto', 2]]);
  assert.deepEqual(r.queriedEnvironments[0].byState, { running: 0, needs_intervention: 1, completed: 1, failed: 0, cancelled: 0, no_run: 0, unknown: 0 });

  assert.deepEqual(pares(r.needsIntervention), ['local:t-local']);
  assert.deepEqual(pares(r.running), ['remoto:t-comum']);
  // O mesmo threadId nos dois environments aparece duas vezes, cada um com o seu estado.
  assert.deepEqual(pares(r.ready).sort(), ['local:t-comum', 'remoto:t-llm']);
  // Projeto fora da ACL não aparece nem nas contagens.
  assert.equal([r.needsIntervention, r.running, r.ready].some((l) => l.threads.some((t) => t.threadId === 't-alheia')), false);

  const [pedido] = r.needsIntervention.threads;
  assert.deepEqual(pedido.environment, { alias: 'local', environmentId: LOCAL.environmentId, name: 'local' });
  assert.deepEqual(pedido.project, { projectId: LOCAL.projeto, title: 'app' });
  assert.equal(pedido.state, 'needs_intervention');
  assert.equal(pedido.stateSource, 'pending_request');
  assert.deepEqual(pedido.pendingRequest, { requestId: 'req-1', kind: 'command', reason: 'command approval', since: '2026-10-03T10:04:00.000Z', contentInThreadRead: true });
  assert.deepEqual(pedido.next, { tool: 't3_thread', input: { environment: 'local', threadId: 't-local' } });

  const remota = r.ready.threads.find((t) => t.threadId === 't-llm');
  assert.deepEqual(remota.readyReasons, ['latest_run_cancelled_unsettled']);
  assert.deepEqual(remota.blockers, []);
  assert.equal(remota.actionableNow, true);
  assert.equal(remota.environment.environmentId, REMOTO.environmentId);
  // Uma leitura da shell por environment, nenhum /bounded por thread.
  assert.equal(chamadas.filter((c) => c.endsWith(':shell')).length, 2);
  assert.equal(chamadas.some((c) => c.includes(':thread:')), false);
});

test('environment que falha aparece explícito e a resposta não se diz global', async () => {
  const d = dadosPadrao();
  d.remoto.shell = recusa(500);
  const r = await snapshot({}, { d });
  assert.equal(r.isError, undefined);
  const x = dados(r);
  assert.equal(x.complete, false);
  assert.match(x.incompleteReason, /not a global view/);
  assert.deepEqual(x.environmentFailures.map((f) => [f.alias, f.environmentId, f.code]), [['remoto', REMOTO.environmentId, 'http_500']]);
  assert.deepEqual(x.queriedEnvironments.map((a) => a.alias), ['local']);
  assert.deepEqual(pares(x.needsIntervention), ['local:t-local']);
  assert.equal(x.running.total, 0);
  assert.deepEqual(pares(x.ready), ['local:t-comum']);
});

test('environment que não responde no prazo vira timeout sem segurar os outros', async () => {
  const d = dadosPadrao();
  d.local.shell = nunca;
  const x = dados(await snapshot({}, { d, opcoes: { prazoAmbienteMs: 50, prazoTotalMs: 2000 } }));
  assert.equal(x.complete, false);
  assert.deepEqual(x.environmentFailures.map((f) => [f.alias, f.code]), [['local', 'timeout']]);
  assert.deepEqual(pares(x.running), ['remoto:t-comum']);
  assert.equal(x.needsIntervention.total, 0);
});

test('todos falham: envelope vazio com complete false, distinto de "nada a fazer"', async () => {
  const d = dadosPadrao();
  d.local.shell = recusa(403);
  d.remoto.shell = recusa(401);
  const x = dados(await snapshot({}, { d }));
  assert.equal(x.complete, false);
  assert.deepEqual(x.queriedEnvironments, []);
  assert.deepEqual(x.environmentFailures.map((f) => f.code), ['http_403', 'http_401']);
  assert.equal(x.needsIntervention.total + x.running.total + x.ready.total, 0);
  // Nenhum detalhe interno vaza na falha.
  assert.equal(JSON.stringify(x.environmentFailures).includes('/api/orchestration'), false);
});

test('environment filtra o escopo; desconhecido é recusado', async () => {
  const x = dados(await snapshot({ environment: REMOTO.environmentId }));
  assert.equal(x.scope, 'environment');
  assert.equal(x.complete, true);
  assert.deepEqual(x.queriedEnvironments.map((a) => a.alias), ['remoto']);
  assert.deepEqual(pares(x.running), ['remoto:t-comum']);
  assert.equal(x.needsIntervention.total, 0);
  const r = await snapshot({ environment: 'outro' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not configured/);
  const antigo = await snapshot({ ambiente: 'local' });
  assert.equal(antigo.isError, true);
});

test('classificação usa o state canônico e só marca ready o que a shell sustenta', async () => {
  const d = dadosPadrao();
  const p = LOCAL.projeto;
  d.local.shell.threads = [
    // Fila promovida a steer: o último run está cancelled, mas o ativo continua.
    thread({ id: 'steer', projectId: p, status: 'cancelled', latestRunId: 'run-2', activeRunId: 'run-1', activityRunStatus: 'running', updatedAt: passado(1) }),
    thread({ id: 'limite', projectId: p, status: 'failed', limitRecovery: { runId: 'run-1', autoResume: false, resetAt: futuro() }, updatedAt: passado(2) }),
    thread({ id: 'plano', projectId: p, status: 'completed', hasActionableProposedPlan: true, updatedAt: passado(3) }),
    thread({ id: 'assentada', projectId: p, status: 'completed', settledAt: passado(10), updatedAt: passado(4) }),
    thread({ id: 'adiada', projectId: p, status: 'completed', snoozedUntil: futuro(), snoozedAt: passado(30), updatedAt: passado(40) }),
    thread({ id: 'acordou', projectId: p, status: 'completed', snoozedUntil: passado(5), snoozedAt: passado(60), lastVisitedAt: passado(90), updatedAt: passado(70) }),
    thread({ id: 'fundo', projectId: p, status: 'completed', pendingBackgroundTasks: [{ kind: 'monitor', taskId: 'bg-1', description: 'observer' }], updatedAt: passado(6) }),
    thread({ id: 'falhou', projectId: p, status: 'failed', lastError: 'boom', updatedAt: passado(7) }),
    thread({ id: 'sem-run', projectId: p, status: 'idle', latestRunId: null, updatedAt: passado(8) }),
    thread({ id: 'arquivada', projectId: p, status: 'failed', archivedAt: passado(1), updatedAt: passado(1) }),
  ];
  const x = dados(await snapshot({ environment: 'local' }, { d }));
  assert.deepEqual(pares(x.running), ['local:steer']);
  const steer = x.running.threads[0];
  assert.deepEqual(steer.activeRun, { runId: 'run-1', status: 'running' });
  assert.equal(steer.latestRunStatus, 'cancelled');
  assert.deepEqual(x.needsIntervention.threads.map((t) => [t.threadId, t.kind, t.pendingRequest]), [['limite', 'usage_limit', null], ['plano', 'proposed_plan', null]]);
  assert.deepEqual(x.ready.threads.map((t) => [t.threadId, t.readyReasons, t.actionableNow]), [
    ['fundo', ['latest_run_completed_unsettled'], false],
    ['falhou', ['latest_run_failed_unsettled'], true],
    ['acordou', ['latest_run_completed_unsettled', 'woke'], true],
  ]);
  assert.deepEqual(x.ready.threads[0].blockers, ['background_work_pending']);
  assert.deepEqual(x.ready.threads[0].backgroundTasks, [{ kind: 'monitor', taskId: 'bg-1', description: 'observer' }]);
  // Contagens cobrem toda thread visível, inclusive as que não entram em nenhuma lista.
  assert.equal(x.queriedEnvironments[0].visibleThreads, 9);
  assert.equal(x.queriedEnvironments[0].byState.no_run, 1);
  assert.equal(x.queriedEnvironments[0].byState.completed, 4);
});

test('limit corta cada lista com total e truncated, em ordem de updatedAt entre environments', async () => {
  const d = dadosPadrao();
  const rodando = (id, projectId, min) => thread({ id, projectId, status: 'running', activeRunId: 'run-1', updatedAt: passado(min) });
  d.local.shell.threads = [rodando('l1', LOCAL.projeto, 1), rodando('l2', LOCAL.projeto, 3)];
  d.remoto.shell.threads = [rodando('r1', REMOTO.projeto, 2), rodando('r2', REMOTO.projeto, 4)];
  d.remoto.shell.snapshotSequence = 42;
  const x = dados(await snapshot({ limit: 3 }, { d }));
  assert.equal(x.limit, 3);
  assert.deepEqual({ total: x.running.total, returned: x.running.returned, truncated: x.running.truncated }, { total: 4, returned: 3, truncated: true });
  assert.deepEqual(pares(x.running), ['local:l1', 'remoto:r1', 'local:l2']);
  assert.deepEqual(x.queriedEnvironments.map((a) => a.snapshotSequence), [null, 42]);
  assert.equal(x.ready.truncated, false);
  assert.equal((await snapshot({ limit: 101 })).isError, true);
});

test('cancelamento do cliente encerra o snapshot em vez de virar falha parcial', async () => {
  const d = dadosPadrao();
  d.remoto.shell = nunca;
  const controle = new AbortController();
  const p = snapshotPlanoControle(ambientesFalsos(d), {}, { signal: controle.signal, resumir: resumoDaThread });
  setTimeout(() => controle.abort(), 20);
  await assert.rejects(p, Cancelada);
});
