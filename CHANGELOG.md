# Changelog

## Unreleased

## 0.13.0

- Tool descriptions: `t3_escrever_thread_launch` now states that it is the canonical path to open
  a thread on a new branch and worktree (`workspaceStrategy.type: 'worktree'` creates both in one
  call) and that no separate creation tool exists; `t3_worktree_status` and `t3_worktree_list` say
  they are read-only and point to it. Descriptions only; schemas and behavior are unchanged.
- Writes with `modelSelection` (`thread.launch`, `thread.model-selection.set`,
  `provider.switch`, `delegated_task.request`) validate it themselves against the
  environment's `server.getConfig`, read fresh on every write: a client no longer needs
  `t3_providers` first to learn whether an option such as `fastMode` is offered. An
  unsupported instance, model, option or value is refused before sending with a precise code
  (`provider_instance_unavailable`, `provider_model_unavailable`, `model_option_unsupported`,
  `model_option_value_unsupported`, `model_capabilities_unknown`,
  `model_capabilities_unavailable`) and a message naming the offered values, on both the
  lease and OAuth paths. Valid selections are sent unchanged, with no default added.
- New write tool `t3_escrever_thread_conditional_send` (lease bridge and OAuth): "after run
  `afterRunId` ends, optionally apply `modelSelection`, then send `text`" as one request with one
  `clientRequestId`. The precondition (run terminal, still the latest, nothing active) is checked
  before the first step and again right before the send; a run started in between refuses the
  send instead of letting T3 queue it. Steps reuse `thread.model-selection.set` and `thread.send`
  `start_immediately` through the existing dispatch (journal, scope, stable commandId, fail-closed
  uncertainty) under `<clientRequestId>:model-selection` and `<clientRequestId>:send`. A manifest in
  the same journal records every observation and step. Each step's state is read from the write
  journal of its operationId (a step another call still holds, or one without acknowledgement, is
  `uncertain`, never "not sent"); retries never send twice, re-evaluate `precondition_pending` and
  `uncertain`, and replay a final answer only while the journal agrees with it. "Not sent" is
  stated only for a step whose journal record is a refusal: before concluding it, the request
  reserves the step's operationId as refused (atomic, like the Dispatcher's own reservation), so no
  later write sends under it; a refusal that leaves no record refuses the call instead. A replayed
  negative answer recorded without that refusal closes the steps first or is rebuilt as uncertain. Concurrent
  duplicates share one execution, and the
  result states `precondition_pending | precondition_failed | failed | uncertain | completed`, with
  `delivery.deliveredAs` from the run T3 created. No new consented action; existing tools unchanged.
- Read tools: new `t3_thread_read_batch` reads up to 20 threads in one call, each named by
  `{environment, threadId}` (environments can be mixed). Each successful item carries the
  same result as `t3_thread` (state, active/latest run, pending requests, latest response),
  built by the same code. Failure is per item with a code (`thread_not_found`,
  `environment_not_allowed`, `unavailable`, `global_timeout`, ...), so one broken target does
  not hide the others; `allSucceeded` and `complete` summarize. One shell observation per
  environment per call; a repeated target is read once. Available on the read server and the
  OAuth profile, not in the write plugin's lease reads. `t3_thread` output is unchanged. See
  ADR 0006.
- New read tool `t3_control_plane`: a control plane snapshot in one call across every
  configured environment (or only `environment`), each with its own ACL. It returns
  `needsIntervention`, `running` and `ready` lists (ready = latest run completed, failed or
  cancelled and not settled nor snoozed, or woke; with `readyReasons`, `blockers` and
  `actionableNow`). Items carry the `t3_threads` summary plus `environment`, `activeRun`, a
  `pendingRequest` summary from the shell and `next` (the `t3_thread` call). Environments
  that fail or time out are listed in `environmentFailures` with `complete: false` and an
  `incompleteReason`; per-environment `snapshotSequence`, `readAt` and counts by state are in
  `queriedEnvironments`. One shell read per environment, no per-thread read. Existing tools
  are unchanged. The environment sweep lives in `src/varredura.mjs`.

## 0.12.1

- Writes: a typed answer from T3 to a sent canonical action (`OrchestrationV2DispatchCommandError`,
  `OrchestrationV2ThreadLaunchError`, `EnvironmentAuthorizationError`) no longer ends every OAuth
  session (or lease). The operation is journaled `uncertain` with T3's code and message, the tool
  answers `reconciliation_required: ... T3 answered <ErrorTag>: <message>`, a replay and
  `t3_reconciliar_escrita` return the error, and nothing is resent. Before, canonical actions asked
  the transport for untyped errors only, so T3 refusing a command (e.g. `thread.send` to a thread
  that still needs attention) looked like a lost transport and every OAuth session was revoked
  (`write_path_failure`), which cost ChatGPT a manual Reconnect and a passkey sign-in: 4 of the 6
  reconnects in production on 05-06/10/2026. A typed answer is not journaled `failed`, because T3
  may answer it after a commit (e.g. the post-steps of `queue.resume`, or a launch whose thread
  exists). Lost transport, malformed frames, timeouts and journal failures still end every session.
- Writes: typed T3 errors are sanitized at the transport: the tag must be an identifier, `cause`
  (T3's defect chain) and nested fields never leave the frame, `code`/`message` cannot be overridden
  by the payload, strings are clipped to 2000 characters. The lease relay and the stdio bridge carry
  T3's typed code and message.

## 0.12.0

- Read tools: thread summaries add `woke` and `wokeAt`, the "Woke" marker of the T3 sidebar
  (a thread that woke from a snooze and was not acknowledged yet), derived from the shell with
  T3's own rule. `woke` is `null` when the server does not expose the snooze or shared visited
  state. `t3_threads` (and its read under a write lease) accepts an optional `woke` filter.
  Additive: existing fields, `state`, cursors without the filter and other tools' selection are
  unchanged. Reading never acknowledges the marker. Unrelated to delegated task `completionWake`.

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
