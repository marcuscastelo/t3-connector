# Execution snapshot (`execution`, contract version 1)

`t3_thread.execution` and `t3_aguardar_thread` with `until: "execution_idle"` describe what a
thread is actually doing. A host or orchestrator uses this block, not `state` alone, to decide
whether to wait, continue or settle. Implementation: `src/execucao.mjs`.

## Why

`state` summarizes the thread shell, and the shell describes the newest run. Three facts fall
outside it:

- **A finished run is not finished work.** The provider can keep background work after the run
  ends: a Claude background Bash or Monitor task, a backgrounded subagent, a Codex background
  command. T3 keeps it in `providerThreads[].pendingBackgroundTasks` and in active turn items.
  The shell publishes that list only after the latest run has settled. While a run is active
  the shell list is empty even when background work exists.
- **The latest response can belong to an older run.** `latestResponse` is the newest assistant
  text in the window. A later run that failed or completed without text leaves it unchanged.
  An old message saying "the observer is running" says nothing about the present.
- **The shell and the thread projection are two reads.** The connector reads them one after the
  other, so a change between the reads can make them disagree.

The motivating incident went like this. Run 1 started a 3-minute observer and answered "observer
active". Run 1 ended while the observer kept running. Run 2 failed because of the background work,
without new text. Then the observer ended. The thread read `completed` or `failed` with the old
answer. An orchestrator first concluded the observer was still running, then that the thread was
stuck, and finally opened a duplicate continuation. Every signal it needed was in the
projection, but no field correlated them.

## Sources and coherence

- `execution` is derived from **one** projection read: `/bounded` in `t3_thread`, the full
  snapshot in the send preflight, or the subscription snapshot plus events in order of
  `sequence` in the wait. Each projection is a single backend transaction. The bounded
  projection carries every run, runtime request, provider thread, provider session and subagent,
  and only a recent window of messages and turn items.
- The shell serves authorization, the top-level fields, the usage-limit state and, when it is
  the same thread version as the projection, the background list. That list is computed from the
  complete history, so it also covers turn items outside the window.
- **Version check.** Every thread event advances `projection.updatedAt`. When the shell's
  `updatedAt` equals the projection's, both describe the same version. `t3_thread` compares
  version, latest run, active run and pending request. On a difference it reads both again once.
  `coherence.status` is then `coherent`, or `shell_lagging` with `reasons`. When the shell lags,
  the top-level fields are older than `execution`, and `execution` wins. In OAuth
  all-projects mode the shell is cached per call, so a second read can lag again; the status
  says so instead of mixing the reads silently.
- `source` records `kind`, `threadSequence` (the projection's `snapshotSequence`, or the last
  event applied), `projectionUpdatedAt`, `shellUpdatedAt` and `history` (`complete` or `window`).

## Fields

| Field | Meaning |
|---|---|
| `runs.latest` | Newest run, by the shell's rule. It may be queued. |
| `runs.active` | Run executing now (preparing, starting, running or waiting), or null. |
| `runs.latestExecuted` | Newest run that actually ran. Responses and failures are compared against it. |
| `runs.queued` | Queued runs, with `queueHeld` when the queue waits for the user. |
| `latestRunFailure` | `{runId, class, code, message, source}` of `latestExecuted` when it failed, taken from its error turn item. |
| `latestResponse` | Metadata of the newest assistant text: `messageId`, `runId`, `runOrdinal`, timestamps, `streaming`, and `relation`: `latest_executed_run`, `older_run`, `unattributed` (no runId) or `unknown_run`. The text stays in the top-level `latestResponse`. |
| `pendingRequests` | Pending runtime requests from the projection. |
| `providerSession` | `id`, `status`, `model`, `updatedAt`, `lastError`. Informational: `ready` can coexist with an active run. |
| `background.knowledge` | `complete`: absence is proven. `partial`: turn items outside the window are not covered. `unknown`: the server sends no roster. |
| `background.pending[]` | `taskId`, `kind` (`subagent`, `command`, `monitor`, `background_task`), `description`, `source` (`provider_roster`, `turn_item`, `subagent`, `shell_roster`), `holdsThread`, `runId`, `startedAt`, `childThreadId?`. Work inside an active run is part of that run, not background. |
| `background.endedSinceLatestRun[]` | Work that ended after `latestExecuted` completed, so no model turn has started since. Sources: turn items and subagents with `completedAt`, notification items or messages, and delegated-task completions whose delivery is still pending. |

`holdsThread` follows T3's own rule. Commands do not hold the thread: a dev server can run for
hours after the agent is done. Subagents, monitors and unnamed background tasks do hold it,
because they wake the agent.

### Signals

| Signal | Rule |
|---|---|
| `runTerminal` | `latestExecuted` is terminal and no run is active. |
| `foregroundActive` | A run is active. |
| `queuedWork` | Queued runs exist. |
| `pendingIntervention` | A pending request, an active proposed plan or a usage limit without automatic resume. |
| `backgroundWorkActive` | Some background work is pending. Null when absence cannot be proven. |
| `backgroundWorkHoldsThread` | Some pending work holds the thread. Null when absence cannot be proven. |
| `backgroundWorkEndedUnconsumed` | `endedSinceLatestRun` is not empty, and no run is active or queued. |
| `responseStale` | `latestResponse` does not belong to `latestExecuted`. Null without a response. |
| `latestRunHasNoAssistantResponse` | `latestExecuted` is terminal and wrote no assistant text. |
| `operationallyIdle` | The `continuation.blockers` list is empty. |

### Continuation

- `canStartNow` is true when there are no `blockers`. Possible blockers: `active_run`,
  `queued_runs`, `pending_request`, `proposed_plan`, `usage_limit`, `usage_limit_auto_resume`,
  `background_work_active`, `background_work_unknown` and `execution_evidence_invalid`.
- `execution_evidence_invalid` means the projection does not follow the V2 contract (a run,
  request, subagent, plan or turn item with an unknown status, kind or type, a duplicate ID, a
  roster task without `taskId`, an active provider thread missing from the roster, a missing
  `runs`, `runtimeRequests`, `turnItems`, `subagents` or `plans` list) or the shell has
  conflicting or malformed rows for the thread. When the shell keeps changing and `execution`
  falls back to the projection alone (`coherence.status: projection_only`), anything invalid
  the observation saw stays here, and the projection must belong to the thread.
  `evidence.problems` lists what failed. Nothing is proven
  from such a read: settle refuses (`settle_observation_incomplete`), the dispatch preflight
  refuses, `execution_idle` never returns, and `thread.send` `start_immediately` refuses with
  `execution_evidence_invalid` even without a guard.
- `reasons` lists deterministic facts that leave work to pick up:
  `background_work_ended_after_latest_run`, `latest_run_without_assistant_response` and
  `latest_run_failed`.
- `recommended` is `canStartNow && reasons.length > 0`.
- `target` is always `same_thread`. The snapshot never suggests a new thread or a fork.

None of this is acceptance. A run that completed with a fresh response can still be wrong, and
settle has its own guard. The snapshot reports facts and mechanical eligibility.

## How a host should consume it

1. Read `t3_thread`. If `coherence.status` is not `coherent`, act on `execution`, not on the
   top-level `state`, or read again.
2. If `continuation.canStartNow` is false, the blockers say why. Do not send:
   - `active_run`: steer it, or wait with the default mode.
   - `pending_request`: answer it with `runtime-request.answer` or `approve`.
   - `background_work_active`: wait with `t3_aguardar_thread` `until: "execution_idle"`.
   - `background_work_unknown`: read again. A long thread with a lagging shell cannot prove
     absence from the window alone.
3. If `canStartNow` is true and `recommended` is true, continue **in the same thread** with
   `thread.send` `start_immediately`. Never open a new thread because the latest response looks
   old or the latest run has no text: `responseStale` and `latestRunHasNoAssistantResponse`
   are facts about runs, not evidence that the thread is stuck.
4. Never derive state from response text. A message saying work is running is history.
5. To wait for real work, use `t3_aguardar_thread` with `until: "execution_idle"`. It subscribes
   to the full projection and applies events in order of `sequence`. It returns
   `execution_idle` once nothing holds the thread and the thread has been quiet for 1.5 s. The
   quiet period keeps a wake run, which the provider opens right after a background task ends,
   from being taken for the end of work. Quiet time is measured against the backend clock
   (`projection.updatedAt`), and the call deadline bounds it. The wait returns
   `needs_intervention` at once when intervention is pending. `backgroundClearedDuringWait`
   lists the tasks that left the roster during the wait, with the event `threadSequence`;
   Claude's roster records no end time.

## `thread.send` preflight

Before starting a run, `thread.send` with `delivery: "start_immediately"` derives `execution`
from the same coherent acquisition as the settle guard: shell, full thread snapshot, shell again
(`source.kind: "thread_full_snapshot"`). The shell supplies the usage limit, the proposed plan and
its background roster. If the thread keeps changing between the reads, the latest full snapshot is
used alone and `coherence.status` is `projection_only`. If `signals.backgroundWorkHoldsThread` is
true, nothing is sent. The answer is a result, so its structure survives the private relay:

```json
{"state": "rejected", "operationId": "…", "sent": false, "reconciliationRequired": false,
 "refusal": {"code": "background_work_active", "message": "…"}, "execution": {…}}
```

The journal keeps the refusal under that `operationId`. A replay returns the same refusal and
sends nothing. After the work ends, send again with a **new** `clientRequestId`. Passing
`onBackgroundWork: "send"` skips the check. The provider can still refuse a model or setting
change while that work runs (Claude: `ClaudeBackgroundWorkBlocksQueryReplacementError`).
`steer_active`, `restart_active` and `queue_after_active` name the active run explicitly and
are not checked. If the read fails, the send is refused before sending with
`execution_snapshot_unavailable`. An unknown background state (a server without a roster) does
not refuse; invalid evidence (`execution_evidence_invalid`) does.

## Limits

- No public endpoint reports provider processes. The roster and turn items are T3's model of
  them. An empty roster after a restart or a stop can mean cancelled work, not completed work.
- Claude's roster stores no end time. A single read cannot date the end of such a task, so
  `endedSinceLatestRun` covers only sources that store `completedAt` or a notification. The
  wait observes the transition instead.
- Codex can resume a completed subagent later without a signal in between. A complete, empty
  background list does not rule out a future wake.
- The version check relies on `thread.updatedAt`, which both the shell and the projection
  read from the stored thread row. A change that does not advance it (if any exists) passes as
  the same version. The only cost is conservative: the shell's background list can add a task
  that has already left the roster.
- In OAuth all-projects mode the shell of one call is cached. Coherence reads (the settlement
  observation and the second `t3_thread` read) read it again, with the consent checked again.
- Neither the version check nor the preflight is a compare-and-swap. Another client can change
  the thread between the read and the send.

## Composition with BFS, settle guard and batch

`derivarExecucao` is pure and takes one projection. Whatever already holds a projection should
call it instead of re-deriving blockers:

- `settlementContractVersion`/`settleGuard`: the settle observation derives `execution` from
  its own full snapshot and takes its background blockers from `execution.background` (work
  that holds the thread); the shell's gated roster can only add one. With the opt-in,
  `t3_thread.execution` is that same derivation (`source.kind: "thread_full_snapshot"`).
  Acceptance stays separate. `responseStale` does not block settle.
- `t3_workset` reads only the shell. It keeps its compact summary and applies the same
  `holdsThread` rule to the shell's roster for `background_pending`; it does not fetch one
  projection per thread to enrich a list.
- A future `thread_read_batch` returns `execution` as each item's `data`. The batch envelope
  keeps keys, coverage and errors.
