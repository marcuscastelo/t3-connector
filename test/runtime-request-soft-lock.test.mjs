import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { criarPonteEscrita } from '../src/escrita/ponte-mcp.mjs';
import { Dispatcher } from '../src/escrita/adapters.mjs';
import { leituraProtegida } from '../src/escrita/read-guarded.mjs';
import { setup, memoryJournal } from './escrita-fixtures.mjs';
import { pedido, projecao, thread } from './fixtures.mjs';
import { dados } from './apoio.mjs';

// Regression of the reported incident, with synthetic IDs/content. This stateful V2
// backend double models queue-vs-response semantics; it does not claim live T3 coverage.
test('blocked user_input: concurrent send queues; answering the existing request resumes the same run', async (t) => {
  const requestId = 'pending-question', threadId = 'blocked-thread', runId = 'blocked-run';
  const questions = [{
    id: 'approach', header: 'Approach', question: 'Which approach should the run use?',
    options: [
      { label: 'Option 1', description: 'Continue with the existing API', value: 'existing' },
      { label: 'Option 2', description: 'Build a new API', value: 'new' },
    ], multiSelect: false, allowCustomAnswer: false, required: true,
  }];
  const shellThread = thread({ id: threadId, projectId: 'app', activeRunId: runId, latestRunId: runId,
    status: 'waiting', pendingRuntimeRequest: { id: requestId, kind: 'user_input', createdAt: 'now' } });
  const projection = projecao({
    pedidos: [pedido({ id: requestId, kind: 'user_input' })],
    turnItems: [{ type: 'user_input_request', requestId, nodeId: 'node-approval-1', questions }],
    runs: [{ id: runId, ordinal: 1, status: 'waiting' }],
  });
  const queue = [], outbound = [];
  const backend = {
    shell: async () => ({ projects: [{ id: 'app', title: 'App' }], threads: [shellThread] }),
    thread: async id => { assert.equal(id, threadId); return { projection, hasMoreHistory: false }; },
  };
  const s = setup();
  s.env.actions = ['thread.send', 'runtime-request.answer', 'runtime-request.approve'];
  const lease = await s.grant();
  const dispatcher = new Dispatcher({ gate: s.gate, journal: memoryJournal(),
    environmentId: s.env.environmentId, destination: s.env.destination,
    adapter: {
      projectForThread: async id => { assert.equal(id, threadId); return 'app'; },
      receipt: result => result,
      invoke: async (method, command) => {
        assert.equal(method, 'orchestration.dispatchCommand');
        assert.equal(command.threadId, threadId);
        outbound.push(command);
        if (command.type === 'message.dispatch') {
          assert.equal(command.dispatchMode.type, 'start_immediately');
          assert.equal(shellThread.status, 'waiting');
          queue.push(command);
          return { sequence: outbound.length };
        }
        assert.equal(command.type, 'runtime-request.respond');
        assert.equal(command.requestId, requestId);
        assert.equal(command.decision, undefined, 'user_input is answered, not approved');
        assert.deepEqual(command.answers, { approach: 'existing' });
        projection.runtimeRequests[0].status = 'resolved';
        projection.runs[0].status = 'running';
        shellThread.pendingRuntimeRequest = null;
        shellThread.status = 'running';
        return { sequence: outbound.length };
      },
    },
  });
  const ambiente = { alias: 'local', environmentId: s.env.environmentId };
  const server = criarPonteEscrita({ aliases: ['local'], approvalOrigin: 'http://localhost:7433',
    relay: async req => {
      assert.equal(req.ambiente, 'local');
      if (req.op === 'dispatch') return dispatcher.dispatch(s.caller, req.leaseId, req);
      assert.equal(req.op, 'read');
      return leituraProtegida({ cliente: backend, ambiente, operation: req.operation, input: req.input,
        verificar: () => { assert.equal(s.gate.status(req.leaseId).active, true); return { readProjectIds: ['app'] }; } });
    },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'soft-lock-regression', version: '1' });
  await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const read = async () => dados(await client.callTool({ name: 't3_thread',
    arguments: { leaseId: lease.leaseId, ambiente: 'local', threadId } }));

  const before = await read();
  assert.equal(before.estado, 'precisa_intervencao');
  assert.equal(before.statusRun, 'waiting');
  const pending = before.pedidosPendentes[0];
  assert.deepEqual(pending.conteudo, { tipo: 'user_input', questions });
  assert.equal(pending.threadSendRespondePedido, false);
  assert.deepEqual(pending.proximaAcao, {
    tipo: 'responder_runtime_request', action: 'runtime-request.answer',
    tool: 't3_escrever_runtime_request_answer', input: { threadId, requestId },
    campoResposta: 'answers', requerDecisaoDoUsuario: true,
  });
  const tools = (await client.listTools()).tools;
  assert.match(tools.find(x => x.name === 't3_thread').description, /thread.send does NOT answer/);
  assert.match(tools.find(x => x.name === 't3_escrever_thread_send').description, /thread.send does NOT answer.*queued.*blocked/);
  assert.match(tools.find(x => x.name === 't3_escrever_runtime_request_answer').description, /user_input.*requestId.*answers/);
  assert.match(tools.find(x => x.name === 't3_escrever_runtime_request_approve').description, /approval.*decision.*user_input requires runtime-request.answer/);

  const [, sent] = await Promise.all([read(), client.callTool({ name: 't3_escrever_thread_send', arguments: {
    leaseId: lease.leaseId, ambiente: 'local', operationId: 'concurrent-send',
    input: { threadId, text: 'Use option 1', clientRequestId: 'concurrent-send', delivery: 'start_immediately' },
  } })]);
  assert.equal(sent.isError, undefined);
  assert.equal(queue.length, 1);
  const stillBlocked = await read();
  assert.equal(stillBlocked.statusRun, 'waiting');
  assert.equal(stillBlocked.pedidosPendentes[0].requestId, requestId);
  assert.equal(stillBlocked.pedidosPendentes[0].proximaAcao.action, 'runtime-request.answer');
  assert.equal(stillBlocked.pedidosPendentes[0].threadSendRespondePedido, false);

  // Model the user's explicit selection of option 1, using only IDs/values from read.
  const next = pending.proximaAcao, q = pending.conteudo.questions[0];
  const answered = await client.callTool({ name: next.tool, arguments: {
    leaseId: lease.leaseId, ambiente: 'local', operationId: 'answer-existing-request',
    input: { ...next.input, [next.campoResposta]: { [q.id]: q.options[0].value } },
  } });
  assert.equal(answered.isError, undefined);
  assert.equal(dados(answered).state, 'completed');
  const after = await read();
  assert.deepEqual(after.pedidosPendentes, []);
  assert.equal(after.estado, 'rodando');
  assert.equal(after.statusRun, 'running');
  assert.equal(after.runId, runId, 'answer resumes the same run instead of replacing it');
  assert.equal(outbound.length, 2, 'no send, approval or restart is substituted for the answer');
});
