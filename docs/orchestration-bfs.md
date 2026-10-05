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

`needs_intervention > running > snoozed > failed_unsettled > completed_unsettled > cancelled_unsettled > unknown`

- `needs_intervention` and `running` include settled threads. The other groups only hold
  unsettled threads.
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
- `complete: false` means an environment failed (see `environmentFailures`). Groups still hold
  what the other environments returned. An empty group then proves nothing about the failed
  environment.

### 2. `t3_thread` with `settlementContractVersion: 1`: the decision packet

The usual `t3_thread` answer already holds the conversation facts: `state`, `stateSource`,
`activeRun`, `pendingRequests[].nextAction`, `latestResponse`. With
`settlementContractVersion: 1` it also reads the full thread snapshot and adds `settlement`:

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
| `settle_guard_version_unsupported` | `version` is not 1 |

A refusal does not end the session and does not need reconciliation. Read the thread again and
decide again. A new decision needs a new `operationId`: reusing one with a different guard is
`operation_conflict`.

After T3 acknowledges the settle, the result adds `settlement.postCheck`:

- `verified`: a fresh read shows the thread settled and unblocked.
- `mismatch` (`settle_postcondition_mismatch`): the read shows otherwise. The backend or another
  client may have changed the thread. It is not proof that the command had no effect.
- `unavailable` (`settle_verification_unavailable`): the read failed or was older than the
  receipt.

The connector never sends a compensating command. Repeating the same `operationId` returns the
same receipt and post-check without sending again.

Without `settleGuard`, `thread.settle` behaves exactly as before and checks nothing.

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
