import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estadoDaThread, pedidosPendentes, ultimaResposta, detalheDoPedido, resumoModelo } from '../src/estado.mjs';
import { thread, pedido, projecao, mensagem } from './fixtures.mjs';

test('run concluído é concluída, nunca intervenção', () => {
  const e = estadoDaThread(thread({ status: 'completed' }));
  assert.equal(e.state, 'completed');
  assert.equal(e.runId, 'run-1');
});

test('aprovação de comando pendente vira intervenção com o id do pedido', () => {
  const e = estadoDaThread(thread({
    status: 'waiting', activeRunId: 'run-2',
    pendingRuntimeRequest: { id: 'req-9', kind: 'command', createdAt: '2026-10-03T10:04:00.000Z' },
  }));
  assert.equal(e.state, 'needs_intervention');
  assert.equal(e.reason, 'command approval');
  assert.deepEqual(e.identifier, { runtimeRequestId: 'req-9' });
  assert.equal(e.runId, 'run-2');
});

test('pergunta ao usuário tem motivo próprio', () => {
  const e = estadoDaThread(thread({ status: 'waiting', pendingRuntimeRequest: { id: 'req-q', kind: 'user_input', createdAt: 'x' } }));
  assert.equal(e.reason, 'question waiting for an answer');
});

test('pedido pendente vence o status do run, mesmo running', () => {
  const e = estadoDaThread(thread({ status: 'running', pendingRuntimeRequest: { id: 'r', kind: 'file-change', createdAt: 'x' } }));
  assert.equal(e.state, 'needs_intervention');
  assert.equal(e.kind, 'file-change');
});

test('waiting sem pedido no resumo não é término nem intervenção confirmada', () => {
  const e = estadoDaThread(thread({ status: 'waiting', activeRunId: 'run-2' }));
  assert.equal(e.state, 'running');
  assert.match(e.note, /no visible pending request/);
});

test('waiting com pedido pendente no /bounded vira intervenção', () => {
  const pendentes = pedidosPendentes(projecao({ pedidos: [pedido({ status: 'resolved', id: 'velho' }), pedido({ id: 'req-2', kind: 'permission' })] }));
  assert.deepEqual(pendentes.map((p) => p.id), ['req-2']);
  const e = estadoDaThread(thread({ status: 'waiting' }), pendentes);
  assert.equal(e.state, 'needs_intervention');
  assert.deepEqual(e.identifier, { runtimeRequestId: 'req-2' });
});

test('estados de run ativos são rodando', () => {
  for (const status of ['preparing', 'queued', 'starting', 'running']) {
    assert.equal(estadoDaThread(thread({ status })).state, 'running', status);
  }
});

test('falha carrega erro e classe', () => {
  const e = estadoDaThread(thread({ status: 'failed', lastError: 'boom', lastErrorClass: 'provider_error' }));
  assert.equal(e.state, 'failed');
  assert.equal(e.error, 'boom');
});

test('interrompida, cancelada e revertida são cancelada com o status original', () => {
  for (const status of ['interrupted', 'cancelled', 'rolled_back']) {
    const e = estadoDaThread(thread({ status }));
    assert.equal(e.state, 'cancelled');
    assert.equal(e.statusRun, status);
  }
});

test('idle é thread sem run no V2', () => {
  assert.equal(estadoDaThread(thread({ status: 'idle', latestRunId: null })).state, 'no_run');
});

test('limite de uso sem retomada automática pede intervenção; com retomada, não', () => {
  const sem = estadoDaThread(thread({ status: 'failed', limitRecovery: { runId: 'run-1', resetAt: '2026-10-03T15:00:00Z', autoResume: false } }));
  assert.equal(sem.state, 'needs_intervention');
  assert.equal(sem.kind, 'usage_limit');
  assert.deepEqual(sem.identifier, { runId: 'run-1' });
  const com = estadoDaThread(thread({ status: 'failed', limitRecovery: { runId: 'run-1', resetAt: 'x', autoResume: true } }));
  assert.equal(com.state, 'failed');
});

test('plano proposto aguardando decisão é intervenção, não conclusão', () => {
  const e = estadoDaThread(thread({ status: 'completed', hasActionableProposedPlan: true }));
  assert.equal(e.state, 'needs_intervention');
  assert.equal(e.kind, 'proposed_plan');
});

test('concluída com trabalho em segundo plano informa as tarefas', () => {
  const e = estadoDaThread(thread({ status: 'completed', pendingBackgroundTasks: [{ kind: 'command', taskId: 't1', description: 'build' }] }));
  assert.equal(e.state, 'completed');
  assert.deepEqual(e.backgroundTasks, [{ kind: 'command', taskId: 't1', description: 'build' }]);
});

test('última resposta é a última mensagem do assistente, truncada pelo fim', () => {
  const p = projecao({ mensagens: [mensagem({ id: 'a', text: 'primeira' }), mensagem({ id: 'u', role: 'user', text: 'pergunta' }), mensagem({ id: 'b', text: 'x'.repeat(10) + 'FIM' })] });
  const r = ultimaResposta(p, 5);
  assert.equal(r.messageId, 'b');
  assert.equal(r.text, 'xxFIM');
  assert.equal(r.truncated, true);
  assert.equal(ultimaResposta(projecao()), null);
});

test('detalhe do pedido vem do item de turno do mesmo nó', () => {
  const p = projecao({ pedidos: [pedido()], turnItems: [{ nodeId: 'node-approval-1', title: 'npm test' }] });
  assert.equal(detalheDoPedido(p, pedido()), 'npm test');
});

test('resumo de modelo lê effort de Claude e reasoningEffort de Codex', () => {
  assert.deepEqual(resumoModelo({ instanceId: 'codex', model: 'gpt-6.1-sol', options: [{ id: 'reasoningEffort', value: 'high' }] }),
    { model: 'gpt-6.1-sol', instanceId: 'codex', effort: 'high' });
  assert.equal(resumoModelo({ model: 'claude-opus-5-5', options: [{ id: 'effort', value: 'medium' }] }).effort, 'medium');
});
