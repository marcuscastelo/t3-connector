// Revisão 334a1840 (P2): chaves de item como `__proto__` ou `constructor` não podem perder nem
// herdar resultados no manifesto do batch (journal serializado em JSON) nem no replay.

import test from 'node:test';
import assert from 'node:assert/strict';
import { admitirLote, executarLote } from '../src/escrita/lote-inbox.mjs';

const RESERVADAS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
const resolver = (e) => ({ alias: e, environmentId: `env-${e}`, destination: `t3://env-${e}` });
const lote = (keys) => admitirLote({ batchId: 'b-1', action: 'unsnooze', items: keys.map((k, i) => ({ key: k, environment: 'local', threadId: `t-${i}`, expectedProjectId: 'p', operationId: `op-${i}` })) }, resolver);

function journalJson() {
  // Como o FileJournal: grava e lê JSON, nunca a referência.
  const m = new Map();
  return (metodo, k, v) => {
    if (metodo === 'reserve') { if (m.has(k)) return false; m.set(k, JSON.stringify(v)); return true; }
    if (metodo === 'get') return m.has(k) ? JSON.parse(m.get(k)) : undefined;
    if (metodo === 'put') { m.set(k, JSON.stringify(v)); return true; }
    throw new Error(metodo);
  };
}
const hooks = (store, executar) => ({
  caller: 'c', store, autorizar() {}, autorizarReplay() {}, executar, observar: () => undefined,
  erro: (code) => ({ code, message: code }),
});

test('batch: chaves reservadas guardam e repetem o próprio resultado após serializar', async () => {
  const store = journalJson();
  let n = 0;
  const executar = async (item) => ({ result: { status: 'applied', receipt: { sequence: ++n, key: item.key } } });
  const primeiro = await executarLote(lote(RESERVADAS), hooks(store, executar));
  assert.deepEqual(primeiro.items.map((i) => [i.key, i.status]), RESERVADAS.map((k) => [k, 'applied']));
  const replay = await executarLote(lote(RESERVADAS), hooks(store, async () => { throw new Error('nunca reenvia'); }));
  for (const [i, k] of RESERVADAS.entries()) {
    const item = replay.items.find((x) => x.key === k);
    assert.equal(item.status, 'replayed', k);
    assert.equal(item.originalStatus, 'applied', k);
    assert.deepEqual(item.receipt, { sequence: i + 1, key: k }, k);
  }
});

test('batch: chave reservada sem resultado gravado nunca herda do protótipo (queda no meio)', async () => {
  const store = journalJson();
  // Só o primeiro item foi gravado antes da queda.
  store('reserve', 'x', {});
  const itens = lote(['a', 'constructor', '__proto__']);
  const chave = (await import('../src/escrita/lote-inbox.mjs')).chaveManifesto('c', 'b-1');
  store('put', chave, { hash: itens.hash, action: itens.action, state: 'running', results: [['a', { status: 'applied', receipt: { sequence: 1 } }]] });
  const r = await executarLote(itens, hooks(store, async () => { throw new Error('nunca reenvia'); }));
  assert.deepEqual(r.items.map((i) => [i.key, i.status]), [['a', 'replayed'], ['constructor', 'not_started'], ['__proto__', 'not_started']]);
  assert.equal(r.inProgress, true);
});
