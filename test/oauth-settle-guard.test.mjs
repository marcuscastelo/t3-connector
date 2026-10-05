// settleGuard pelo perfil OAuth: schema descobrível, recusa com código seguro e mensagem,
// nada enviado e sessão preservada. t3_workset também aparece no catálogo de leitura.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startConnector } from './oauth-apoio.mjs';
import { ambientesFalsos } from './apoio.mjs';
import { memoryJournal } from './escrita-fixtures.mjs';
import { t3Tools } from '../src/oauth/t3-tools.mjs';
import { writeToolName } from '../src/oauth/session-writes.mjs';
import { observarSettlement } from '../src/settlement.mjs';
import { pedido, projecao, thread } from './fixtures.mjs';

function conexao(alias, environmentId, observacao) {
  const calls = [];
  return {
    calls, projetos: [{ id: 'app', name: 'app', directory: `/${alias}/app` }],
    registro: { alias, environmentId, destination: `t3://${environmentId}`, acoes: ['thread.settle'] },
    inventario: async () => [{ id: 'app', name: 'app', directory: `/${alias}/app` }],
    adapter: {
      prepare: async () => {}, projectForThread: async () => 'app',
      invoke: async (m, p) => { calls.push({ m, p }); return { sequence: 1 }; },
      receipt: r => ({ sequence: r.sequence }), reconcile: async () => ({ found: false, state: 'unknown' }),
      ...(observacao ? { settlementObservation: async () => observacao() } : {}),
    },
    fechar() {},
  };
}

const comPedido = () => observarSettlement({
  environmentId: 'env-p',
  thread: thread({ id: 'thread', projectId: 'app' }),
  snapshot: { snapshotSequence: 9, projection: { ...projecao({ runs: [{ id: 'run-1', ordinal: 1, status: 'completed' }], pedidos: [pedido({ id: 'req-1' })] }), thread: { id: 'thread' } } },
});

test('OAuth: thread.settle anuncia settleGuard; recusa do guard não envia nem derruba a sessão', async t => {
  const local = conexao('local', 'env-p', comPedido), remoto = conexao('remoto', 'env-s', null);
  const c = await startConnector({ tools: t3Tools({ ambientes: ambientesFalsos(), conexoes: [local, remoto], journal: { ...memoryJournal(), audit: () => {} }, projectPolicy: 'restricted' }) });
  t.after(c.close);
  const at = (await c.signIn()).tokens.access_token;
  const tools = (await c.mcp(at, 'tools/list')).data.result.tools;
  assert.ok(tools.some(x => x.name === 't3_workset'));
  const settleTool = tools.find(x => x.name === writeToolName('thread.settle'));
  assert.ok(settleTool.inputSchema.properties.input.properties.settleGuard);
  assert.match(settleTool.description, /completed run is NOT acceptance/);
  const guard = { version: 1, expectedRunId: 'run-1', expectedObservationId: comPedido().observationId, acceptance: { accepted: true, evidenceRef: 'ok' } };
  const r = await c.callTool(at, writeToolName('thread.settle'), { environment: 'local', operationId: 'g1', input: { threadId: 'thread', settleGuard: guard } });
  assert.equal(r.data.result.isError, true);
  assert.match(r.data.result.content[0].text, /^settle_pending_request: .*nothing was sent/);
  assert.equal(local.calls.length, 0);
  // Ambiente sem observação disponível: recusa fechada, nunca settle sem guard.
  const r2 = await c.callTool(at, writeToolName('thread.settle'), { environment: 'remoto', operationId: 'g2', input: { threadId: 'thread', settleGuard: guard } });
  assert.match(r2.data.result.content[0].text, /^settle_observation_incomplete: /);
  assert.equal(remoto.calls.length, 0);
  // A sessão continua válida: a escrita legacy segue passando.
  const r3 = await c.callTool(at, writeToolName('thread.settle'), { environment: 'remoto', operationId: 'g3', input: { threadId: 'thread' } });
  assert.ok(!r3.data.result.isError, r3.text);
  assert.equal(remoto.calls.length, 1);
  assert.deepEqual(Object.keys(remoto.calls[0].p).sort(), ['commandId', 'threadId', 'type']);
});
