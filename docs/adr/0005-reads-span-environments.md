# ADR 0005: reads without `environment` span every environment

Date: 2026-10-06. Status: accepted (Marcus, 2026-10-06: discovery and listing reads
without `environment` must query every authorized environment and say where each result
came from; `environment` becomes an optional filter; writes keep requiring one).

## Context

[ADR 0001](0001-environments.md) made `environment` optional on every tool and fell back
to the config `default` (the local machine). In practice the connector serves two
environments (this machine and a server over SSH) and most calls from the client omit
`environment`. Every such call read only the default environment, so a thread, project
or provider instance that existed only in the other environment looked absent: a
`t3_threads` call with `woke: true` returned nothing while the remote sidebar showed a
woke thread, and `t3_thread` answered "not found" for a remote ID. The answer looked
global, but it was one host's view.

The root cause was a single point: `resolver(undefined)` in the environment registry
substituted the default, and the server routed every read through it. The exception
already carved out for `t3_buscar_threads` (query every environment, report failures per
environment, mark the result incomplete) was the behavior the other reads needed.

## Decision

1. **No default environment for reads.** `resolver` requires a key; a missing key is a
   caller error, never a silent substitution. The config `default` key is still accepted
   but only informs the CLI banner and `t3-connector environments`; `t3_ambientes` no
   longer returns it.
2. **Listings and discovery span every environment.** `t3_projetos`, `t3_threads`,
   `t3_atencao`, `t3_providers` and `t3_buscar_threads` called without `environment`
   query every configured environment with that environment's ACL, through one shared
   sweep (`src/varredura.mjs`): 4 s per environment, 10 s in total, at most 4 at a time,
   ordered by `environmentId`. Each item carries `environment: {alias, environmentId,
   name}`.
3. **Partial is never silent.** Every listing returns `complete`, `queriedEnvironments`
   (each with `found`) and `environmentFailures` (sanitized code and reason). An
   environment that fails, times out, answers as another environment or refuses the
   query (a filter its server cannot decide, a `projectId` it does not authorize) is a
   failure entry and `complete` is false. If every environment fails, the response is
   still a normal envelope with `complete: false`, not a success that looks empty.
4. **`environment` is an optional filter.** With it, only that environment is read, with
   no deadline beyond the connection's, and a failure there is a tool error, as before.
   The top-level `environment` field is kept in that case.
5. **Reads by ID locate, never choose.** `t3_thread` and `t3_mensagens` without
   `environment` run the same sweep over the shells to find the thread ID (archived
   threads included, as `exigirThread` accepts them). Exactly one environment has it:
   the read proceeds there and the response carries `environment` and
   `environmentDiscovery` (the sweep summary). More than one: refused, asking for
   `environment`. None: refused, naming the environments that answered and the ones
   that did not, because the thread may live in one of those. With `environment`, the
   read never looks elsewhere (ADR 0001 unchanged).
6. **Writes and waiting are unchanged.** `t3_aguardar_thread` and every write action keep
   requiring `environment`; there is still no fallback between environments.
7. **Pagination.** Keys gain `environmentId` as a tiebreaker before the item ID (the same
   thread ID can exist in two environments). The cursor signature carries the filters,
   the environment filter, the selected environments and, last, the environments that
   answered; when only the last part changes between pages the cursor is rejected with a
   message that says the coverage changed. Cursors issued before this change are rejected
   with the usual message.

## Consequences

- A read without `environment` costs one shell fetch per environment and may take up to
  the per-environment deadline when one is slow; a read with `environment` costs what it
  did before. Clients that know the environment should pass it.
- Clients must read `complete` and `environmentFailures` before concluding absence, and
  tell the user which environment did not answer.
- The `found` count per environment in `queriedEnvironments` discloses that a thread or
  project exists in an environment the caller can already read; nothing outside the ACL
  of that environment is revealed.
- The write-lease reads (`t3_projetos`, `t3_threads`, `t3_atencao`, `t3_thread`,
  `t3_mensagens` under a lease) always pass the lease's environment, so they keep the
  single-environment path; their items gain the `environment` field.
