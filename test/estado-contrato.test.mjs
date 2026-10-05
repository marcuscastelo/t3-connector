// Contrato de fontes de verdade da thread, pelas ferramentas MCP, nos dois casos reais de
// 05/10/2026 (polaris):
// - f7311b4b: shell `status: cancelled` do run ordinal 4 (mensagem promovida a steer)
//   com o run ordinal 1 ainda rodando; o snapshot limitado só trazia o run 1;
// - cb2f6035: após trocar de Fable 5.1 para Opus 5.5, `thread.modelSelection` e o run
//   ativo eram Opus 5.5, mas `providerSession.model` seguia Fable 5.1, em `ready`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ambientesFalsos, conectarMcp, dados, dadosPadrao, LOCAL } from './apoio.mjs';
import { mensagem, projecao, thread } from './fixtures.mjs';

const OPUS = { instanceId: 'claudeAgent_pessoal', model: 'claude-opus-5-5', options: [{ id: 'effort', value: 'high' }] };
const FABLE = { instanceId: 'claudeAgent_pessoal', model: 'claude-fable-5-1', options: [{ id: 'effort', value: 'high' }] };

function dadosReais() {
  const d = dadosPadrao();
  d.local.shell.threads.push(
    thread({
      id: 't-steer', projectId: LOCAL.projeto, title: 'Steer', providerInstanceId: 'claudeAgent_pessoal', modelSelection: OPUS,
      status: 'cancelled', latestRunId: 'run-o4', activeRunId: 'run-o1', activityRunStatus: 'running',
    }),
    thread({
      id: 't-modelo', projectId: LOCAL.projeto, title: 'Troca de modelo', providerInstanceId: 'claudeAgent_pessoal', modelSelection: OPUS,
      status: 'running', latestRunId: 'run-m3', activeRunId: 'run-m3', activityRunStatus: 'running',
    }),
  );
  const sessaoFable = { id: 'ps-1', providerInstanceId: 'claudeAgent_pessoal', status: 'ready', cwd: '/repo', model: 'claude-fable-5-1', updatedAt: '2026-10-05T21:39:04.679Z' };
  d.local.bounded['t-steer'] = {
    projection: {
      ...projecao({ mensagens: [mensagem({ runId: 'run-o1', streaming: true, text: 'Trabalhando.' })], runs: [{ id: 'run-o1', ordinal: 1, status: 'running', modelSelection: OPUS }] }),
      providerSessions: [{ ...sessaoFable, model: 'claude-opus-5-5' }],
    },
    hasMoreHistory: false,
  };
  d.local.bounded['t-modelo'] = {
    projection: {
      ...projecao({ runs: [
        { id: 'run-m1', ordinal: 1, status: 'interrupted', modelSelection: FABLE },
        { id: 'run-m2', ordinal: 2, status: 'interrupted', modelSelection: FABLE },
        { id: 'run-m3', ordinal: 3, status: 'running', modelSelection: OPUS },
      ] }),
      providerSessions: [
        { ...sessaoFable, id: 'ps-velha', providerInstanceId: 'codex', model: 'gpt-6.1-sol', updatedAt: '2026-10-05T22:00:00.000Z' },
        sessaoFable,
      ],
    },
    hasMoreHistory: false,
  };
  return d;
}

test('t3_thread: run ativo vence o último run cancelado e o último run fica só como informação', async () => {
  const c = await conectarMcp(ambientesFalsos(dadosReais()));
  const d = dados(await c.callTool({ name: 't3_thread', arguments: { threadId: 't-steer' } }));
  assert.equal(d.state, 'running');
  assert.equal(d.stateSource, 'active_run');
  assert.equal(d.runId, 'run-o1');
  assert.equal(d.statusRun, 'running');
  assert.equal(d.latestRunId, 'run-o4');
  assert.equal(d.latestRunStatus, 'cancelled');
  assert.match(d.note, /still active/);
  assert.deepEqual(d.activeRun, { runId: 'run-o1', ordinal: 1, status: 'running', model: { model: 'claude-opus-5-5', instanceId: 'claudeAgent_pessoal', effort: 'high' } });
  // O snapshot limitado não trazia o run 4: o último run vem da shell, sem ordinal inventado.
  assert.deepEqual(d.latestRun, { runId: 'run-o4', ordinal: null, status: 'cancelled' });
});

test('t3_threads, t3_projetos e t3_atencao não tratam a thread do steer como cancelada', async () => {
  const c = await conectarMcp(ambientesFalsos(dadosReais()));
  const canceladas = dados(await c.callTool({ name: 't3_threads', arguments: { state: 'cancelled' } }));
  assert.ok(!canceladas.threads.some((t) => t.threadId === 't-steer'));
  const rodando = dados(await c.callTool({ name: 't3_threads', arguments: { state: 'running' } }));
  const steer = rodando.threads.find((t) => t.threadId === 't-steer');
  assert.equal(steer.stateSource, 'active_run');
  assert.equal(steer.latestRunStatus, 'cancelled');
  const projetos = dados(await c.callTool({ name: 't3_projetos', arguments: {} }));
  assert.equal(projetos.projects.find((p) => p.projectId === LOCAL.projeto).runningThreads, 2);
  const atencao = dados(await c.callTool({ name: 't3_atencao', arguments: {} }));
  assert.ok(!atencao.threads.some((t) => t.threadId === 't-steer'));
});

test('t3_thread: modelo da thread e do run ativo são canônicos; providerSession.model é informativo', async () => {
  const c = await conectarMcp(ambientesFalsos(dadosReais()));
  const d = dados(await c.callTool({ name: 't3_thread', arguments: { threadId: 't-modelo' } }));
  assert.equal(d.model.model, 'claude-opus-5-5');
  assert.equal(d.activeRun.model.model, 'claude-opus-5-5');
  // Sessão escolhida como o T3 escolhe: a da instância da thread, não a mais recente de outra.
  assert.equal(d.providerSession.model, 'claude-fable-5-1');
  assert.equal(d.providerSession.status, 'ready');
  assert.equal(d.providerSession.informational, true);
  assert.match(d.providerSession.note, /still reports claude-fable-5-1; the thread uses claude-opus-5-5/);
  assert.equal(d.state, 'running', 'sessão ready não muda o estado');
  assert.equal('latestRunStatus' in d, false);
});

test('t3_thread: sem divergência de modelo, a sessão não traz nota', async () => {
  const c = await conectarMcp(ambientesFalsos(dadosReais()));
  const d = dados(await c.callTool({ name: 't3_thread', arguments: { threadId: 't-steer' } }));
  assert.equal(d.providerSession.model, 'claude-opus-5-5');
  assert.equal('note' in d.providerSession, false);
});

test('descrições das ferramentas declaram a precedência e o que é só informativo', async () => {
  const c = await conectarMcp(ambientesFalsos());
  const { tools } = await c.listTools();
  const desc = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  for (const nome of ['t3_threads', 't3_buscar_threads', 't3_atencao', 't3_thread']) {
    assert.match(desc[nome], /`state` is canonical/, nome);
    assert.match(desc[nome], /a run still active → running/, nome);
    assert.match(desc[nome], /does not mean the thread stopped/, nome);
  }
  assert.match(desc.t3_thread, /`providerSession` \(status, model\) is the provider process as last reported and is informational only/);
  assert.match(desc.t3_thread, /`activeRun.model` is what the active run executes/);
  assert.match(desc.t3_aguardar_thread, /follows the run the thread is executing/);
});
