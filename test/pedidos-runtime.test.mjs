import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumirPedidoRuntime, resumirPedidosRuntime } from '../src/pedidos-runtime.mjs';
import { pedido, projecao, thread } from './fixtures.mjs';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao } from './apoio.mjs';
import { leituraProtegida } from '../src/escrita/read-guarded.mjs';
import { parseAction } from '../src/escrita/adapters.mjs';

const question = { id: 'name', header: 'Name', question: 'What name?', options: [], allowCustomAnswer: true };
const input = (fields = {}) => ({ type: 'user_input_request', nodeId: 'node-approval-1', requestId: 'req-1', questions: [question], ...fields });

test('textual user_input exposes full question and response capability, without native/session details', () => {
  const q = { ...question, question: 'Long question '.repeat(100), internal: 'secret' };
  const p = projecao({ turnItems: [input({ questions: [q], questionAnswer: { answers: { name: 'previous' } }, nativePayload: 'secret' })] });
  const r = resumirPedidoRuntime(p, pedido({ kind: 'user_input' }));
  assert.deepEqual(r.conteudo, { tipo: 'user_input', questions: [{ ...question, question: q.question }] });
  assert.equal(r.requestId, 'req-1');
  assert.equal(r.runtimeRequestId, r.requestId);
  assert.equal(r.conteudoDisponivel, true);
  assert.equal(r.indisponibilidade, null);
  assert.deepEqual(r.responseCapability, { type: 'live' });
  assert.doesNotMatch(JSON.stringify(r), /secret|nativeRequestRef|providerSessionId|previous/);
});

test('choice fields retain IDs, values and constraints for answers keyed by question ID', () => {
  const q = { ...question, id: 'destinations', options: [{ label: 'One', description: 'First', value: 'one', private: 'hidden' }], multiSelect: true, allowCustomAnswer: false, required: true };
  const r = resumirPedidoRuntime(projecao({ turnItems: [input({ questions: [q], responseMode: 'message' })] }), pedido({ kind: 'user_input', responseCapability: { type: 'message' } }));
  assert.deepEqual(r.conteudo, { tipo: 'user_input', responseMode: 'message', questions: [{ ...q, options: [{ label: 'One', description: 'First', value: 'one' }] }] });
  assert.deepEqual(r.responseCapability, { type: 'message' });
  const encoded = parseAction('runtime-request.answer', {
    threadId: 'thread-1', requestId: r.requestId,
    answers: { [r.conteudo.questions[0].id]: [r.conteudo.questions[0].options[0].value] },
  });
  assert.deepEqual(encoded.spec.encode(encoded.input).answers, { destinations: ['one'] });
});

test('approval exposes prompt, app and provider decisions/warnings, separately from questions', () => {
  const options = [{ decision: 'accept', label: 'Allow', warning: 'Untrusted input', internal: 'hidden' }, { decision: 'decline', label: 'Reject' }];
  for (const kind of ['command', 'file-read', 'file-change', 'permission', 'mcp-elicitation']) {
    const r = resumirPedidoRuntime(projecao({ turnItems: [{ type: 'approval_request', requestId: 'req-1', requestKind: kind, prompt: 'Allow access?', appName: 'Example', options, questions: [question], nativePayload: 'hidden' }] }), pedido({ kind }));
    assert.deepEqual(r.conteudo, { tipo: 'approval', prompt: 'Allow access?', appName: 'Example', options: [{ decision: 'accept', label: 'Allow', warning: 'Untrusted input' }, { decision: 'decline', label: 'Reject' }] });
    assert.doesNotMatch(JSON.stringify(r), /hidden|questions/);
    const encoded = parseAction('runtime-request.approve', { threadId: 'thread-1', requestId: r.requestId, decision: r.conteudo.options[1].decision });
    assert.equal(encoded.spec.encode(encoded.input).decision, 'decline');
  }
});

test('absent provider options are not invented; non-resumable status is explicit', () => {
  const r = resumirPedidoRuntime(projecao({ turnItems: [{ type: 'approval_request', requestId: 'req-1', requestKind: 'command', prompt: 'Run build?' }] }), pedido({ responseCapability: { type: 'not_resumable', reason: 'Session closed', internal: 'hidden' } }));
  assert.deepEqual(r.conteudo, { tipo: 'approval', prompt: 'Run build?' });
  assert.deepEqual(r.responseCapability, { type: 'not_resumable', reason: 'Session closed' });
});

test('same-node unrelated request and wrong item type cannot supply the payload', () => {
  for (const item of [input({ requestId: 'other', title: 'Unrelated question' }), input({ type: 'approval_request' })]) {
    const r = resumirPedidoRuntime(projecao({ turnItems: [item] }), pedido({ kind: 'user_input' }));
    assert.equal(r.conteudo, null);
    assert.equal(r.conteudoDisponivel, false);
    assert.equal(r.indisponibilidade, 'request_detail_not_in_snapshot');
    assert.equal(r.detalhe, null);
  }
});

test('incomplete question/schema or mismatched approval kind fails explicitly', () => {
  for (const item of [input({ questions: [] }), input({ questions: [{ ...question, id: undefined }] }), input({ questions: [{ ...question, question: ' ' }] }), input({ questions: [{ ...question, options: [{}] }] })]) {
    const r = resumirPedidoRuntime(projecao({ turnItems: [item] }), pedido({ kind: 'user_input' }));
    assert.equal(r.conteudo, null);
    assert.equal(r.indisponibilidade, 'request_detail_incomplete_or_invalid');
  }
  const r = resumirPedidoRuntime(projecao({ turnItems: [{ type: 'approval_request', requestId: 'req-1', requestKind: 'permission', prompt: 'Allow?' }] }), pedido());
  assert.equal(r.indisponibilidade, 'request_detail_incomplete_or_invalid');
});

test('missing detail and unsupported kind never fabricate a question or approval', () => {
  const r = resumirPedidoRuntime(projecao(), pedido({ kind: 'user_input' }));
  assert.equal(r.indisponibilidade, 'request_detail_not_in_snapshot');
  assert.equal(r.conteudo, null);
  assert.equal(resumirPedidoRuntime(projecao(), pedido({ kind: 'auth_refresh' })).indisponibilidade, 'unsupported_request_kind');
});

test('shell-only pending request stays visible; resolved requests are excluded', () => {
  const t = thread({ pendingRuntimeRequest: { id: 'req-1', kind: 'user_input', createdAt: 'now' } });
  const [r] = resumirPedidosRuntime(projecao(), t);
  assert.equal(r.requestId, 'req-1');
  assert.equal(r.responseCapability, null);
  assert.equal(r.conteudoDisponivel, false);
  assert.deepEqual(resumirPedidosRuntime(projecao({ pedidos: [pedido({ status: 'resolved' })] }), t), []);
});

test('t3_thread exposes the contract through MCP and scoped write-plugin reads', async (t) => {
  const fixture = dadosPadrao();
  fixture.local.bounded['t-local'].projection = projecao({ pedidos: [pedido({ kind: 'user_input' })], turnItems: [input()] });
  const calls = [];
  const c = await conectarMcp(ambientesFalsos(fixture, { chamadas: calls }));
  t.after(() => c.close());
  const result = dados(await c.callTool({ name: 't3_thread', arguments: { threadId: 't-local', maxCaracteres: 200 } }));
  assert.deepEqual(result.pedidosPendentes[0].conteudo.questions, [question]);
  const guarded = await leituraProtegida({
    verificar: () => ({ readProjectIds: [fixture.local.shell.threads[1].projectId] }),
    cliente: { shell: async () => fixture.local.shell, thread: async () => fixture.local.bounded['t-local'] },
    ambiente: { alias: 'local', environmentId: 'env-local' }, operation: 't3_thread', input: { threadId: 't-local' },
  });
  assert.deepEqual(dados(guarded).pedidosPendentes, result.pedidosPendentes);
  calls.length = 0;
  const denied = await c.callTool({ name: 't3_thread', arguments: { threadId: 't-alheia' } });
  assert.equal(denied.isError, true);
  assert.ok(!calls.some(s => s.includes('thread:')));
});
