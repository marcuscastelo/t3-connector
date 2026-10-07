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
import { chaveOperacao, parseAction } from './adapters.mjs';
import { runAtivoDaShell } from '../estado.mjs';

export const CONDITIONAL_SEND = 'thread.conditional-send';
export const CONDITIONAL_TOOL = 't3_escrever_thread_conditional_send';
export const MAX_WAIT_MS = 10000;
const POLL_MS = 500, CONFIRM_MS = 2000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back']);
// Final answers are replayed (after re-reading the steps' journal). `uncertain` is not final: each
// call re-reads the steps and continues once they settle.
const FINAL = new Set(['precondition_failed', 'failed', 'completed']);

const str = z.string().trim().min(1).max(1024);
const modelSelection = z.object({
  instanceId: str.describe('Exact provider instance ID (t3_providers instanceId).'),
  model: str.describe('Exact model ID of that instance (t3_providers models[].slug).'),
  options: z.array(z.object({ id: str, value: z.union([z.string(), z.boolean()]) }).strict()).optional()
    .describe('Model options as listed by t3_providers optionDescriptors, e.g. fast mode.'),
}).strict();
export const CONDITIONAL_DESCRIPTION = 'Conditional send: once the run `afterRunId` has ended and no other run started, optionally applies `modelSelection` to the thread (thread.model-selection.set) and then sends `text` as a new run (thread.send start_immediately), as one request with one clientRequestId. The precondition is checked before the first step and again right before the send; if any run became active in between nothing is sent, so T3 never turns it into a queued message silently. Each step is journaled under `<clientRequestId>:model-selection` and `<clientRequestId>:send` and can be reconciled with t3_reconciliar_escrita. Retrying with the same clientRequestId and input never sends twice: step states are re-read from the write journal, precondition_pending and uncertain are evaluated again, final results are replayed. "Not sent" is stated only after the operationId of the step is durably reserved as refused, so no later write can send under it. Results: precondition_pending, precondition_failed, failed (a step was refused before sending; earlier steps remain applied and are listed), uncertain (the step in failedOperationId may have been or may still be sent: never resend under another id; reconcile it or retry the same clientRequestId), completed (with `delivery`). No fallback to queue_after_active, steer or another provider.';
export const conditionalSchema = z.object({
  threadId: str,
  // The step operationIds append ':model-selection' (the longest suffix) and must fit the 1024-character write ID.
  clientRequestId: z.string().trim().min(1).max(1024 - ':model-selection'.length).describe('Idempotency key of the whole conditional send; must equal operationId.'),
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
 * @param host.authorize(actions, projectId?)  throws unless the caller may run these actions now
 *                                   (and, with projectId, in that project)
 * @param host.observe(threadId)   shell thread (project authorized), throws thread_not_found
 * @param host.readThread(threadId) full projection {runs, ...} for the post-check (optional)
 * @param host.dispatch(action, operationId, input)  the existing dispatch path
 * @param host.audit(event)
 * @param host.failClosed()  called when the journal fails
 */
export async function conditionalSend(host, operationId, rawInput, { sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
  const input = conditionalSchema.parse(rawInput);
  if (input.clientRequestId !== operationId) throw new Error('request_id_mismatch');
  const key = manifestKey({ ...host.environment, caller: host.caller, clientRequestId: input.clientRequestId });
  const hash = digest([CONDITIONAL_SEND, input]);
  // Every call authorizes with its own lease/session before anything else, joined or not.
  host.authorize(requiredActions(input));
  // Concurrent duplicates in this process share one execution and one result; a different input
  // under the same clientRequestId is a conflict, as it is against the journal.
  const current = inflight.get(key);
  if (current) {
    if (current.hash !== hash) throw new Error('operation_conflict');
    return current.running.then(result => { host.authorize(requiredActions(input), result.projectId); return structuredClone(result); });
  }
  const running = run(host, key, input, hash, { sleep, now }).finally(() => inflight.delete(key));
  inflight.set(key, { hash, running });
  return running;
}

async function run(host, key, input, hash, { sleep, now }) {
  // A journal failure fails closed like the Dispatcher's: the host ends its leases/sessions.
  const store = (method, ...args) => { try { return host.journal[method](...args); } catch { host.failClosed(); throw new Error('journal_failed'); } };
  const at = () => new Date(now()).toISOString();
  const ids = stepIds(input.clientRequestId);
  const inputs = stepInputs(input, ids);
  // A step's state is what the Dispatcher journal holds for its operationId, never what this
  // manifest or a thrown error says: the Dispatcher commits before the manifest, and another
  // executor (another process, or a plain write under the same operationId) may own the step.
  const stepKey = i => chaveOperacao({ ...host.environment, caller: host.caller, operationId: i.operationId });
  const stepHash = i => digest([i.action, parseAction(i.action, i.stepInput).input]);
  const durable = i => {
    const d = store('get', stepKey(i));
    if (!d) return null;
    // Same rule as the Dispatcher: an operationId used for another input is a conflict.
    if (d.hash !== stepHash(i)) throw new Error('operation_conflict');
    return stepFromDispatcher(d, i.operationId, at());
  };
  // Journal truth over the recorded steps; a recorded refusal keeps its error code and detail.
  const reread = steps => inputs.flatMap(i => {
    const d = durable(i), recorded = steps.find(x => x.operationId === i.operationId);
    // A refusal is only what the journal holds: a recorded one without a record (older manifests)
    // is dropped, so it is closed atomically or rebuilt, never repeated as proof.
    if (!d) return recorded && recorded.state !== 'rejected' ? [recorded] : [];
    return [recorded && recorded.state === d.state ? { ...recorded, ...(d.receipt ? { receipt: d.receipt } : {}) } : d];
  });
  const sameStates = (a, b) => JSON.stringify(a.map(x => [x.operationId, x.state])) === JSON.stringify(b.map(x => [x.operationId, x.state]));

  let record = { kind: CONDITIONAL_SEND, hash, operationId: input.clientRequestId, threadId: input.threadId, afterRunId: input.afterRunId, state: 'evaluating', attempts: 0, observations: [], steps: [] };
  if (!store('reserve', key, record)) {
    const old = store('get', key);
    if (old.hash !== hash) throw new Error('operation_conflict');
    // A recorded request reveals its thread, observations and model: the caller's current lease or
    // session must still cover that thread's project, as the Dispatcher's replay re-checks its target.
    if (old.projectId !== undefined) host.authorize(requiredActions(input), old.projectId);
    else if (old.observations.length || old.steps.length) old.projectId = (await host.observe(input.threadId)).projectId;
    record = old; // final: replayed below; pending, uncertain or interrupted: continued from the journal
  }
  const replaying = FINAL.has(record.state);
  if (!replaying) record.attempts++;
  const save = () => store('put', key, record);
  const finish = (state, extra = {}) => {
    for (const k of ['reason', 'failedStep', 'failedOperationId', 'detail', 'sent']) delete record[k];
    Object.assign(record, { state, finishedAt: at(), ...extra });
    save();
    host.audit({ event: 'conditional_send', operationId: input.clientRequestId, threadId: input.threadId, state, ...(extra.reason ? { reason: extra.reason } : {}), steps: record.steps.map(s => ({ action: s.action, operationId: s.operationId, state: s.state })) });
    return view(record, false);
  };
  // Adopt the journal before any precondition, so a resumed request never decides a new send from
  // a shell that shows the request's own run. Nothing is returned before the project is authorized.
  const refresh = async () => {
    const steps = reread(record.steps);
    if (sameStates(steps, record.steps)) return;
    if (record.projectId === undefined) record.projectId = (await host.observe(input.threadId)).projectId;
    record.steps = steps;
    save();
  };
  // "Not sent" is said of a step only when its write-journal record is a refusal: the Dispatcher's
  // own (permanent: it never sends under a rejected record) or one this request reserves here.
  // The reservation is the journal's atomic INSERT OR IGNORE, the same one the Dispatcher uses to
  // own an operationId, so it excludes every other writer, in this process or another: if it wins,
  // no later write can send under that operationId; if it loses, another writer holds the step
  // and its state is read, never assumed.
  const closeStep = (i, reason) => {
    const refusal = { hash: stepHash(i), state: 'rejected', action: i.action, operationId: i.operationId, ...host.environment, closedBy: CONDITIONAL_SEND, reason };
    return store('reserve', stepKey(i), refusal)
      ? { action: i.action, operationId: i.operationId, state: 'rejected', error: reason, closed: true, finishedAt: at() }
      : durable(i) ?? { action: i.action, operationId: i.operationId, state: 'uncertain', reason: 'reconciliation_required', finishedAt: at() };
  };
  const close = (i, reason) => {
    const known = record.steps.find(x => x.operationId === i.operationId);
    if (known) return known;
    const entry = closeStep(i, reason);
    record.steps = [...record.steps, entry];
    return entry;
  };
  // Replay of a final answer, written by this engine or an earlier one. Its steps are re-read from
  // the journal (a refusal held only by the manifest is dropped); a negative answer is repeated
  // only after every step it did not complete is closed with the same atomic reservation as a
  // fresh conclusion. Any step whose state differs from the recorded answer, over the union of the
  // recorded and current steps, rebuilds the answer from the current steps alone.
  const replayFinal = () => {
    const recorded = new Map(record.steps.map(x => [x.operationId, x.state]));
    const steps = reread(record.steps), closedNow = new Set();
    if (record.state !== 'completed') for (const i of inputs) {
      if (steps.some(x => x.operationId === i.operationId)) continue;
      const entry = closeStep(i, record.reason ?? record.state);
      if (entry.closed) closedNow.add(i.operationId);
      steps.push(entry);
    }
    const current = new Map(steps.map(x => [x.operationId, x.state]));
    const changed = [...new Set([...recorded.keys(), ...current.keys()])].filter(op => !closedNow.has(op) && recorded.get(op) !== current.get(op));
    const send = current.get(ids.send);
    const holds = !changed.length && !steps.some(x => x.state === 'uncertain') && (record.state === 'completed' ? send === 'completed' : send === 'rejected' || (send === 'completed' && record.sent === true));
    if (holds) {
      if (closedNow.size) {
        record.steps = inputs.map(i => steps.find(x => x.operationId === i.operationId)).filter(Boolean);
        save();
        host.audit({ event: 'conditional_send_closed', operationId: input.clientRequestId, threadId: input.threadId, steps: [...closedNow] });
      }
      return view(record, true);
    }
    const { kind, operationId, threadId, afterRunId, projectId, attempts, observations } = record;
    const failedOperationId = changed[0] ?? steps.find(x => x.state === 'uncertain')?.operationId ?? ids.send;
    return view({ kind, operationId, threadId, afterRunId, projectId, attempts, observations, steps, state: 'uncertain', reason: 'step_changed_after_result', failedOperationId }, true);
  };
  // Every answer is built from the current steps. A negative one (`state`/`extra`) is given only
  // when the send step is durably refused and nothing is unsettled.
  const answer = async (state, extra) => {
    const unsettled = record.steps.find(x => x.state === 'uncertain');
    if (unsettled) return finish('uncertain', { failedStep: unsettled.action, failedOperationId: unsettled.operationId, reason: unsettled.reason ?? 'reconciliation_required' });
    const send = record.steps.find(x => x.operationId === ids.send);
    if (send?.state === 'completed') {
      const refused = record.steps.find(x => x.state === 'rejected');
      if (!refused) return finish('completed', { delivery: await postCheck(host, input, ids.send) });
      return finish('failed', { failedStep: refused.action, failedOperationId: refused.operationId, reason: refused.error ?? 'step_rejected', sent: true });
    }
    if (send?.state !== 'rejected') throw new Error('conditional_send_invariant');
    return finish(state, extra);
  };
  // Conclude that nothing (more) is sent: close every step not yet held, then answer from the steps.
  const conclude = async (state, extra, reason = extra.reason) => {
    await refresh();
    for (const i of inputs) close(i, reason);
    save();
    return answer(state, extra);
  };
  const stopAt = x => x.state === 'uncertain' ? answer()
    : conclude('failed', { failedStep: x.action, failedOperationId: x.operationId, reason: x.error ?? 'step_rejected', ...(x.detail ? { detail: x.detail } : {}), sent: false }, 'previous_step_refused');
  const observe = async phase => {
    const thread = await host.observe(input.threadId);
    record.projectId ??= thread.projectId;
    const evaluation = evaluatePrecondition(thread, input.afterRunId);
    const entry = { phase, at: at(), verdict: evaluation.verdict, reason: evaluation.reason, ...evaluation.observation, model: thread.modelSelection ?? null };
    record.observations.push(entry);
    if (record.observations.length > 20) record.observations.splice(1, record.observations.length - 20);
    return { thread, evaluation };
  };
  const step = async (i) => {
    // A step the journal already holds is never dispatched again: its state is re-read instead.
    const known = record.steps.find(s => s.operationId === i.operationId);
    if (known) return known;
    const entry = { action: i.action, operationId: i.operationId, startedAt: at() };
    let error = null, result = null;
    try { result = await host.dispatch(i.action, i.operationId, i.stepInput); } catch (e) { error = e; }
    const d = durable(i);
    if (d) Object.assign(entry, d, { startedAt: entry.startedAt });
    // A refusal that left no journal record (lease, scope, conflict, journal) refuses this call; it
    // proves nothing about the step, which another writer may still own. Nothing is concluded.
    else if (error) throw error;
    // No journal record but an answer: its own state, and never "not sent" without a record.
    else Object.assign(entry, { state: result?.state === 'completed' ? 'completed' : 'uncertain' }, result?.receipt ? { receipt: result.receipt } : {});
    if (error && entry.state === 'rejected') {
      entry.error = /^[a-z_]+$/.test(error.message) ? error.message : 'dispatch_rejected';
      // A typed refusal (e.g. an unsupported modelSelection) keeps its exact message.
      if (error.native?.code === entry.error && typeof error.native.message === 'string') entry.detail = error.native.message;
    }
    entry.finishedAt = at();
    record.steps = [...record.steps.filter(s => s.operationId !== i.operationId), entry];
    save();
    return entry;
  };

  if (replaying) return replayFinal();
  await refresh();
  // 1. Precondition, waiting up to waitMs for R to end. Nothing is sent while it is not met.
  if (!record.steps.length) {
    const deadline = now() + (input.waitMs ?? 0);
    let o = await observe('before_first_step');
    while (o.evaluation.verdict === 'pending' && now() + POLL_MS <= deadline) {
      await sleep(POLL_MS);
      o = await observe('waiting');
    }
    if (o.evaluation.verdict === 'pending') {
      await refresh();
      if (!record.steps.length) {
        record.state = 'precondition_pending';
        save();
        return view(record, false);
      }
    } else if (o.evaluation.verdict === 'failed') {
      return conclude('precondition_failed', { reason: o.evaluation.reason });
    }
  }
  record.state = 'executing';
  save();

  // 2. Model selection through the existing write action.
  if (input.modelSelection) {
    const s = await step(inputs[0]);
    if (s.state !== 'completed') return stopAt(s);
  }

  // 3. Last check before the send: the run must still be the ended one, nothing active, and the
  //    thread must show the requested model (bounded wait for the projection to catch up).
  if (!record.steps.some(s => s.operationId === ids.send)) {
    const deadline = now() + CONFIRM_MS;
    let o = await observe('before_send');
    while (o.evaluation.verdict === 'met' && input.modelSelection && !sameModel(o.thread.modelSelection, input.modelSelection) && now() + POLL_MS / 2 <= deadline) {
      await sleep(POLL_MS / 2);
      o = await observe('before_send');
    }
    if (o.evaluation.verdict !== 'met') return conclude('failed', { failedStep: 'thread.send', failedOperationId: ids.send, reason: `precondition_${o.evaluation.reason}`, sent: false });
    if (input.modelSelection && !sameModel(o.thread.modelSelection, input.modelSelection)) return conclude('failed', { failedStep: 'thread.send', failedOperationId: ids.send, reason: 'model_selection_not_applied', sent: false });
  }

  // 4. The send, as start_immediately: never queue_after_active, steer or restart.
  const s = await step(inputs.at(-1));
  if (s.state !== 'completed') return stopAt(s);
  return finish('completed', { delivery: await postCheck(host, input, ids.send) });
}

// The existing writes this request is made of, in order.
const stepInputs = (input, ids) => [
  ...(input.modelSelection ? [{ action: 'thread.model-selection.set', operationId: ids.model, stepInput: { threadId: input.threadId, modelSelection: input.modelSelection } }] : []),
  { action: 'thread.send', operationId: ids.send, stepInput: { threadId: input.threadId, clientRequestId: ids.send, text: input.text, delivery: 'start_immediately' } },
];

// A step as the Dispatcher's journal holds it. Only completed and a proven refusal are definitive.
// `preparing` means "not sent yet": its executor may be alive and send later (or have died, which
// nothing here can prove), so it is uncertain like a send without an acknowledgement.
function stepFromDispatcher(durable, operationId, at) {
  const base = { action: durable.action, operationId, finishedAt: at };
  if (durable.state === 'completed') return { ...base, state: 'completed', ...(durable.receipt ? { receipt: durable.receipt } : {}) };
  if (durable.state === 'rejected' && durable.closedBy === CONDITIONAL_SEND) return { ...base, state: 'rejected', error: durable.reason ?? 'closed_not_sent', closed: true };
  if (durable.state === 'rejected' || durable.state === 'failed') return { ...base, state: 'rejected', error: 'dispatch_rejected' };
  if (durable.state === 'preparing') return { ...base, state: 'uncertain', reason: 'step_in_progress' };
  return { ...base, state: 'uncertain', reason: 'reconciliation_required' };
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
  const op = record.failedOperationId ? ` ${record.failedOperationId}` : '';
  const nextAction = {
    precondition_pending: 'afterRunId is still active: wait (t3_aguardar_thread) and retry with the same clientRequestId',
    precondition_failed: 'nothing was sent: read t3_thread and decide again with a new clientRequestId',
    failed: 'the failed step was not sent; steps listed as completed remain applied',
    uncertain: record.reason === 'step_in_progress'
      ? `step${op} is still being written by another call and may be sent: do not resend under another id; retry with the same clientRequestId or reconcile${op} with t3_reconciliar_escrita`
      : `do not retry under another id: reconcile${op || ' the failed step operationId'} with t3_reconciliar_escrita; the same clientRequestId re-reads its state`,
  }[record.state];
  return { ...rest, replayed, ...(nextAction ? { nextAction } : {}) };
}
