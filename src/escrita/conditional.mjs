// Conditional send: "when run R has ended, apply this model selection, then send this
// instruction", as one write with explicit preconditions.
//
// No new mutation path. Each step goes through the host's existing dispatch (Dispatcher:
// journal reservation, scope/workspace checks, final synchronous gate check, stable commandId,
// uncertainty fail-closed) under a step operationId derived from clientRequestId, so a retry
// replays each step's own receipt and never sends twice. This module only adds:
// - the precondition, evaluated from the thread shell before the first step and again right
//   before the send (a run started by anyone in between refuses the send instead of letting T3
//   queue it);
// - a manifest in the same journal (its own key prefix) with every observation and step, so the
//   result is auditable and a retry with the same clientRequestId replays it.
//
// Outcomes are explicit, never a fallback:
//   precondition_pending  run R still active; nothing sent; same clientRequestId re-evaluates.
//   precondition_failed   R is no longer the thread's latest run, another run is active, or R is
//                         unknown; nothing sent; terminal (a new run needs a new request).
//   failed                a step was refused before sending; earlier steps stay applied and are
//                         listed; terminal.
//   uncertain             a step was sent without a confirmed result; reconcile that step's
//                         operationId; never resent.
//   completed             every step completed; `delivery` says whether T3 started the run or
//                         queued it (a run that appeared after the last check), with the run's model.
import { z } from 'zod';
import { digest } from './gate.mjs';
import { chaveOperacao } from './adapters.mjs';
import { runAtivoDaShell } from '../estado.mjs';

export const CONDITIONAL_SEND = 'thread.conditional-send';
export const CONDITIONAL_TOOL = 't3_escrever_thread_conditional_send';
export const MAX_WAIT_MS = 10000;
const POLL_MS = 500, CONFIRM_MS = 2000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back']);
const FINAL = new Set(['precondition_failed', 'failed', 'uncertain', 'completed']);

const str = z.string().trim().min(1).max(1024);
const modelSelection = z.object({
  instanceId: str.describe('Exact provider instance ID (t3_providers instanceId).'),
  model: str.describe('Exact model ID of that instance (t3_providers models[].slug).'),
  options: z.array(z.object({ id: str, value: z.union([z.string(), z.boolean()]) }).strict()).optional()
    .describe('Model options as listed by t3_providers optionDescriptors, e.g. fast mode.'),
}).strict();
export const CONDITIONAL_DESCRIPTION = 'Conditional send: once the run `afterRunId` has ended and no other run started, optionally applies `modelSelection` to the thread (thread.model-selection.set) and then sends `text` as a new run (thread.send start_immediately), as one request with one clientRequestId. The precondition is checked before the first step and again right before the send; if any run became active in between nothing is sent, so T3 never turns it into a queued message silently. Each step is journaled under `<clientRequestId>:model-selection` and `<clientRequestId>:send` and can be reconciled with t3_reconciliar_escrita. Retrying with the same clientRequestId and input replays the recorded result; only `precondition_pending` (nothing sent) is re-evaluated. Results: precondition_pending, precondition_failed, failed (a step was refused before sending; earlier steps remain applied and are listed), uncertain (reconcile; do not retry), completed (with `delivery`). No fallback to queue_after_active, steer or another provider.';
export const conditionalSchema = z.object({
  threadId: str,
  clientRequestId: str.describe('Idempotency key of the whole conditional send; must equal operationId.'),
  afterRunId: str.describe('Run that must have ended (the active run read from t3_thread). The send happens only if this run is terminal, is still the thread\'s latest run and no run is active.'),
  modelSelection: modelSelection.optional().describe('Applied to the thread before the send. Omitted: the thread keeps its model.'),
  text: z.string().min(1).max(100000),
  waitMs: z.number().int().min(0).max(MAX_WAIT_MS).optional().describe(`How long this call may wait for afterRunId to end (0..${MAX_WAIT_MS}, default 0). On timeout the result is precondition_pending and nothing is sent.`),
}).strict().describe(CONDITIONAL_DESCRIPTION);

export const stepIds = clientRequestId => ({ model: `${clientRequestId}:model-selection`, send: `${clientRequestId}:send` });
export const requiredActions = input => [...(input.modelSelection ? ['thread.model-selection.set'] : []), 'thread.send'];
export const manifestKey = ({ environmentId, destination, caller, clientRequestId }) => digest(['conditional-send-v1', environmentId, destination, caller, clientRequestId]);

// Model selections compare by value; option order is not meaningful.
const canonicalModel = m => m ? { instanceId: m.instanceId ?? null, model: m.model, options: [...(m.options ?? [])].map(o => [o.id, o.value]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) } : null;
export const sameModel = (a, b) => JSON.stringify(canonicalModel(a)) === JSON.stringify(canonicalModel(b));

/** Precondition from the thread shell: met, pending (R still active) or failed (with reason). */
export function evaluatePrecondition(thread, afterRunId) {
  const active = runAtivoDaShell(thread);
  const observation = { latestRunId: thread.latestRunId ?? null, latestRunStatus: thread.status ?? null, activeRunId: active?.runId ?? null, activeRunStatus: active?.status ?? null, pendingRuntimeRequest: thread.pendingRuntimeRequest?.id ?? null };
  if (active) {
    // `waiting` behind another run has no runId in the shell: that is not R running.
    if (active.runId === afterRunId) return { verdict: 'pending', reason: 'run_active', observation };
    return { verdict: 'failed', reason: 'other_run_active', observation };
  }
  if (thread.latestRunId !== afterRunId) return { verdict: 'failed', reason: thread.latestRunId ? 'run_superseded' : 'run_unknown', observation };
  if (!TERMINAL.has(thread.status)) return { verdict: 'failed', reason: 'run_state_unknown', observation };
  return { verdict: 'met', reason: 'run_ended', observation };
}

const inflight = new Map();

/**
 * @param host.caller          canonical caller identity (journal key)
 * @param host.environment     {environmentId, destination}
 * @param host.journal         same atomic journal as the Dispatcher
 * @param host.authorize(actions)  throws unless the caller may run these actions now
 * @param host.observe(threadId)   shell thread (authorized), throws thread_not_found
 * @param host.readThread(threadId) full projection {runs, ...} for the post-check (optional)
 * @param host.dispatch(action, operationId, input)  the existing dispatch path
 * @param host.audit(event)
 * @param host.failClosed()  called when the journal fails
 */
export function conditionalSend(host, operationId, rawInput, { sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
  const input = conditionalSchema.parse(rawInput);
  if (input.clientRequestId !== operationId) throw new Error('request_id_mismatch');
  const key = manifestKey({ ...host.environment, caller: host.caller, clientRequestId: input.clientRequestId });
  // Concurrent duplicates in this process share one execution and one result.
  if (inflight.has(key)) return inflight.get(key);
  const running = run(host, key, input, { sleep, now }).finally(() => inflight.delete(key));
  inflight.set(key, running);
  return running;
}

async function run(host, key, input, { sleep, now }) {
  host.authorize(requiredActions(input));
  const hash = digest([CONDITIONAL_SEND, input]);
  // A journal failure fails closed like the Dispatcher's: the host ends its leases/sessions.
  const store = (method, ...args) => { try { return host.journal[method](...args); } catch { host.failClosed(); throw new Error('journal_failed'); } };
  const at = () => new Date(now()).toISOString();
  const ids = stepIds(input.clientRequestId);
  let record = { kind: CONDITIONAL_SEND, hash, operationId: input.clientRequestId, threadId: input.threadId, afterRunId: input.afterRunId, state: 'evaluating', attempts: 0, observations: [], steps: [] };
  if (!store('reserve', key, record)) {
    const old = store('get', key);
    if (old.hash !== hash) throw new Error('operation_conflict');
    if (FINAL.has(old.state)) return view(old, true);
    record = old; // pending, or interrupted mid-way: steps are idempotent by their own operationIds
  }
  record.attempts++;
  const save = () => store('put', key, record);
  const finish = (state, extra = {}) => {
    Object.assign(record, { state, finishedAt: at(), ...extra });
    save();
    host.audit({ event: 'conditional_send', operationId: input.clientRequestId, threadId: input.threadId, state, ...(extra.reason ? { reason: extra.reason } : {}), steps: record.steps.map(s => ({ action: s.action, operationId: s.operationId, state: s.state })) });
    return view(record, false);
  };
  const observe = async phase => {
    const thread = await host.observe(input.threadId);
    const evaluation = evaluatePrecondition(thread, input.afterRunId);
    const entry = { phase, at: at(), verdict: evaluation.verdict, reason: evaluation.reason, ...evaluation.observation, model: thread.modelSelection ?? null };
    record.observations.push(entry);
    if (record.observations.length > 20) record.observations.splice(1, record.observations.length - 20);
    return { thread, evaluation };
  };
  const step = async (action, operationId, stepInput) => {
    const done = record.steps.find(s => s.operationId === operationId && s.state === 'completed');
    if (done) return done;
    const entry = { action, operationId, startedAt: at() };
    try {
      const result = await host.dispatch(action, operationId, stepInput);
      // A replayed record that is not completed is an earlier attempt's outcome, not a new send.
      entry.state = result.state === 'completed' ? 'completed' : result.state === 'rejected' ? 'rejected' : 'uncertain';
      if (result.receipt) entry.receipt = result.receipt;
    } catch (error) {
      entry.state = error.message === 'reconciliation_required' ? 'uncertain' : 'rejected';
      entry.error = /^[a-z_]+$/.test(error.message) ? error.message : 'dispatch_rejected';
    }
    entry.finishedAt = at();
    record.steps = [...record.steps.filter(s => s.operationId !== operationId), entry];
    save();
    return entry;
  };

  // 1. Precondition, waiting up to waitMs for R to end. Nothing is sent while it is not met.
  if (!record.steps.length) {
    const deadline = now() + (input.waitMs ?? 0);
    let o = await observe('before_first_step');
    while (o.evaluation.verdict === 'pending' && now() + POLL_MS <= deadline) {
      await sleep(POLL_MS);
      o = await observe('waiting');
    }
    if (o.evaluation.verdict === 'pending') {
      record.state = 'precondition_pending';
      save();
      return view(record, false);
    }
    if (o.evaluation.verdict === 'failed') return finish('precondition_failed', { reason: o.evaluation.reason });
  }
  record.state = 'executing';
  save();

  // 2. Model selection through the existing write action.
  if (input.modelSelection) {
    const s = await step('thread.model-selection.set', ids.model, { threadId: input.threadId, modelSelection: input.modelSelection });
    if (s.state === 'uncertain') return finish('uncertain', { failedStep: s.action, reason: 'reconciliation_required' });
    if (s.state !== 'completed') return finish('failed', { failedStep: s.action, reason: s.error ?? 'step_rejected' });
  }

  // 3. Last check before the send: the run must still be the ended one, nothing active, and the
  //    thread must show the requested model (bounded wait for the projection to catch up).
  const sendDone = record.steps.find(s => s.operationId === ids.send);
  if (!sendDone) {
    const deadline = now() + CONFIRM_MS;
    let o = await observe('before_send');
    while (o.evaluation.verdict === 'met' && input.modelSelection && !sameModel(o.thread.modelSelection, input.modelSelection) && now() + POLL_MS / 2 <= deadline) {
      await sleep(POLL_MS / 2);
      o = await observe('before_send');
    }
    if (o.evaluation.verdict !== 'met') return finish('failed', { failedStep: 'thread.send', reason: `precondition_${o.evaluation.reason}`, sent: false });
    if (input.modelSelection && !sameModel(o.thread.modelSelection, input.modelSelection)) return finish('failed', { failedStep: 'thread.send', reason: 'model_selection_not_applied', sent: false });
  }

  // 4. The send, as start_immediately: never queue_after_active, steer or restart.
  const s = await step('thread.send', ids.send, { threadId: input.threadId, clientRequestId: ids.send, text: input.text, delivery: 'start_immediately' });
  if (s.state === 'uncertain') return finish('uncertain', { failedStep: s.action, reason: 'reconciliation_required' });
  if (s.state !== 'completed') return finish('failed', { failedStep: s.action, reason: s.error ?? 'step_rejected', sent: false });
  return finish('completed', { delivery: await postCheck(host, input, ids.send) });
}

// What T3 did with the message: the run whose userMessageId is the send's stable messageId.
// A run started by another client after the last check makes T3 queue it: reported, not hidden.
async function postCheck(host, input, sendOperationId) {
  try {
    const step = host.journal.get(chaveOperacao({ ...host.environment, caller: host.caller, operationId: sendOperationId }));
    const messageId = step?.payloadIds?.messageId;
    if (!messageId || !host.readThread) return { observed: false };
    const projection = await host.readThread(input.threadId);
    const r = (projection?.runs ?? []).find(x => x.userMessageId === messageId);
    if (!r) return { observed: false, messageId };
    return {
      observed: true, messageId, runId: r.id, runStatus: r.status,
      deliveredAs: r.status === 'queued' ? 'queued_behind_active' : 'started',
      ...(input.modelSelection ? { runModelMatches: sameModel(r.modelSelection, input.modelSelection) } : {}),
    };
  } catch { return { observed: false }; }
}

function view(record, replayed) {
  const { hash, ...rest } = record;
  const nextAction = {
    precondition_pending: 'afterRunId is still active and nothing was sent: wait (t3_aguardar_thread) and retry with the same clientRequestId',
    precondition_failed: 'nothing was sent: read t3_thread and decide again with a new clientRequestId',
    failed: 'the failed step was not sent; steps listed as completed remain applied',
    uncertain: 'do not retry: reconcile the failed step operationId with t3_reconciliar_escrita',
  }[record.state];
  return { ...rest, replayed, ...(nextAction ? { nextAction } : {}) };
}
