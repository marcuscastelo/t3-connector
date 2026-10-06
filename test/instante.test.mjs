// Instante ISO estrito: data impossível não prova versão (revisão 737d9be, P1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { msIso } from '../src/instante.mjs';
import { compararShell } from '../src/execucao.mjs';
import { lerObservacao, avaliarGuard } from '../src/settlement.mjs';
import { mensagem, projecao, thread } from './fixtures.mjs';

test('msIso: aceita o formato do T3 com Z ou offset; recusa calendário impossível e formatos soltos', () => {
  assert.equal(msIso('2026-10-03T10:05:00.000Z'), Date.parse('2026-10-03T10:05:00.000Z'));
  assert.equal(msIso('2026-10-03T07:05:00-03:00'), Date.parse('2026-10-03T10:05:00Z'));
  assert.equal(msIso('2024-02-29T00:00:00Z'), Date.parse('2024-02-29T00:00:00Z'));
  for (const ruim of ['2026-02-30T07:05:00-03:00', '2025-02-29T00:00:00Z', '2026-13-01T00:00:00Z', '2026-04-31T00:00:00Z', '2026-10-03T24:00:00Z',
    '2026-10-03T10:60:00Z', '2026-10-03T10:05:60Z', '2026-10-03T10:05:00+15:00', '2026-10-03', '2026-10-03T10:05:00', 'Mon, 03 Oct 2026 10:05:00 GMT', '', null, undefined, 1700000000000]) {
    assert.equal(msIso(ruim), null, String(ruim));
  }
  // Fração além do milissegundo é preservada: instantes diferentes não comparam iguais.
  assert.notEqual(msIso('2026-10-03T10:05:00.0001Z'), msIso('2026-10-03T10:05:00.0002Z'));
});

test('versão com data impossível nunca é comprovada: compararShell e settlement recusam', async () => {
  const proj = (updatedAt) => ({ ...projecao({ runs: [{ id: 'run-1', ordinal: 1, status: 'completed' }], mensagens: [mensagem()] }), thread: { id: 'thread-1' }, providerThreads: [], updatedAt });
  for (const [s, p] of [['2026-02-30T07:05:00-03:00', '2026-02-30T07:05:00-03:00'], ['2026-02-30T07:05:00-03:00', '2026-03-02T07:05:00-03:00']]) {
    const c = compararShell(thread({ updatedAt: s }), proj(p));
    assert.equal(c.mesmaVersao, false, `${s} / ${p}`);
    assert.ok(c.motivos.some((m) => m.code === 'thread_version_unproven'));
    const o = await lerObservacao({ environmentId: 'e', threadId: 'thread-1', version: 2, lerShell: async () => ({ threads: [thread({ updatedAt: s })] }), lerCompleto: async () => ({ snapshotSequence: 3, projection: proj(p) }) });
    assert.equal(o.complete, false);
    assert.equal(avaliarGuard({ version: 2, expectedRunId: 'run-1', expectedObservationId: 'x', acceptance: { accepted: true, evidenceRef: 'r' } }, o), 'settle_observation_incomplete');
  }
});
