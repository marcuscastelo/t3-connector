// Inbox actions applied to several threads in one call (t3_thread_inbox_update_batch). Each item
// still goes through the existing Dispatcher with its own operationId (journal reservation, scope
// checks, uncertainty handling); this module only adds what a batch needs on top of it:
//
// - admission: strict, homogeneous batch (one action per call); a repeated key, target or
//   operationId rejects the whole call before anything is reserved or sent;
// - a durable manifest per (caller, batchId), reserved in the same journal before the first item,
//   so repeating a batchId never sends again: it returns what was recorded (recovery, not resume);
// - best-effort over independent items, sequentially; an uncertain send, a journal failure, a
//   closed session, the deadline or a cancellation stop the batch and the rest stay not_started.
//
// There is no transaction across threads and no noop shortcut: every admitted item is dispatched.

import { digest } from './gate.mjs';

// Public action name -> internal action ID (grant and journal keep the internal one).
export const INBOX_ACTIONS = Object.freeze({ snooze: 'thread.snooze', unsnooze: 'thread.unsnooze' });
export const MAX_ITENS = 20;
export const PRAZO_LOTE_MS = 20000;

export class LoteInvalido extends Error {
  constructor(code, detail) { super(code); this.detail = detail; }
}

// The underlying thread.snooze schema accepts only UTC (`Z`) instants. An explicit offset is
// converted to the same instant in UTC before the hash, the journal and the send.
const INSTANTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
function instanteUtc(valor, key) {
  const ms = INSTANTE.test(valor) ? Date.parse(valor) : NaN;
  if (Number.isNaN(ms)) throw new LoteInvalido('snoozed_until_invalid', key);
  return new Date(ms).toISOString();
}

/**
 * Validates and normalizes the call. `resolver(environment)` returns the configured record
 * ({alias, environmentId, destination}) or throws; an unknown environment is an item result,
 * not an admission failure.
 */
export function admitirLote({ batchId, action, items }, resolver) {
  const interna = INBOX_ACTIONS[action];
  if (!interna) throw new LoteInvalido('action_unavailable');
  if (!items?.length || items.length > MAX_ITENS) throw new LoteInvalido('batch_size_invalid');
  const chaves = new Set(), alvos = new Set(), operacoes = new Set();
  const itens = items.map((item) => {
    if (chaves.has(item.key)) throw new LoteInvalido('duplicate_key', item.key);
    chaves.add(item.key);
    if (operacoes.has(item.operationId)) throw new LoteInvalido('duplicate_operation_id', item.key);
    operacoes.add(item.operationId);
    if (action === 'snooze' && item.snoozedUntil === undefined) throw new LoteInvalido('snoozed_until_required', item.key);
    if (action !== 'snooze' && item.snoozedUntil !== undefined) throw new LoteInvalido('snoozed_until_not_allowed', item.key);
    let env = null;
    try { env = resolver(item.environment); } catch {}
    // Same thread twice (even through alias and environmentId) is refused, even with equal values.
    const alvo = JSON.stringify([env?.environmentId ?? item.environment, item.threadId]);
    if (alvos.has(alvo)) throw new LoteInvalido('duplicate_target', item.key);
    alvos.add(alvo);
    return {
      key: item.key,
      environment: item.environment,
      env: env && { alias: env.alias, environmentId: env.environmentId, destination: env.destination },
      threadId: item.threadId,
      expectedProjectId: item.expectedProjectId,
      operationId: item.operationId,
      ...(action === 'snooze' ? { snoozedUntil: instanteUtc(item.snoozedUntil, item.key) } : {}),
    };
  });
  // Order-independent: the same items in another order are the same batch.
  const normalizado = [...itens].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((i) => [i.key, i.env?.environmentId ?? i.environment, i.threadId, i.expectedProjectId, i.operationId, i.snoozedUntil ?? null]);
  return { batchId, action, interna, itens, hash: digest(['inbox-batch-v1', action, normalizado]) };
}

export const chaveManifesto = (caller, batchId) => digest(['inbox-batch-v1', caller, batchId]);

// Journal state of an operation -> item status (what is known about that operationId).
const DO_JOURNAL = { completed: 'applied', failed: 'failed', rejected: 'rejected', preparing: 'uncertain', uncertain: 'uncertain' };

/** Item result for an operation already in the journal (singular call, earlier batch or crash). */
export function itemDoJournal(record) {
  const original = DO_JOURNAL[record.state] ?? 'uncertain';
  return {
    status: 'replayed',
    originalStatus: original,
    ...(record.receipt ? { receipt: record.receipt } : {}),
    ...(original === 'uncertain' ? { reconciliationRequired: true } : {}),
  };
}

const PARADAS = new Set(['uncertain_send', 'session_closed', 'journal_failed']);

/**
 * Runs an admitted batch. Hooks (all required):
 * - `store(method, ...args)`: journal access that fails closed (throws journal_failed);
 * - `autorizar()`: throws when the session cannot write any more (checked before reserving);
 * - `autorizarReplay(itens)`: throws when the session may not see the recorded results;
 * - `executar(item)`: dispatches one item, returns `{result, stop?}` and never throws;
 * - `observar(item)`: journal record of the item's operationId, or undefined;
 * - `erro(code)`: public `{code, message}` of an item error.
 */
// Resultados por chave do item: a chave vem do cliente, então nunca indexa um objeto comum
// (`__proto__` trocaria o protótipo e sumiria do JSON; `constructor` seria herdado). Em memória é
// um Map; no manifesto, uma lista de pares [key, result]. Manifesto antigo em objeto: só as
// próprias chaves (revisão 334a1840, P2).
const gravadosDe = (results) => (Array.isArray(results) ? new Map(results) : new Map(Object.entries(results ?? {})));

export async function executarLote(lote, { caller, store, autorizar, autorizarReplay, executar, observar, erro, prazoMs = PRAZO_LOTE_MS, signal }) {
  const key = chaveManifesto(caller, lote.batchId);
  autorizar();
  const owned = store('reserve', key, { hash: lote.hash, action: lote.action, state: 'running', results: [] });
  if (!owned) {
    const old = store('get', key);
    if (!old) throw new Error('journal_failed');
    if (old.hash !== lote.hash) throw new LoteInvalido('batch_conflict');
    autorizarReplay(lote.itens);
    const gravados = gravadosDe(old.results);
    const itens = lote.itens.map((item) => {
      const gravado = gravados.get(item.key);
      if (gravado) return { item, result: gravado.status === 'not_started' ? gravado : replay(gravado) };
      const record = observar(item);
      return { item, result: record ? itemDoJournal(record) : { status: 'not_started' } };
    });
    return envelope(lote, itens, { replay: true, inProgress: old.state === 'running', stopped: old.stopped });
  }

  const prazo = Date.now() + prazoMs;
  const results = new Map();
  let stopped = null;
  for (const item of lote.itens) {
    if (stopped) {
      results.set(item.key, { status: 'not_started', error: erro('batch_stopped') });
      continue;
    }
    if (signal?.aborted || Date.now() > prazo) {
      stopped = { reason: signal?.aborted ? 'cancelled' : 'deadline', key: item.key };
      results.set(item.key, { status: 'not_started', error: erro('batch_stopped') });
      continue;
    }
    const { result, stop } = await executar(item);
    results.set(item.key, result);
    if (stop && PARADAS.has(stop)) stopped = { reason: stop, key: item.key };
    // Each item is recorded before the next one is attempted: a crash leaves a partial manifest.
    store('put', key, { hash: lote.hash, action: lote.action, state: 'running', results: [...results], ...(stopped ? { stopped } : {}) });
  }
  store('put', key, { hash: lote.hash, action: lote.action, state: 'finished', results: [...results], ...(stopped ? { stopped } : {}) });
  return envelope(lote, lote.itens.map((item) => ({ item, result: results.get(item.key) })), { replay: false, stopped });
}

function replay(gravado) {
  if (gravado.status === 'replayed') return gravado;
  const { status, ...resto } = gravado;
  return { status: 'replayed', originalStatus: status, ...resto };
}

const STATUS = ['applied', 'rejected', 'failed', 'uncertain', 'not_started', 'replayed'];
const efetivo = (r) => (r.status === 'replayed' ? r.originalStatus : r.status);

function envelope(lote, itens, { replay: repetido, inProgress = false, stopped }) {
  const summary = Object.fromEntries(STATUS.map((s) => [s, 0]));
  const items = itens.map(({ item, result }) => {
    summary[result.status]++;
    return {
      key: item.key,
      environment: item.env ? { alias: item.env.alias, environmentId: item.env.environmentId } : null,
      threadId: item.threadId,
      operationId: item.operationId,
      ...result,
    };
  });
  return {
    batchId: lote.batchId,
    action: lote.action,
    replay: repetido,
    ...(inProgress ? { inProgress: true } : {}),
    // complete: every item has a known outcome (rejections included); allSucceeded: every item applied.
    complete: !inProgress && items.every((r) => !['uncertain', 'not_started'].includes(efetivo(r))),
    allSucceeded: items.every((r) => efetivo(r) === 'applied'),
    ...(stopped ? { stopped } : {}),
    returned: items.length,
    summary,
    items,
  };
}
