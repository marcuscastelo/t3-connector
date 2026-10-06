# Orchestrating T3 threads from an LLM host

This guide is for an LLM host (ChatGPT, Claude, a voice assistant) that coordinates several
T3 threads breadth-first: it launches work, comes back later, absorbs results and decides what
happens next. The connector has no model of its own. The host decides meaning and intent. The
connector supplies state, invariants and checked transitions.

## The three calls

| Step | Call | What you get |
|---|---|---|
| 1. Rebuild the picture | `t3_workset {}` | Every thread that still needs a decision, in every environment, in disjoint groups |
| 2. Decide one thread | `t3_thread {environment, threadId, settlementContractVersion: 1}` | Canonical state, pending requests with `nextAction`, latest response, and `settlement` facts |
| 3. Apply the decision | the write tool you chose, e.g. `thread.settle` with `settleGuard` | Refusal with a code (nothing sent) or a receipt plus a post-check |

### 1. `t3_workset`: rebuild after losing context

Call it at the start of a session, after a voice drop, or when you no longer trust your notes.
It reads one shell snapshot per environment (all of them, or `environments: [...]`) and puts
each visible thread in exactly one group:

`needs_intervention > running > background_pending > unknown > snoozed > failed_unsettled > completed_unsettled > cancelled_unsettled`

- `needs_intervention`, `running`, `background_pending` (background work that holds the thread
  is still pending; it can outlive a settle) and `unknown` include settled and snoozed threads. The other groups only
  hold unsettled threads.
- Background work comes from the shell's roster only (one shell read per environment). The
  group follows the rule of [`execution`](execution-snapshot.md): a background command (a dev
  server) does not hold the thread, so a thread with only that lands in its state group with
  `backgroundTaskCount` and `backgroundHoldsThread: false`. The shell publishes the roster only
  after the latest run settled, so the list cannot prove absence; read `t3_thread` to decide.
- `snoozed` holds unsettled threads whose `snoozedUntil` is still in the future. A past
  `snoozedUntil` falls back to its state group.
- `completed_unsettled` is the main "forgotten work" list. A completed run is not an accepted
  delivery. Each of these threads still needs you to absorb the result and then continue, wait
  or settle it.
- Settled idle threads and threads without a run are only counted (`counts.settledIdle`,
  `counts.noRun`).
- Items carry references and facts, never conversation text: `environment` (alias),
  `threadId`, `projectId`, `state`, `stateSource`, `runId`, `latestRunId?`, `pendingRequest`,
  `updatedAt`, `settled`, `snoozedUntil?`, `pinned` (`null` when the server does not report it),
  `parentThreadId?`, `linkedPullRequest?`.
- **Active queue.** Consume `actionable` (decide now: needs_intervention, unknown,
  failed_unsettled, completed_unsettled, cancelled_unsettled) and `inFlight` (running,
  background_pending) directly, as `{environment, threadId, group}` in that order. Settled idle
  threads, threads snoozed until a future time and archived threads are never in them. A
  snoozed completed thread does not come back as today's decision until its wake time. A
  pending request, an active run or background work keeps a thread in the queue even if it is
  settled or snoozed. The lists follow `limitPerGroup`; `counts.actionable` and
  `counts.inFlight` count everything.
- `archived` is listed apart and never mixed with today's work. Until a validated source of
  archived threads exists it is `{available: false, reason: "archived_source_not_validated"}`,
  which does not mean there are none. An unarchived thread follows the normal rules.
- `complete: false` means an environment failed (see `environmentFailures`). Groups still hold
  what the other environments returned. An empty group then proves nothing about the failed
  environment.

### 2. `t3_thread` with `settlementContractVersion: 1`: the decision packet

The usual `t3_thread` answer already holds the conversation facts: `state`, `stateSource`,
`activeRun`, `pendingRequests[].nextAction`, `latestResponse`. With
`settlementContractVersion: 1` the whole answer (`latestResponse`, `pendingRequests`,
`activeRun`, `latestRun`) is built from one validated observation of the full thread snapshot,
and `settlement` comes from that same observation, so `expectedRunId` always matches the
delivery you were shown. If the thread kept changing while it was read, `settlement.complete`
is false with no `observationId` (it cannot be used for a guard) and the rest comes from the
usual read. Unknown run, request or thread statuses and a missing snapshot sequence also make
the observation incomplete:

```json
{
  "contractVersion": 1,
  "complete": true,
  "observationId": "obs1_…",
  "expectedRunId": "run-…",
  "eligibleMechanically": false,
  "acceptanceRequired": true,
  "settled": false,
  "blockers": [{"code": "active_run", "runId": "run-1", "status": "running"}],
  "warnings": [{"code": "linked_pr_merge_can_auto_settle"}],
  "fieldAvailability": {"pinnedAt": true, "snoozedUntil": true, "unsettledAt": true, "autoSettleDisabledAt": true, "pullRequests": true}
}
```

- `blockers` are objective facts: `pending_request`, `active_run` (even with no pending
  request, and even when a newer run was cancelled by a steer), `queued_work` (including a
  held queue), `unresolved_work` (usage limit, proposed plan, background task, unknown
  state), `observation_incomplete`.
- Background tasks come from `execution`, derived from the same full snapshot (provider
  roster, turn items and subagents, without the shell's post-turn gate). The shell's roster can
  only add a blocker, never remove one. Only work that holds the thread blocks: a background
  command does not. When the server sends no roster, absence is not proven and `warnings`
  carries `background_work_unknown`; it does not block, like the `thread.send` preflight.
- With the opt-in, `t3_thread.execution` comes from that same observation
  (`execution.source.kind: "thread_full_snapshot"`), so settlement and execution never describe
  two different reads.
- `eligibleMechanically: true` only means nothing objective blocks a settle. It is never
  acceptance. Whether the delivered scope is acceptable is your call (or the user's).
- `observationId` is a digest of what would invalidate your decision: runs, requests, latest
  message, settlement fields, pin, linked PRs, plan, limit and background work. It does not
  change when only `updatedAt` changes.
- A field the server does not report is `null` with `fieldAvailability: false`, never `false`.

### 3. Transition with a guard

To settle, pass the observation you decided on:

```json
{
  "environment": "polaris",
  "operationId": "settle-thread-a-1",
  "input": {
    "threadId": "thread-a",
    "settleGuard": {
      "version": 1,
      "expectedRunId": "<settlement.expectedRunId>",
      "expectedObservationId": "<settlement.observationId>",
      "acceptance": {"accepted": true, "evidenceRef": "review accepted in PR #42"}
    }
  }
}
```

Right before sending, the connector reads the thread again and refuses, sending nothing, with:

| Code | Meaning |
|---|---|
| `settle_acceptance_required` | `acceptance.accepted` is not `true` |
| `settle_observation_incomplete` | the full snapshot could not be read coherently |
| `settle_pending_request` | a runtime request is pending |
| `settle_active_run` | a run is active, even with no pending request |
| `settle_queued_work` | a run is queued |
| `settle_unresolved_work` | usage limit, proposed plan, background task or unknown state |
| `settle_run_changed` | the latest run is not `expectedRunId` |
| `settle_observation_changed` | anything in the observation changed since you read it |
| `settle_guard_version_unsupported` | `version` is not 1 or 2 |

A refusal does not end the session and does not need reconciliation: replaying its
`operationId` returns `state: rejected`, `sent: false`, `reconciliationRequired: false` and the
same code. Read the thread again and
decide again. A new decision needs a new `operationId`: reusing one with a different guard is
`operation_conflict`.

After T3 acknowledges the settle, the result adds `settlement.postCheck`:

- `verified`: a fresh read shows the thread settled and unblocked.
- `mismatch` (`settle_postcondition_mismatch`): the read shows otherwise. The backend or another
  client may have changed the thread. It is not proof that the command had no effect.
- `unavailable` (`settle_verification_unavailable`): the read failed, or the receipt or the
  read has no sequence showing the read is at or after the receipt.
- `pending` (`settle_verification_pending`), on a replay only: T3 acknowledged (the `receipt`
  is returned) but no post-check was recorded, because it is still running or the process
  stopped before recording it. Read the thread with `t3_thread` for the current state.

The connector never sends a compensating command. Repeating the same `operationId` returns the
same receipt and post-check without sending again.

Without `settleGuard`, `thread.settle` behaves exactly as before and checks nothing.

### Settlement and guard version 2 (recommended)

Read with `settlementContractVersion: 2` and settle with `settleGuard.version: 2`. The version of
the guard must match the version of the observation: an `obs1_` id in a version 2 guard is
`settle_observation_changed`, and the connector observes again in the guard's version.

- `blockers` use the codes of `execution.continuation.blockers`, from the same full snapshot:
  `active_run`, `queued_runs`, `pending_request`, `proposed_plan`, `usage_limit`,
  `usage_limit_auto_resume`, `background_work_active`, `background_work_unknown`, plus
  `observation_incomplete`. The shell can only add a blocker (a pending request, an active run, a
  plan or background work that it shows and the projection does not), never remove one.
- Differences from version 1: unknown background work (a server without a roster) blocks instead
  of being a warning; a proposed plan known only from the projection and a usage limit that
  resumes on its own also block. A blocker code the contract does not know makes the observation
  incomplete.
- `observationId` (`obs2_`) also changes with the thread's workspace (worktree path, branch), the
  text of the latest assistant response (edited without a new message id), the kind and source
  of background work, work that ended after the latest run, the projection's plans and the
  blockers themselves.

| Blocker (v2) | Refusal |
|---|---|
| `observation_incomplete`, `background_work_unknown`, an unknown code | `settle_observation_incomplete` |
| `pending_request` | `settle_pending_request` |
| `active_run` | `settle_active_run` |
| `queued_runs` | `settle_queued_work` |
| `proposed_plan`, `usage_limit`, `usage_limit_auto_resume`, `background_work_active` | `settle_unresolved_work` |

Refusal codes, replay, post-check (`settlement.contractVersion: 2`) and the legacy path are the
same as in version 1. Version 1 keeps its output and its `obs1_` ids.

## Example: a BFS round after a voice drop

1. `t3_workset {}` → `needs_intervention: [polaris:A]`, `running: [sirius:B]`,
   `completed_unsettled: [polaris:C, polaris:D]`, `complete: true`.
2. A has `pendingRequest.kind = user_input`. Read `t3_thread {environment: polaris, threadId: A}`,
   ask the user, answer with `runtime-request.answer` (never `thread.send`).
3. B is running. Leave it; check it on a later turn (`t3_aguardar_thread`, 1-2 s in voice).
4. C: `t3_thread {…, settlementContractVersion: 1}`. The latest response says activation is
   still missing. Your decision: continue. Send the next instruction (`thread.send`,
   `start_immediately`). Do not settle.
5. D: same read; the delivery matches the scope and the user accepted it.
   `blockers: []`. Settle with `settleGuard` using that `observationId`. If the result is
   `settle_observation_changed`, something arrived after you read D: read it again before
   deciding.

Every step that decides meaning (2, 4, 5) belongs to the host. The connector only refuses
transitions that objective facts contradict.

## Limits

- The guard is an observation by the connector, not an atomic check inside T3. Another
  client can still act between the last read and the command.
- T3 can still settle or reopen a thread on its own: a linked PR merge can auto-settle it,
  pinning has been reported to clear `settledAt`, and new activity can unsettle it. `warnings` point these out;
  the connector does not prevent them.
- `t3_workset` reads the active shell only. Archived threads are not listed.
- The lease bridge (`t3-connector-write`) exposes `settlementContractVersion` on its `t3_thread`
  read and `settleGuard` on its settle tool, but not `t3_workset`. It reads one environment
  per call; use the read connector or the OAuth profile for the workset.
