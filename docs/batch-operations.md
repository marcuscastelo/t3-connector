# Batch thread operations

Two tools let a client resolve and act on several threads in one call instead of one call per
thread: `t3_thread_find_batch` (read) and `t3_thread_inbox_update_batch` (write, OAuth session
profile). The motivating flow is inbox-zero: "find these 7 threads and snooze them until
tomorrow". Without them, the client chains 7 searches and 7 snoozes, and a failure in the middle
leaves it unsure what happened.

The existing single-thread tools are unchanged.

## Design choice

- **Typed, homogeneous batch tools; no generic `execute_batch`.** A tool that accepts any
  `{tool, args}` list would mix reads and writes. That breaks the scope choice based on
  `readOnlyHint` and spreads every action's preconditions over one schema. Each batch tool has
  one purpose and one schema. The reusable part is internal (`src/escrita/lote-inbox.mjs`:
  admission, manifest, sequencing, envelope). A later inbox action needs an allowlist entry plus
  its own preconditions, not a new framework.
- **One action per write call.** `action` is `snooze` or `unsnooze`. Other inbox actions (settle,
  archive, pin…) stay out until their preconditions are designed. Settle and archive, for
  example, need an active-work guard.
- **Search and mutation stay separate.** There is no "find and apply". A title never reaches a
  write: the write needs the exact `(environment, threadId)` and the `expectedProjectId` the
  client observed.
- **Each item still goes through the existing Dispatcher.** Each item keeps its own journal
  reservation, scope checks and stable `operationId`. Uncertain results are never resent. The
  batch adds a manifest on top of the journal. It does not replace the journal.

Background: the investigation in `docs/design/batch-api-v1.md` (branch
`investigate/batch-tool-opportunities`) proposed five tools. This delivery implements the two the
inbox flow needs. `t3_inbox_read_batch`, `t3_thread_read_batch` and a reconcile batch are deferred.

## `t3_thread_find_batch`

Input: `queries` (1-50), each `{key, search, match?, limit?, cursor?}` or
`{key, threadId, limit?, cursor?}`, and `environments?`. Omitting `environments` searches every
configured environment. Aliases and environmentIds are deduplicated.

Each environment's shell is read **once per call**, with the same deadlines as `t3_buscar_threads`
(4 s per environment, 10 s total, at most 4 in parallel). Every query is then applied to that read.

Output: `results` in the order of `queries`, one per `key`:

| Field | Meaning |
|---|---|
| `status` | `ok`, or `error` for an invalid cursor of that query only (`cursor_invalid`, `cursor_coverage_changed`) |
| `resolution` | `resolved`: exactly one candidate and every environment answered. `ambiguous`: more than one candidate. `not_found`: zero candidates and every environment answered. `inconclusive`: zero or one candidate while some environment failed |
| `total`, `returned`, `truncated`, `nextCursor?` | `total` and `resolution` count every match; `limit` (1-20, default 5) only cuts the page |
| `complete`, `queriedEnvironments` (with `found`), `environmentFailures` | Coverage, repeated per query |
| `candidates` | Same items as `t3_buscar_threads` (`environment`, `project`, `state`, `archived`…) |

The envelope adds `summary` (count per resolution plus `error`), `complete`,
`queriedEnvironments` and `environmentFailures`.

Rules:

- An ambiguous or inconclusive query is never resolved by order, recency or default
  environment. The client shows the candidates and asks.
- A structurally invalid query rejects the whole call before any read: both or neither of
  `search`/`threadId`, `match` with `threadId`, blank search, repeated `key`, unknown environment.
  Different keys with the same query are fine; each gets its own answer.
- Universe: the threads each environment lists as live. Deleted threads never appear. Archived
  coverage depends on the shell and is not promised, so `not_found` only covers that universe.

## `t3_thread_inbox_update_batch`

Input:

```json
{
  "batchId": "inbox-2026-10-05-snooze",
  "action": "snooze",
  "items": [
    {"key": "Revisar PR", "environment": "polaris", "threadId": "t-1", "expectedProjectId": "p-1",
     "operationId": "inbox-2026-10-05-t-1", "snoozedUntil": "2026-10-06T09:00:00-03:00"}
  ]
}
```

- 1-20 items. `snoozedUntil` is required for `snooze` and refused for `unsnooze`. It must be an
  absolute ISO 8601 instant with `Z` or an explicit offset; the connector converts it to UTC.
  Relative times ("tomorrow 9:00") are computed by the client in the user's timezone.
- **Admission rejects the whole call, before anything is reserved or sent,** on: repeated
  `key`, the same thread twice (also through alias and environmentId), repeated
  `operationId`, missing or misplaced `snoozedUntil`, invalid instant. An unknown environment is
  an item result (`environment_unknown`), not an admission failure.

### Execution

Items run **sequentially, best-effort, without a transaction**. For each item:

1. The connector checks that the session may perform the action in that environment. It then
   reads the thread's project: no thread gives `thread_not_found`, another project gives
   `precondition_failed`. Nothing is sent and the item is not journaled. This is a comparison
   observed by the connector, not a compare-and-set in T3.
2. Then the singular write path runs: `dispatch`, Dispatcher, journal, final checks, one send.

| Item `status` | Meaning |
|---|---|
| `applied` | T3 acknowledged the command (`receipt`) |
| `rejected` | Nothing was sent; `error: {code, message}` (for example `thread_not_found`, `precondition_failed`, `scope_denied`, `environment_unknown`, `environment_unavailable`, `operation_conflict`) |
| `uncertain` | Sent or possibly sent without confirmation. Never resend; use `t3_reconciliar_escrita` with that environment and `operationId` |
| `not_started` | Not attempted because the batch stopped; nothing was sent |
| `replayed` | The `operationId` (or the whole batch) was already recorded; nothing was sent again. `originalStatus` says how it ended, and can be `rejected` or `uncertain` |
| `failed` | Only as a recorded outcome reported back |

Ordinary refusals do not stop the batch. These **stop it**, and the remaining items become
`not_started` with `error.code: batch_stopped`:

| `stopped.reason` | When |
|---|---|
| `uncertain_send` | An item became uncertain. As on the singular path, this ends every OAuth session |
| `journal_failed` | Journal failure. Fails closed, as on the singular path |
| `session_closed` | The session ended or was revoked |
| `deadline` | The 20 s deadline passed between items |
| `cancelled` | The client cancelled the call. Already-applied items are not undone |

The envelope has `batchId`, `action`, `replay`, `inProgress?`, `complete`, `allSucceeded`,
`stopped?`, `returned`, `summary` (count per status) and `items`, in request order. `complete`
means every item has a known outcome; rejections count as known. `allSucceeded` means every item
was applied, either fresh or as a replayed `applied`.

### Idempotency and recovery

- Before the first item, a **manifest** keyed by (stable caller, `batchId`) is reserved in the
  write journal with a hash of the normalized batch. The hash ignores item order and treats an
  alias and its environmentId as the same environment. The manifest is updated after every item
  and marked finished at the end.
- **Repeating the same call with the same `batchId` never sends.** It returns the recorded results
  (`replay: true`, items `replayed` or `not_started`), including after a reconnect. An item missing
  from the manifest is filled from its journal record: none gives `not_started`, `preparing` or
  `uncertain` gives `uncertain`. If the manifest was never finished, the envelope has `inProgress: true`:
  the original call is still running or was interrupted (crash). Its unrecorded items stay
  `not_started` or `uncertain` and are never resumed automatically.
- The same `batchId` with other items, values or action is refused with `batch_conflict`. Nothing
  is sent.
- Replays are visible only to the same subject, with an active session that still holds the
  action in every item's environment.
- **Retrying `not_started` or `rejected` items is a new intent:** re-read the threads, then send
  a new `batchId` with new `operationIds`. An `operationId` already in the journal is answered per
  item from the journal (`replayed`, or `operation_conflict` if the input differs). This covers
  operationIds from singular calls and from other batches.
- If the session ends during the call (an uncertain send revokes every session), the OAuth facade
  withholds the envelope and the client sees `session_expired`. Reconnect and repeat the same call
  to read the outcome. Do not resend under a new `batchId`.

### Scope and profiles

- Available in the OAuth session profile, in both `restricted` and `all` modes. Each item needs
  the internal action (`thread.snooze` or `thread.unsnooze`) in the scope approved for its
  environment. Offering the batch tool grants nothing extra.
- Not offered in the lease (Ponte) write bridge. `t3_thread_find_batch` is in the read MCP (stdio
  and OAuth), not in the leased reads of the write bridge.

### Not done here

- No noop shortcut: every admitted item is dispatched.
- No preview mode, no response byte budget, no batch reconcile tool. Per-item reconciliation uses
  `t3_reconciliar_escrita`.
- No live rehearsal against a real T3 environment. Tests use fakes; installing or enabling this in
  an environment needs separate authorization.
