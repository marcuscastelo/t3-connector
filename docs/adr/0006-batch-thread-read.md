# ADR 0005: batch thread read with per-item failure

Date: 2026-10-06. Status: accepted.

## Context

A control plane that follows several owner threads (often in more than one
environment) had to call `t3_thread` once per thread. Each call costs a model turn and
reads its own shell, so states of threads in the same environment were judged at
different instants. The batch investigation (`docs/design/batch-api-v1.md` on
`investigate/batch-tool-opportunities`, commit `754a1c9`) proposed `t3_thread_read_batch`
with views and a response budget; this ADR adopts the minimal part needed now.

## Decision

- One read tool, `t3_thread_read_batch`, with `items: [{environment, threadId}]` (1-20),
  `maxCharacters` and a whole-call `timeoutMs` (default 10 s, max 30 s). `environment` is
  required per item: no default environment and no fallback between environments.
- One view only: each `ok` item carries the `t3_thread` result, produced by the same
  function (`detalheDaThread`), so the state, run and pending-request contracts are not
  duplicated. The `state`/`messages` views of the design are not implemented.
- Failure is per item and in input order. Admission errors (schema: missing environment,
  unknown key, more than 20 items) fail the call; everything after admission (unknown or
  unconsented environment, thread outside scope, environment down, projection failure,
  deadline) is an item `error` with a sanitized code reused from `t3_buscar_threads`.
  Only client cancellation ends the whole call.
- One shell per environment per call, read inside one `ambientes.usar`, so the OAuth live
  policy primes one scope per environment and every item of that environment is judged on
  the same observation. Projections are read afterwards, up to 4 in parallel per
  environment; a transport failure on one projection drops the cached connection like the
  single-thread tools do.
- A repeated `(environmentId, threadId)` (also via alias vs. ID) is coalesced: read once,
  answered at each position. The design's proposal to reject repetitions was not adopted
  because a duplicate is harmless for reads and rejecting it would hide every target.
- `complete` is false when an item failed for a transient reason; `thread_not_found` and
  `environment_not_allowed` are final answers.
- Not exposed in the write plugin's lease reads: a lease covers one environment, so a
  batch there would need one lease per environment. Those clients keep `t3_thread`.

## Consequences

- No response budget or `not_read_budget` status: 20 items with `maxCharacters` up to
  6000 bound the output. Raising the item limit requires the budget from the design.
- Shell and projection of one thread are still read at different instants, as in
  `t3_thread`; there is no coherent cross-environment snapshot.
