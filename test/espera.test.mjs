import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aguardarThread } from '../src/espera.mjs';
import { ForaDoEscopo } from '../src/ambientes.mjs';
import { Cancelada } from '../src/t3.mjs';
import { ambientesFalsos, dadosPadrao, REMOTO } from './apoio.mjs';
import { mensagem, pedido, thread } from './fixtures.mjs';

const RUN = { id: 'run-s1', ordinal: 1, status: 'running' };
const snapshot = (campos = {}) => ({
  kind: 'snapshot',
  snapshotSequence: 10,
  projection: { runs: [RUN], runtimeRequests: [], messages: [mensagem({ id: 'm-s1', runId: 'run-s1', text: 'Trabalhando.' })], ...campos },
});
const evento = (type, payload, sequence = 11) => ({ kind: 'event', sequence, event: { type, payload } });

/** Subscription falsa: emite lotes nos tempos pedidos e registra o pedido e o encerramento. */
function assinaturaFalsa(lotes, registro = {}) {
  return async ({ tag, payload, aoReceber }) => {
    registro.tag = tag;
    registro.payload = payload;
    registro.encerrada = false;
    let falhar;
    const fim = new Promise((_, reject) => { falhar = reject; });
    fim.catch(() => {});
    const timers = lotes.map(([ms, itens]) => setTimeout(() => {
      if (itens === 'cair') return falhar(Object.assign(new Error('T3 WS closed during the wait'), { codigo: 'indisponivel' }));
      try { aoReceber(itens); } catch (e) { falhar(e); }
    }, ms));
    return { fim, encerrar() { registro.encerrada = true; timers.forEach(clearTimeout); } };
  };
}

const esperar = (entrada, opcoes = {}, { dados, chamadas } = {}) =>
  aguardarThread(ambientesFalsos(dados, { chamadas }), entrada, opcoes);

test('conclusão normal no Remoto: retorna no evento terminal, sem esperar o prazo', async () => {
  const reg = {};
  const r = await esperar(
    { environment: 'remoto', threadId: 't-comum', timeoutMs: 5000 },
    { assinarImpl: assinaturaFalsa([[5, [snapshot(), { kind: 'synchronized' }]], [40, [evento('run.updated', { ...RUN, status: 'completed' })]]], reg) },
  );
  assert.deepEqual(r.environment, { alias: 'remoto', environmentId: REMOTO.environmentId });
  assert.equal(r.projectId, REMOTO.projeto);
  assert.equal(r.runId, 'run-s1');
  assert.equal(r.statusRun, 'completed');
  assert.equal(r.state, 'completed');
  assert.equal(r.terminal, true);
  assert.equal(r.timedOut, false);
  assert.equal(r.returnReason, 'terminal');
  assert.ok(r.elapsedMs < 1000);
  assert.equal(reg.tag, 'orchestration.subscribeThread');
  assert.deepEqual(reg.payload, { threadId: 't-comum', requestCompletionMarker: true, acceptBoundedSnapshot: true });
  assert.equal(reg.encerrada, true, 'encerra a própria subscription');
});

test('timeout: devolve o estado observado com timedOut, sem erro', async () => {
  const reg = {};
  const r = await esperar(
    { environment: 'remoto', threadId: 't-comum', timeoutMs: 150 },
    { assinarImpl: assinaturaFalsa([[5, [snapshot(), { kind: 'synchronized' }]]], reg) },
  );
  assert.equal(r.timedOut, true);
  assert.equal(r.terminal, false);
  assert.equal(r.state, 'running');
  assert.equal(r.statusRun, 'running');
  assert.equal(r.returnReason, 'timeout');
  assert.ok(r.elapsedMs >= 140 && r.elapsedMs < 1000, `elapsed ${r.elapsedMs}`);
  assert.ok(r.observedAt);
  assert.equal(reg.encerrada, true);
});

test('timeoutMs acima do teto é limitado a 5 s', async () => {
  const r = await esperar(
    { environment: 'remoto', threadId: 't-comum', timeoutMs: 600000 },
    { assinarImpl: assinaturaFalsa([[5, [snapshot({ runs: [{ ...RUN, status: 'completed' }] })]]]) },
  );
  assert.equal(r.timeoutMs, 5000);
});

for (const [status, estado] of [['failed', 'failed'], ['cancelled', 'cancelled'], ['interrupted', 'cancelled'], ['rolled_back', 'cancelled']]) {
  test(`run que termina em ${status} durante a espera vira ${estado}`, async () => {
    const r = await esperar(
      { environment: 'remoto', threadId: 't-comum', timeoutMs: 2000 },
      { assinarImpl: assinaturaFalsa([[5, [snapshot()]], [30, [evento('run.updated', { ...RUN, status })]]]) },
    );
    assert.equal(r.state, estado);
    assert.equal(r.terminal, true);
    assert.equal(r.timedOut, false);
  });
}

test('pedido de aprovação durante a espera retorna como intervenção', async () => {
  const r = await esperar(
    { environment: 'remoto', threadId: 't-comum', timeoutMs: 2000 },
    { assinarImpl: assinaturaFalsa([[5, [snapshot()]], [30, [evento('run.updated', { ...RUN, status: 'waiting' }), evento('runtime-request.updated', pedido({ id: 'req-7', kind: 'user_input' }), 12)]]]) },
  );
  assert.equal(r.state, 'needs_intervention');
  assert.equal(r.returnReason, 'needs_intervention');
  assert.equal(r.terminal, false);
  assert.deepEqual({ id: r.pendingRequest.runtimeRequestId, reason: r.pendingRequest.reason }, { id: 'req-7', reason: 'question waiting for an answer' });
});

test('run já terminal ou pedido pendente na shell retornam na hora, sem abrir WS', async () => {
  const chamadas = [];
  const nunca = async () => { throw new Error('não deveria abrir WS'); };
  const llm = await esperar({ environment: 'remoto', threadId: 't-llm', timeoutMs: 2000 }, { assinarImpl: nunca }, { chamadas });
  assert.deepEqual([llm.state, llm.terminal, llm.timedOut, llm.runId], ['cancelled', true, false, 'run-s3']);
  const pol = await esperar({ environment: 'local', threadId: 't-local', timeoutMs: 2000 }, { assinarImpl: nunca }, { chamadas });
  assert.equal(pol.state, 'needs_intervention');
  assert.equal(pol.pendingRequest.runtimeRequestId, 'req-1');
  assert.ok(!chamadas.some((c) => c.endsWith(':ticket')));
});

test('thread sem run retorna sem_execucao na hora, sem esperar um run futuro', async () => {
  const d = dadosPadrao();
  d.local.shell.threads.push(thread({ id: 't-idle', projectId: 'proj-app-local', status: 'idle', latestRunId: null }));
  const r = await esperar({ environment: 'local', threadId: 't-idle', timeoutMs: 2000 }, { assinarImpl: async () => { throw new Error('não'); } }, { dados: d });
  assert.deepEqual([r.state, r.runId, r.timedOut, r.returnReason], ['no_run', null, false, 'no_run']);
});

test('última resposta vem do run acompanhado, do snapshot e dos eventos', async () => {
  const r = await esperar(
    { environment: 'remoto', threadId: 't-comum', timeoutMs: 2000, includeLatestResponse: true },
    { assinarImpl: assinaturaFalsa([
      [5, [snapshot({ messages: [mensagem({ id: 'm-velha', runId: 'run-velho', text: 'De outro run.' })] })]],
      [20, [evento('message.updated', mensagem({ id: 'm-nova', runId: 'run-s1', text: 'Terminei.' })), evento('run.updated', { ...RUN, status: 'completed' }, 12)]],
    ]) },
  );
  assert.equal(r.latestResponse.text, 'Terminei.');
  assert.equal(r.latestResponse.runId, 'run-s1');
});

test('thread inexistente, de projeto não autorizado ou de outro environment: recusa, não timeout', async () => {
  const chamadas = [];
  for (const [ambiente, threadId] of [['remoto', 'nao-existe'], ['local', 't-alheia'], ['local', 't-llm']]) {
    await assert.rejects(
      esperar({ environment: ambiente, threadId, timeoutMs: 2000 }, { assinarImpl: async () => { throw new Error('não'); } }, { chamadas }),
      (e) => e instanceof ForaDoEscopo && e.message.includes(`environment ${ambiente}`),
    );
  }
  assert.ok(!chamadas.some((c) => c.endsWith(':ticket')), 'não abre subscription fora do escopo');
});

test('runId inexistente é erro, não timeout', async () => {
  await assert.rejects(
    esperar({ environment: 'remoto', threadId: 't-comum', timeoutMs: 2000, runId: 'run-x' }, { assinarImpl: assinaturaFalsa([[5, [snapshot()]]]) }),
    /run run-x not found/,
  );
});

test('cancelamento pelo cliente encerra a subscription e não vira resultado', async () => {
  const reg = {};
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 40);
  const inicio = Date.now();
  await assert.rejects(
    esperar({ environment: 'remoto', threadId: 't-comum', timeoutMs: 5000 }, { signal: ac.signal, assinarImpl: assinaturaFalsa([[5, [snapshot()]]], reg) }),
    (e) => e instanceof Cancelada,
  );
  assert.ok(Date.now() - inicio < 1000);
  assert.equal(reg.encerrada, true);
});

test('WS que cai antes do prazo é erro de transporte, não estado inventado', async () => {
  await assert.rejects(
    esperar({ environment: 'remoto', threadId: 't-comum', timeoutMs: 2000 }, { assinarImpl: assinaturaFalsa([[5, [snapshot()]], [20, 'cair']]) }),
    /closed during the wait/,
  );
});

test('environment que não responde no prazo: erro sem estado observado', async () => {
  const ambientes = ambientesFalsos();
  const r = ambientes.resolver('remoto');
  r.transporte.baseUrl = () => new Promise(() => {});
  await assert.rejects(
    aguardarThread(ambientes, { environment: 'remoto', threadId: 't-comum', timeoutMs: 100 }),
    /did not respond within 100 ms; no state observed/,
  );
});

// Regressão do steer (polaris f7311b4b, 05/10/2026): o último run (ordinal 4) foi
// cancelado ao promover a mensagem da fila, mas o run ordinal 1 seguia rodando. A espera
// devolvia na hora terminal/cancelled do último run, e o cliente concluía que a thread parou.
function dadosSteer() {
  const d = dadosPadrao();
  d.remoto.shell.threads.push(thread({
    id: 't-steer', projectId: REMOTO.projeto, status: 'cancelled',
    latestRunId: 'run-o4', activeRunId: 'run-o1', activityRunStatus: 'running',
  }));
  return d;
}
const RUNS_STEER = [{ id: 'run-o1', ordinal: 1, status: 'running' }, { id: 'run-o4', ordinal: 4, status: 'cancelled' }];

test('steer: sem runId segue o run ativo, não o último run cancelado', async () => {
  const r = await esperar(
    { environment: 'remoto', threadId: 't-steer', timeoutMs: 150 },
    { assinarImpl: assinaturaFalsa([[5, [snapshot({ runs: RUNS_STEER })]]]) },
    { dados: dadosSteer() },
  );
  assert.equal(r.runId, 'run-o1');
  assert.equal(r.state, 'running');
  assert.equal(r.terminal, false);
  assert.equal(r.returnReason, 'timeout');
});

test('steer: termina quando o run ativo termina', async () => {
  const r = await esperar(
    { environment: 'remoto', threadId: 't-steer', timeoutMs: 5000 },
    { assinarImpl: assinaturaFalsa([[5, [snapshot({ runs: RUNS_STEER })]], [30, [evento('run.updated', { ...RUNS_STEER[0], status: 'completed' })]]]) },
    { dados: dadosSteer() },
  );
  assert.equal(r.runId, 'run-o1');
  assert.equal(r.state, 'completed');
  assert.equal(r.returnReason, 'terminal');
});

test('steer: runId explícito do último run devolve o desfecho dele sem assinar', async () => {
  const chamadas = [];
  const r = await esperar(
    { environment: 'remoto', threadId: 't-steer', timeoutMs: 1000, runId: 'run-o4' },
    { assinarImpl: () => assert.fail('não deve assinar') },
    { dados: dadosSteer(), chamadas },
  );
  assert.equal(r.runId, 'run-o4');
  assert.equal(r.state, 'cancelled');
  assert.equal(r.returnReason, 'terminal');
});
