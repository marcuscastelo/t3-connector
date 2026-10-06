# Changelog

## Unreleased

- Fixes from the independent review of the control-plane candidate: `t3_aguardar_thread`
  `until: "execution_idle"` decides nothing before the subscription's `synchronized` marker
  (and reports `synchronized`); a settlement observation is complete only when the shell
  describes the same thread version and binding as the full snapshot (a lagging shell, another
  worktree or an edited message refuses the guard); batch results survive item keys such as
  `__proto__` or `constructor`; route/preflight check option values by descriptor type
  (`select`, `boolean`; any other type is `capability_unknown`); the front lookup treats a
  malformed active row as incomplete coverage (`active_source_invalid`). Thread versions are
  proven only by two strict, valid and equal ISO instants (an impossible date never proves
  one); selector evidence that is missing or malformed (title, branch, worktree, pull request,
  lineage) keeps a lookup inconclusive, for `selector` and for v1 `search`; the same thread in
  the active and the archived snapshot with any differing field is `population_conflict`.
  `execution_idle` without a valid projection instant waits the full quiet period, and batch
  `snoozedUntil` refuses impossible calendar dates. Instants compare exactly (nanoseconds, own
  calendar arithmetic, years 0000–9999); `deletedAt`/`archivedAt` must be valid instants for a
  row to count as deleted or archived; every row with the same thread ID, also within one
  source, must agree or the population is incomplete; background work seen in several sources
  keeps the evidence that holds the thread; the legacy lookups (`t3_buscar_threads`,
  `t3_thread_find_batch` without the version) no longer report `not_found`/`complete` over rows
  without a text title or malformed rows (well-formed answers are unchanged). Malformed
  background evidence (a roster task without `taskId`, a turn item or subagent outside the
  contract's statuses or without identity, a roster that is not a list) makes background
  knowledge `unknown`, so nothing proves the thread idle; repeated, diverging shell rows of the
  target thread make the settlement observation incomplete (`thread_rows_conflict`) and the
  thread reads fail instead of picking the first row; rows are compared canonically, so
  equivalent instants (`Z` vs offset) are not a conflict. One validation boundary for the
  thread projection (`src/validacao.mjs`): anything outside the V2 contract adds the canonical
  blocker `execution_evidence_invalid` (settle incomplete, preflight refused, `execution_idle`
  never returns, legacy `thread.send` `start_immediately` refused); shell rows of the target are
  checked for conflicts before the ACL cut and by every ID lookup (project resolution of
  writes, guarded reads, workset); only time fields compare by instant. The boundary also
  checks every turn item (identity, one of the contract's 26 types, a known status) and
  requires the lists idleness depends on (`runs`, `runtimeRequests`, `turnItems`,
  `subagents`, `plans`); a shell row outside the contract is invalid data, not a lagging shell,
  and the `projection_only` fallback keeps every invalid fact the observation saw and checks
  the projection belongs to the thread. An active plan blocks when either the projection or
  the shell shows it. Catalog lookups (projects, provider instances, models, option
  descriptors; native project reads) no longer pick the first of repeated, diverging rows:
  route and preflight answer `project_unavailable` / `capability_unknown` with
  `reason: catalog_conflict`, native reads `project_conflict`.
- Control-plane v1, live validation fixes: an absent or empty `supportedRuntimeModes` now counts
  as every mode supported, which is T3's own runtime rule (codex and claudeAgent instances do
  not declare the list); a declared list without the mode is still refused. On the write side
  (lease bridge and OAuth dispatchGuard) providers are read over the read WS, because the write
  transport refuses `server.getConfig` (`rpc_unavailable`), which made every protected launch
  inadmissible.
- Control-plane v1, profile parity: the lease bridge offers `t3_ambientes`,
  `t3_thread_find_batch`, `t3_workset` (over every environment of the lease, each with its own
  read projects), `t3_providers`, `t3_aguardar_thread` and `t3_dispatch_preflight`, with the
  exact parameters and descriptions of the read tools; the lease is checked before and after
  and never renewed. The bridge's preflight is computed with the lease grant, exactly as the
  `dispatchGuard`, and only counts candidates in projects that cannot be read. The bridge now
  lists 55 tools (was 49). New guide: `docs/control-plane.md`.
- Control-plane v1, protected dispatch: new read tool `t3_dispatch_preflight` checks a
  `thread.launch` or `thread.send` without sending or reserving anything (inputDigest,
  observationId, reasons; `writeAuthorization: not_checked`). Launch needs workspace `root` or an
  approved existing worktree (creating one is `workspace_creation_preflight_unsupported`), an
  explicit runtimeMode, an eligible provider (same filters as the route) and a `duplicateCheck`
  with population `all` that finds no front. Send takes its blockers from execution (v2
  observation); `queue_after_active` needs an active run; steer/restart are
  `delivery_capability_unknown`. `thread.launch` and `thread.send` accept `dispatchGuard`
  (version 1): the connector repeats the same preflight right before the send, inside the project
  lock for launch, and refuses with `dispatch_*` codes (nothing sent, replay is a known result).
  A protected launch returns and replays `createdThread`. The guard is never forwarded to T3;
  without it both writes are unchanged.
- Control-plane v1, review: `t3_workset` with `reviewQueue` (group `completed_unsettled`) pages
  the whole group before `limitPerGroup`, with a cursor bound to the environments and their
  snapshot sequences (`cursor_snapshot_changed` when they move) and the next read per item.
  `t3_thread` with `review: true` (plus `settlementContractVersion: 2`) adds a review packet from
  the same observation: the expected run, the response attributed to that run (never an older
  run's text), workspace, linked PRs, related threads from `execution`, evidence references and
  `verification.status: caller_required`. A missing, stale, truncated or streaming response makes
  `review.complete` false.
- Control-plane v1, route: `t3_ambientes` with `controlPlaneContractVersion: 1` and `route`
  recommends where to start new work. Hard filters: environment allowed and answering, project
  authorized, provider enabled, installed, `ready`, authenticated, with the runtime mode and the
  exact model/options declared (anything missing is `capability_unknown`; a required platform
  is `insufficient_evidence`). Order: workspace affinity, branch affinity, explicit preference,
  inFlight (running + background_pending threads from the workset), needs_intervention, unknown,
  environmentId. An existing front wins (`continue_existing`); an ambiguous or uncovered one
  gives `choose_target`/`inconclusive`. Recommendation only: nothing is launched or moved.
- Control-plane v1, front lookup: `t3_thread_find_batch` with `controlPlaneContractVersion: 1`
  accepts structural selectors (title, branch, worktree path, pull request by host/repository/
  number, qualified project IDs, thread ID; all must hold), `population: "all"` (active threads
  plus the archived snapshot of the same sequence) and lineage `relations` (children or
  descendants, cycles reported). Each result adds `coverage`, `reasons` and `launchDisposition`;
  `candidate_new` needs zero matches with every environment, the whole population and every
  selector field covered. A field the shell does not carry is `selector_evidence_unavailable`,
  never a non-match. Without the version the answer is unchanged.
- Settlement and settle guard version 2 (`t3_thread` `settlementContractVersion: 2`,
  `thread.settle` `settleGuard.version: 2`): blockers are the codes of
  `execution.continuation.blockers` from the same full snapshot (the shell can only add one),
  so unknown background work, a plan known only from the projection and a self-resuming usage
  limit block a guarded settle; `obs2_` ids also change with the workspace, the reviewed response
  text and the background work. The guard is evaluated against an observation of its own
  version and the post-check reports that version. Version 1 is unchanged.
- One coherent acquisition for decisions: the `thread.send` preflight now derives `execution`
  from the settlement observation (shell → full snapshot → shell), so it sees the usage limit,
  the proposed plan and the shell's background roster; a thread that keeps changing falls back
  to the latest full snapshot (`coherence.status: projection_only`). In OAuth all-projects mode
  the coherence reads of `t3_thread` read the shell again instead of the call's cached inventory,
  so a change between the reads is detected.
- Fix: replaying `thread.launch` or `thread.fork` with the same `operationId` now returns the
  recorded receipt (the created `threadId`), so a caller that lost the first answer recovers the
  thread without launching again. Nothing is sent on replay.
- Composition of the orchestration slice with `execution`: `execution` is the single source of
  in-flight work. `settlement` (opt-in on `t3_thread`) and the `settleGuard` take background
  blockers from `execution`, derived from the same full snapshot, so a monitor or subagent
  hidden by the shell's post-turn gate now blocks a guarded settle; a background command (dev
  server) no longer does. The shell's roster can only add a blocker. A server without a roster
  adds the warning `background_work_unknown`. `t3_workset` puts a thread in
  `background_pending` only when its background work holds the thread
  (`backgroundHoldsThread`).
- Read tool `t3_workset`: one call returns every thread that still needs a decision across
  all configured environments (or `environments`), in disjoint groups (needs_intervention,
  running, background_pending, unknown, snoozed, failed_unsettled, completed_unsettled,
  cancelled_unsettled) with compact references and no conversation text. `actionable` and
  `inFlight` give the active queue directly: settled idle, future-snoozed and archived threads
  are left out, while a pending request, an active run or background work keeps a thread in.
  Archived threads are reported apart (`archived.available: false` until a validated source
  exists). A failing environment is listed in
  `environmentFailures` with `complete: false`; the other environments' threads are kept.
- `t3_thread` accepts `settlementContractVersion: 1` (read connector, lease bridge and OAuth).
  It then builds the whole answer from one validated observation of the full thread snapshot
  and adds `settlement` from that same observation: objective blockers (pending
  request, active run, queued work, unresolved work, incomplete observation),
  `eligibleMechanically`, `observationId`, `expectedRunId`, lifecycle fields with
  availability, and warnings. Without the parameter the answer is unchanged.
- `thread.settle` accepts an optional `settleGuard` (version 1: `expectedRunId`,
  `expectedObservationId`, `acceptance`). The connector observes the thread again right before
  sending and refuses with `settle_*` codes, sending nothing, when something blocks the settle
  or the thread changed; replaying a refusal needs no reconciliation. After the acknowledgement
  it reports `settlement.postCheck` (verified only with a read at or after the receipt sequence;
  mismatch; unavailable), kept for replays; a replay before it is recorded returns the receipt
  with `postCheck: pending`. The guard is never forwarded to T3.
  Without it, settle is unchanged. See `docs/orchestration-bfs.md`.
- Read tools: `t3_thread` adds `execution` (contract version 1), derived from one thread
  projection read. It correlates the latest, active, latest-executed and queued runs; the
  latest response and its `relation` to those runs; pending requests; the provider session;
  and provider background work (`background.pending` with `holdsThread`, and
  `background.endedSinceLatestRun`). It adds safe signals (`responseStale`,
  `backgroundWorkActive`, `backgroundWorkHoldsThread`, `backgroundWorkEndedUnconsumed`,
  `latestRunHasNoAssistantResponse`, `operationallyIdle`) and `continuation` (`canStartNow`,
  `blockers`, `reasons`, `recommended`, target `same_thread`). Background work is read without
  the shell's post-turn gate, which hides it while a run is active. `coherence` compares the
  shell with the projection (version, latest run, active run, pending request) and reads them
  again once when they differ. See `docs/execution-snapshot.md`.
- `t3_aguardar_thread` accepts `until: "execution_idle"`, which waits until no run is active or
  queued, nothing is pending and no background work holds the thread, stable for 1.5 s. It
  returns `execution` and `backgroundClearedDuringWait`.
- `thread.send` with `start_immediately` now refuses before sending while provider background
  work holds the thread. It returns `state: "rejected"`, `sent: false`,
  `refusal.code: "background_work_active"` and the `execution` snapshot. `onBackgroundWork:
  "send"` skips the check. A failed preflight read refuses with
  `execution_snapshot_unavailable`.
- Batch thread operations ([docs/batch-operations.md](docs/batch-operations.md)). New read tool
  `t3_thread_find_batch`: up to 50 title/ID queries over one shell read per environment. Each
  query reports its own `resolution` (`resolved`, `ambiguous`, `not_found`, `inconclusive`),
  coverage and cursor, and never picks a candidate. New OAuth write tool
  `t3_thread_inbox_update_batch`: snooze or unsnooze up to 20 exact `(environment, threadId)`
  targets with `expectedProjectId`, one result per item. Each item uses the existing Dispatcher
  and journal. Execution is sequential and best-effort, and the batch stops on an uncertain send,
  a journal failure, a closed session, the deadline or a cancellation. A durable manifest per
  `batchId` makes repeating the same call return the recorded results without resending. Existing
  tools are unchanged. `t3_buscar_threads` now shares its per-environment read with the batch
  search, with the same output.
- Project deletion (opt-in, `T3_CONNECTOR_OAUTH_PROJECT_ADMIN=1`): the connector-side risk is
  reduced; the T3 backend window stays documented as residual risk.
  - The count validates more of each row (`activeRunId`, `activityRunStatus`, object-only
    `pendingRuntimeRequest`), requires a well-formed project list in the same read, and refuses a
    thread attributed to two projects. It reports `projectLive` and `threadsDigest`.
  - `busy` also counts an active run ID, an activity status and any unknown status.
  - `project.delete-force` requires `expectedThreadsDigest` from the count: the same total with other
    threads is refused (`project_threads_changed`). Both deletes refuse a project the final read no
    longer lists (`project_gone`).
  - Journal: the completed record carries `postCheck: "pending"` until the post-check is stored; a
    replay after a restart takes it (`postCheckOnReplay`). A refusal before the send is replayed with
    `sent: false` and its `refusal` code. A completed record is never downgraded.
  - With the flag off, project actions and the count are refused even for a consent that lists them.
    Consent text names empty-only deletion when force is not offered.

## 0.11.2

- Read tools: one source-of-truth contract for thread state and model. `state` now gives an
  active run precedence over the newest run's outcome. Before, a queued message promoted to
  steer (or a cancelled queued run) made T3 report the newest run as `cancelled`, and the
  connector returned `state: cancelled` (with the active run's `runId`) while the original run
  was still working. Summaries add `stateSource`. They also add `latestRunId`, `latestRunStatus`
  and a `note` when the newest run is not the one `state` describes. `t3_aguardar_thread`
  follows the active run by default. `t3_thread` adds `activeRun` (with its model) and takes
  `latestRun` from the thread shell. It now picks `providerSession` the way T3 does: same
  instance, most recent. `providerSession` is marked `informational: true`, with a `note` when
  its model lags the thread's model after a model change. Tool descriptions state the precedence.
- Internal: the OAuth session profile (authorization server, MCP resource server, sessions,
  passkeys, control plane, audit, configuration loader) moved to `packages/mcp-connector-kit` 0.2.0,
  shared with the Fleet Connector. `src/oauth/*` keeps the same exports; the T3 Connector passes
  its names (cookies, pages, metadata, passkeys), `T3_CONNECTOR_OAUTH_*` variables, project options
  and consent wording, so behavior, cookies and configuration are unchanged. The package check
  now also runs an OAuth rehearsal from the installed artifact.
- Internal: the strict tool registration, JSON result and error mapping of the read MCP now come
  from `packages/mcp-connector-kit` (0.1.0), a package with no T3 knowledge shared with the Fleet
  Connector. It is bundled in the `t3-connector` tarball; tools, schemas and messages are unchanged.
- `thread.launch`, `delegated_task.request` and `thread.runtime-mode.set` now accept the four
  native T3 `runtimeMode` values. Omitting the field preserves the existing `full-access` default.
  Tool descriptions and the consent text now present `full-access` as the authorization ceiling.

## 0.11.1

- OAuth: an expired Client ID Metadata Document cache (10 min) is now served while one refetch
  runs in the background, for up to 24 h. A transient refetch failure (network, timeout, HTTP
  status, unparseable body) keeps the copy and is audited as `client_refetch_failed`; a document
  that arrives but no longer validates drops it. Before, a single slow response from
  chatgpt.com failed the token refresh and ChatGPT ended the connection, requiring a new
  passkey login. A forced load (unknown `kid`) still waits for the network.

## 0.11.0

- `thread.launch` accepts `workspaceStrategy` `{type: 'worktree', baseRef, branch?, startFromOrigin?}`
  and forwards it to T3 as is (it was refused with `workspace_plan_required`); `root` and
  `existing_worktree` (path still verified against an approved root) are unchanged.
- OAuth (opt-in, `T3_CONNECTOR_OAUTH_NATIVE_TOOLS=1` with `PROJECTS=all`): thin wrappers over
  native T3 MCP tools the connector did not cover, under the native names: 10 reads and 8 writes
  (project create/update/clone, environment preferences, scheduled tasks). Native arguments and
  results are kept and typed T3 errors are returned as answered. The calling context is an
  explicit `threadId` or `projectId`. Attachments, thread_read, thread PR listing and
  thread_update are not wrapped (reasons in docs/oauth-session.md).

- OAuth (opt-in, `T3_CONNECTOR_OAUTH_PROJECT_ADMIN=1` with `PROJECTS=all`): full project thread count
  (`t3_contar_threads_projeto`: active + archived, consistent sequence, never a partial zero), delete
  of an empty project (`force:false`), and forced delete only with `force: true`, confirmation and
  the current count, refused while a thread is busy. The connector reports live threads left on a
  deleted project, a T3 backend race it cannot prevent. Moving threads between projects is out of
  scope (no native T3 support). Existing catalogs and consents are unchanged.

## 0.10.0

- New read tool `t3_providers`: lists the provider instances of one environment from
  T3's `server.getConfig` (the source of Settings > Providers), with `orchestration:read`.
  Instances come in T3 order with exact IDs, including disabled and unavailable ones, and
  each item keeps T3's field names: identity, state, runtime modes, `auth.status` and
  models with capabilities. Account, path, quota and settings fields are left out.
  Optional `instanceId` (exact) and `includeModels` (default false: instances only). Clients use it to fill
  `modelSelection` for `thread.launch`, `thread.model-selection.set`, `provider.switch`
  and `delegated_task.request`.
- Live smoke test (`npm run smoke`) takes the environment aliases from the configuration
  in use instead of assuming `local` and `remoto`, so it runs against an installed config
  as is; `SMOKE_AMBIENTE_REMOTO` picks the remote environment. The wait on an active
  thread now passes `environment` (it still sent the pre-0.6.0 `ambiente`).

## 0.9.2

- OAuth tunnel mode: `T3_CONNECTOR_OAUTH_ADVERTISED_RESOURCE` advertises an exact, reachable
  resource in the local protected resource metadata while only `T3_CONNECTOR_OAUTH_RESOURCE` (the
  hosted tunnel endpoint, which tunnel-client may not reach) is accepted for authorization, tokens
  and the resource server.

## 0.9.1

- OAuth tunnel setup: opt-in `T3_CONNECTOR_OAUTH_RESOURCE_CAPTURE_FILE` +
  `T3_CONNECTOR_OAUTH_RESOURCE_CAPTURE_MATCH` write a refused `/authorize` resource to a local
  0600 file only when it is a canonical https URL with unreserved path characters and the tunnel ID
  as a whole path segment, to read the hosted tunnel's canonical resource once. Off by default; refusal and hashing unchanged.

## 0.9.0

- OAuth credential saves now publish the persisted key/counter and generation synchronously
  before deletion-intent admission can snapshot them. Deterministic HTTP interleavings prevent
  survivor-counter rollback and lost successful enrollment after final deletion failure/restart.

- Credential-removal recovery: bounded queue admission precedes durable per-RP deletion intent
  and immediate revocation. Failed/pending keys remain disabled across restart and support fresh
  local-passkey retry; other credential writes preserve intents. Local listing distinguishes
  active/pending/failed keys and offers completion, preserving the last usable local key.

- OAuth/all review fixes: isolate read servers/contexts per `tools/call`, including concurrent
  messages in accepted HTTP JSON-RPC batches with distinct, deleted or empty inventories.
  Public and desktop consent derive write actions from offered connections and effective scopes;
  no-write deployments advertise no write capability, with configured idle/max-age. Failure
  regressions assert exact invocation/journal states and no resend of durable operations after
  fresh passkey sign-in, including a reservation that committed before reporting failure.

- Public issuer passkey login (HTTPS default, `T3_CONNECTOR_OAUTH_LOGIN_MODE=public`): independent
  issuer RP/storage sharing the canonical local subject, UV then explicit scope-aware consent,
  cookie/purpose/epoch-bound ≤120 s ceremonies and existing PKCE callback/resume semantics.
  Original local passkey and `button`/`302`/`oob` modes remain; HTTP rehearsal defaults to `button`.
- Local action-bound passkey administration issues temporary browser-bound public enrollment
  links/QRs and removes selected RP credentials with immediate token/session/pending approval
  invalidation. Enrollment is 128-bit, one generation, ≤15 min; all public routes are 404 otherwise;
  replacement/reset/restart/success cancel it, with guarded serialized credential persistence.
- Public ceremony headers/cookies/cross-origin checks, bounded admission/maps/queues/credentials,
  request/crypto/CIMD deadlines, session/token capacity, audit rotation/rejection aggregation and
  software-authenticator race/negative tests. Hosted/mobile deployment remains separately unverified.

- OAuth `T3_CONNECTOR_OAUTH_PROJECTS=all`: environment-based read/write consent for all current
  and future projects, live inventories and isolated scopes per tool invocation (including HTTP
  batches), final ownership/workspace validation before sending, and historical reconciliation
  without requiring deleted projects.
  Consent includes read-only sessions, idle expiry and local revoke. Read/write environment
  divergence and conflicting `T3_CONNECTOR_OAUTH_WRITE_PROJECTS` fail at boot. Restricted sandbox
  mode, stdio read ACL and Ponte lease snapshots remain supported and unchanged.

## 0.8.0

- OAuth session profile: tunnel mode (`T3_CONNECTOR_OAUTH_RESOURCE`,
  `T3_CONNECTOR_OAUTH_TUNNEL_PORT`). The MCP resource is served on a loopback listener for an
  OpenAI Secure MCP Tunnel client, bound to the exact resource the tunnel names, while the public
  listener serves only the authorization server. Default routes and tokens unchanged; an
  `/authorize` naming an unknown resource now also logs `authorize_unknown_resource` (hashed). See
  `docs/oauth-session.md` 5.1.

## 0.7.0

- Experimental OAuth session profile, `t3-connector-oauth` (`serve`, `rehearsal`): MCP over
  HTTP with an embedded OAuth authorization server (CIMD clients with `private_key_jwt`,
  code + PKCE S256), passkey sign-in on a local control page, rotating refresh, an idle
  window counted only on tool calls, immediate revoke and a persistent kill switch. Serves
  the read tools and, when configured, the write tools authorized by the session. The stdio
  connectors and the passkey lease are unchanged. See `docs/oauth-session.md`.

## 0.6.0

- **Breaking: English public contract.** Tool parameters, response fields, state and
  return values, search failure codes, write error codes, connector messages and
  configuration keys are English, with no Portuguese alias or duplicate. Parameters:
  `environment`, `search`, `limit`, `state` (`running`, `needs_intervention`,
  `completed`, `failed`, `cancelled`, `no_run`, `unknown`), `includeNoRun`, `match`
  (`partial`, `exact`), `maxCharacters`, `includeLatestResponse`, `check`. Responses: for
  example `ambiente` → `environment`, `proximoCursor` → `nextCursor`, `pedidosPendentes` →
  `pendingRequests`, `proximaAcao` → `nextAction`, `ambiente_fora_da_lease` →
  `environment_not_in_lease`. Config: `default`, `environments`, `allowedProjects`,
  `ssh.remotePort`, `port`, `stateDir`, `channel`. Tool inputs are now strict: an old or
  unknown parameter fails with `-32602` instead of being ignored (an ignored `ambiente`
  used to fall back to the default environment). Old config keys stop start-up naming
  their replacement. CLI JSON (`environments`, `diagnose`, write `pair`) uses English
  keys. Cursors from earlier versions are refused; restart the query. Bridge and gate
  must be upgraded and restarted together. Tool names are unchanged. Full tables in
  [ADR 0004](docs/adr/0004-english-contract.md).

- Release pipeline: pushing a tag `vX.Y.Z` on `main` checks that version, lock, `VERSAO`,
  `VERSAO_ESCRITA` and CHANGELOG agree, runs CI, packs once, checks that exact artifact
  and publishes it with a `.sha256` as a GitHub Release. `npm run release:dry-run` does
  the same locally without publishing. Updating a running connector stays manual; see
  `docs/releasing.md`.

- `t3_thread.pendingRequests` now exposes request IDs, public response capability,
  full user-input questions/options/field constraints, and approval prompts/provider
  decisions. Exact request-ID joins and field allowlists exclude native/session details
  and prior answers. Missing/invalid details and unsupported kinds have explicit
  fallback codes; shell-only pending requests remain visible. Read scopes and write
  authorization are unchanged.
  Structured `nextAction` recommends the answer/approval tool with target IDs and
  response field, or inspection in T3 when it cannot safely recommend a response.
  `threadSendAnswersRequest: false` and tool guidance make explicit that sends do not
  resolve requests. A stateful MCP regression covers a send queued behind user input
  and the existing request's answer resuming the same run.

- New read tool `t3_buscar_threads`: finds threads by title or exact ID without an
  environment, across every configured environment (or one, with `environment`). Each
  result carries `environment: {alias, environmentId, name}`. Deadlines of 4 s per
  environment and 10 s in total; environments that fail are listed in
  `environmentFailures` with `complete: false` instead of failing the search. Ambiguous
  matches are all returned, ordered by environment and thread ID, with a cursor bound to
  the environments that answered. Existing tools and write actions are unchanged and still take one environment.

## 0.5.0

First public release, as **T3 Connector**. Functionally equivalent to the previous
private 0.4.1, with these changes:

- Package, binaries and MCP server names renamed to `t3-connector` and
  `t3-connector-write`. Default paths are now `~/.config/t3-connector/config.json`,
  `~/.config/t3-connector/write.json` and `~/.local/state/t3-connector-write`; the
  environment variables are `T3_CONNECTOR_CONFIG`, `T3_CONNECTOR_WRITE_CONFIG` and
  `T3_CONNECTOR_CMD` (smoke test).
- MCP tool titles and descriptions, schema descriptions, guidance messages, the approval
  page and the documentation are in English. Tool names, parameters, response fields,
  error codes and configuration keys are unchanged.
- English CLI aliases: `environments`, `diagnose`, `--environment`, `--projects`.
- The `thread.launch` schema describes `modelSelection.instanceId` and `model` as exact
  IDs in the chosen environment, with no model enum or allowlist.
- Passkey registration labels (`rpName`, `userName`) are configurable in `write.json`
  (`passkey`), with neutral defaults (`T3 Connector`, `t3-connector`). The `rpID` remains
  `localhost`; passkeys already registered keep working.
- Examples, tests and ADRs carry no identifiers of real machines, projects or accounts.
- MIT license, security policy, CI and a package check (`npm pack`, isolated install,
  MCP handshake).

## Earlier history (summary)

- 0.4.x: search and cursor pagination in `t3_threads`/`t3_projetos`; explicit timing
  contract for `thread.send` (`steer_active`, `start_immediately`, `restart_active`,
  `queue_after_active` with explicit deferral).
- 0.3.x: writes routed per environment behind a passkey lease; reads resilient to SSH
  tunnel drops.
- 0.2.0: explicit environments, the connector's own SSH tunnel and `t3_aguardar_thread`.
- 0.1.0: read connector for a single environment.
