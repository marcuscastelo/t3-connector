// Aquisição compartilhada de `execution` (lerExecucaoDaThread): a mesma observação
// shell → completo → shell do settlement serve o preflight de send, com limite de uso, plano e
// roster da shell; sem coerência, a projeção completa mais recente, declarada projection_only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { lerExecucaoDaThread } from '../src/settlement.mjs';
import { criarConexaoEscrita } from '../src/escrita/conexao.mjs';
import { liveReadContext, consentAll } from '../src/oauth/project-policy.mjs';
import { SessionAuthority } from '../src/oauth/session-authority.mjs';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao } from './apoio.mjs';
import { mensagem, projecao, thread } from './fixtures.mjs';

const runs1 = [{ id: 'run-1', ordinal: 1, status: 'completed' }];
const snap = (campos = {}) => ({ snapshotSequence: 50, projection: { ...projecao({ runs: runs1, mensagens: [mensagem()] }), thread: { id: 'thread-1' }, providerThreads: [], ...campos } });
const ler = (shellThread, completo = snap(), extra = {}) => lerExecucaoDaThread({
  environmentId: 'env-local', threadId: 'thread-1',
  lerShell: async () => ({ threads: [typeof shellThread === 'function' ? shellThread() : shellThread] }),
  lerCompleto: async () => completo, ...extra,
});

test('aquisição: limite de uso e plano que só a shell traz entram em execution', async () => {
  const limite = (await ler(thread({ limitRecovery: { runId: 'run-1', autoResume: false } }))).execucao;
  assert.ok(limite.continuation.blockers.includes('usage_limit'));
  assert.equal(limite.source.kind, 'thread_full_snapshot');
  assert.equal(limite.coherence.status, 'coherent');
  const plano = (await ler(thread({ hasActionableProposedPlan: true }))).execucao;
  assert.ok(plano.continuation.blockers.includes('proposed_plan'));
  const livre = (await ler(thread())).execucao;
  assert.deepEqual(livre.continuation.blockers, []);
});

test('aquisição: thread mudando entre as leituras cai para a projeção, declarada projection_only', async () => {
  let n = 0;
  let completos = 0;
  const { execucao, lido } = await ler(() => thread({ latestVisibleMessage: { id: `m-${n++}` }, limitRecovery: { runId: 'run-1', autoResume: false } }), undefined, { lerCompleto: async () => (completos++, snap()) });
  assert.equal(completos, 3, 'reaproveita o último snapshot completo, sem leitura extra');
  assert.equal(lido.observacao.complete, false);
  assert.equal(execucao.coherence.status, 'projection_only');
  assert.equal(execucao.coherence.attempts, 3);
  // Sem shell coerente o limite não é conhecido: a falta fica dita, não inventada.
  assert.equal(execucao.continuation.blockers.includes('usage_limit'), false);
});

test('aquisição: thread fora da shell ainda lê a projeção completa; sem projeção, falha', async () => {
  let completos = 0;
  const args = { environmentId: 'env-local', threadId: 'thread-1', lerShell: async () => ({ threads: [] }), lerCompleto: async () => (completos++, snap()) };
  assert.equal((await lerExecucaoDaThread(args)).execucao.coherence.status, 'projection_only');
  assert.equal(completos, 1);
  await assert.rejects(lerExecucaoDaThread({ ...args, lerCompleto: async () => ({}) }), /execution_snapshot_unavailable/);
});

test('conexão de escrita: o preflight de send usa a aquisição compartilhada (shell + completo)', async () => {
  const leituras = [];
  const cliente = () => ({
    ambiente: async () => ({ orchestrationProtocolVersion: 2, environmentId: 'env-s', label: 'remoto', serverVersion: 'v' }),
    sessao: async () => ({ scopes: ['orchestration:read', 'orchestration:operate'] }),
    shell: async () => (leituras.push('shell'), { projects: [{ id: 'app', title: 'app', workspaceRoot: '/home/dev/app' }], threads: [thread({ id: 'thread-1', projectId: 'app', limitRecovery: { runId: 'run-1', autoResume: false } })] }),
    threadCompleto: async () => (leituras.push('completo'), snap()),
    ticketWs: async () => 'ticket',
  });
  const registro = { alias: 'remoto', environmentId: 'env-s', ssh: { host: 'remoto' }, tokenFile: '/x', destination: 't3://env-s' };
  const transporte = { baseUrl: async () => 'http://127.0.0.1:43773', descartar() {}, fechar() {} };
  const c = criarConexaoEscrita(registro, { transporte, lerToken: () => 't', criarClienteImpl: cliente });
  const execucao = await c.adapter.executionSnapshot('thread-1');
  assert.deepEqual(leituras, ['shell', 'completo', 'shell']);
  assert.ok(execucao.continuation.blockers.includes('usage_limit'));
  c.fechar();
});

test('OAuth all: a observação do settlement relê a shell em vez do inventário da invocação', async () => {
  const d = dadosPadrao();
  const base = d.local.shell;
  d.local.completo = { 't-comum': { snapshotSequence: 77, projection: { ...d.local.bounded['t-comum'].projection, thread: { id: 't-comum' } } } };
  const authority = new SessionAuthority();
  const ambientes = ambientesFalsos(d);
  const grants = consentAll(ambientes.registros);
  const sid = authority.create({ sub: 'local:subjectAAAA01', clientId: 'c', credentialId: 'k', scope: 'connector:read', resource: 'r', grants });
  const c = await conectarMcp(liveReadContext(ambientes, authority, { sub: 'local:subjectAAAA01', sid }));
  const ler = async () => dados(await c.callTool({ name: 't3_thread', arguments: { environment: 'local', threadId: 't-comum', settlementContractVersion: 1 } })).settlement;
  assert.equal((await ler()).complete, true);
  // A thread muda a cada leitura real da shell: com o inventário em cache isso passaria batido.
  let n = 0;
  d.local.shell = () => ({ ...base, threads: base.threads.map((t) => (t.id === 't-comum' ? { ...t, latestVisibleMessage: { id: `m-${n++}` } } : t)) });
  const mudando = await ler();
  assert.equal(mudando.complete, false);
  assert.equal(mudando.blockers[0].reason, 'thread_changed_during_observation');
  ambientes.fechar();
});
