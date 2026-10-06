# Control plane (`controlPlaneContractVersion: 1`)

Semantic operations for an orchestrator (ChatGPT over OAuth, or a host with a lease) on top of
the primitive tools: where to start work, whether a front already exists, what to review,
whether a launch or send would be admitted, and how to settle only after verification. Every
operation is opt-in by `controlPlaneContractVersion: 1`; without it each tool answers exactly
as before. Design and rationale: [design/control-plane-v1.md](design/control-plane-v1.md).

Nothing here is a second policy. In-flight work comes from `execution`
([execution-snapshot.md](execution-snapshot.md)), queues from `t3_workset`, acceptance facts
from `settlement` v2 ([orchestration-bfs.md](orchestration-bfs.md)) and writes from the existing
dispatcher and journal. The connector observes and recommends; it never chooses for you, never
moves work between environments and knows nothing about accounts, quota or roles.

## The loop

1. **Rebuild the picture**: `t3_workset` (`controlPlaneContractVersion: 1`,
   `reviewQueue: {group: "completed_unsettled"}`) gives the active queue and a paged review
   queue whose items say the next read.
2. **Find the front**: `t3_thread_find_batch` with a `selector` and `population: "all"`.
   `launchDisposition` is `continue_existing`, `choose_target`, `candidate_new` or
   `inconclusive`.
3. **Review a completed thread**: `t3_thread` with `settlementContractVersion: 2` and
   `review: true`. Judge the delivery yourself; the packet only gathers facts.
4. **Continue, wait or settle**:
   - continue in the same thread: `t3_dispatch_preflight` (`thread.send`), then
     `thread.send` with `dispatchGuard`;
   - wait for real work: `t3_aguardar_thread` with `until: "execution_idle"`;
   - accept: `thread.settle` with `settleGuard` version 2 and your `evidenceRef`;
   - put aside: `thread.snooze` / `t3_thread_inbox_update_batch`.
5. **Start new work**: `t3_ambientes` with `route` recommends an environment;
   `t3_dispatch_preflight` (`thread.launch`) checks it, including that no front exists;
   `thread.launch` with `dispatchGuard` repeats the check right before sending.

## Route (`t3_ambientes` + `route`)

Input: `candidates` (1-10, one per environment, each with that environment's `projectId`,
`modelSelection` and `runtimeMode`), optional `front` + `discoveryEnvironments`,
`constraints.allowedEnvironments`, `constraints.requiredPlatform`,
`affinity.preferredEnvironments` and `affinity.bindings` (`environment`, `projectId`,
`worktreePath?`, `branch?`).

Hard filters (any failure makes the candidate ineligible, with `reasons`):

| Filter | Source | Refusal |
|---|---|---|
| environment allowed and answering | caller, environment | `environment_not_allowed`, `environment_unavailable` |
| project live and authorized | shell | `project_unavailable` |
| instance `enabled`, `installed`, `status: ready`, `auth.status: authenticated`, not `availability: unavailable` | `server.getConfig` | `provider_unavailable` |
| `supportedRuntimeModes` includes the mode | `server.getConfig` | `runtime_mode_unsupported` |
| exact model slug, options in its option descriptors | `server.getConfig` | `provider_model_unavailable`, `model_option_unsupported` |
| any of these facts missing | `server.getConfig` | `capability_unknown` |
| `requiredPlatform` (no source in this connector) | — | `insufficient_evidence` |

Eligible candidates with a known load are ranked by, in order: workspace affinity observed (a
binding's `worktreePath` is the project root or a thread's worktree), branch affinity observed,
index in `preferredEnvironments`, `inFlight` (running + background_pending threads of the
workset, counted before truncation), `needsIntervention`, `unknown`, `environmentId`. The answer
carries `orderKey`, `rank` and `reasons` per candidate.

`decision`: `recommend_environment` (with `recommendedEnvironmentId`), `continue_existing` or
`choose_target` (the front exists: `existingTargets`), `inconclusive` (an uncovered front, an
unknown capability or a failed environment) or `no_eligible_environment`. It is
`recommendation_only`.

## Front lookup (`t3_thread_find_batch`)

A query may be `{key, selector, relations?, limit?, cursor?}`. The selector is a logical AND of
`threadId`, `title` (`exact` by default or `partial`), `branch`, `worktreePath`, `pullRequest`
(`host`, `repository`, `number`, matched against the URL of linked PRs) and qualified
`projectIds`; at least one key besides `projectIds`.

- `population: "all"` adds the archived snapshot when it has the same sequence as the active
  shell and every row is valid; otherwise `archived_source_unavailable`,
  `archived_sequence_mismatch` or `archived_source_invalid`, and absence is unproven.
- A field the shell does not carry is `selector_evidence_unavailable`, never a non-match.
- `launchDisposition: candidate_new` needs zero matches with every environment, the whole
  `all` population and every selector field covered. It still authorizes nothing.
- `relations` (`children` or `descendants`, depth up to 4, up to 50 nodes) follow
  `lineage.parentThreadId` inside the candidate's environment and report `lineage_cycle`.

## Review (`t3_workset` `reviewQueue`, `t3_thread` `review`)

`reviewQueue` pages the whole `completed_unsettled` group (before `limitPerGroup`); its cursor
is bound to the environments and their snapshot sequences, and `cursor_snapshot_changed` means
start again and deduplicate. A queue item is not proof of idleness.

`review: true` (with `settlementContractVersion: 2`) adds, from the same observation as
`settlement`: the expected run, the response of that run (never an older run's text; that one
is only `olderResponse`), workspace metadata, linked PRs, related threads from `execution`,
evidence references and `verification.status: caller_required`. `review.complete` is false
when the response is missing, older, truncated or streaming, or the observation is incomplete.

## Protected dispatch (`t3_dispatch_preflight`, `dispatchGuard`)

`t3_dispatch_preflight` takes `environment`, `action` (`thread.launch` or `thread.send`), the
exact write `input` (without `dispatchGuard`), the binding you `expected` and, for launch, a
`duplicateCheck` (`environments`, `population: "all"`, `selector`). It sends, reserves and writes
nothing; `writeAuthorization` is `not_checked`.

- Launch: workspace `root` or an existing approved worktree (`workspace_creation_preflight_unsupported`
  for a new worktree; `workspace_scope_denied`; `workspace_evidence_unavailable` when a branch
  is required); explicit `runtimeMode`; the route's provider filters; and the duplicate check
  (`front_exists`, `front_ambiguous`, `front_discovery_incomplete`).
- Send: the thread binding (`dispatch_project_changed`, `dispatch_workspace_changed`) and the
  blockers of `execution` from a coherent v2 observation (`dispatch_active_run`,
  `dispatch_queued_work`, `dispatch_pending_request`, `dispatch_unresolved_work`).
  `start_immediately` needs `canStartNow` and refuses `onBackgroundWork: "send"`;
  `queue_after_active` needs an active run (`dispatch_no_active_run`); `steer_active` and
  `restart_active` are `delivery_capability_unknown`.

An admissible answer has `inputDigest` and `observationId`. Put them in the write's
`dispatchGuard` (`version: 1`, `expectedInputDigest`, `expectedObservationId`, `expected`, plus
`duplicateCheck` for launch or `expectedRunId` for send). Right before sending, inside the
project lock for a launch, the connector repeats the same preflight and refuses with a
`dispatch_*` code (`dispatch_input_changed`, `dispatch_observation_changed`,
`dispatch_run_changed`, `dispatch_front_exists`, ...) without sending. A refusal replays as
`state: rejected`, `sent: false`, `reconciliationRequired: false`. A new decision needs a new
`operationId`. The guard is never forwarded to T3. A protected launch returns `createdThread`
(also on replay) and `workspacePostCheck: pending`: read the thread for its workspace.

The preflight is an observation, not a lock: another client can still create a thread between
the last read and T3's commit. Unicity across clients, gateways or the T3 UI is not guaranteed.

## Profiles

| Profile | Control-plane tools |
|---|---|
| Read MCP and OAuth reads | `t3_ambientes`, `t3_thread_find_batch`, `t3_workset`, `t3_thread`, `t3_dispatch_preflight` |
| Lease bridge | the same five plus `t3_providers` and `t3_aguardar_thread`, under the lease (never renewed); multi-environment reads use each environment's read projects; `t3_dispatch_preflight` is computed with the lease grant, exactly as the `dispatchGuard`, and only counts candidates in projects you cannot read (`hiddenCandidates`) |
| Writes (bridge and OAuth) | `thread.launch` / `thread.send` with `dispatchGuard`, `thread.settle` with `settleGuard` v2 |

The read MCP and OAuth preflight use the read ACL; the write repeats it with the write grant. If
the two differ, the apply refuses with `dispatch_observation_changed`: read again with the profile
that writes.
