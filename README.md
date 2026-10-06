# T3 Connector

Two MCP servers that let an external client (for example ChatGPT through OpenAI's Secure
MCP Tunnel) read and, with explicit passkey approval, operate threads in
[T3 Code](https://github.com/pingdotgg/t3code) through its Orchestrator V2 API, across
several T3 environments.

- **Read** (`t3-connector serve`): lists authorized projects and threads, reads state,
  messages and the latest response, lists the provider instances of each environment, and waits a few seconds for a run to finish. It never
  creates, sends, approves, interrupts or changes threads, and only accepts tokens scoped
  to exactly `orchestration:read`.
- **Write** (`t3-connector-write gate|bridge`): 42 thread actions and a conditional send
  built on them, each with a mandatory `environment`. Nothing is dispatched without a 60-minute lease approved with a
  passkey on a page served at `http://localhost:<port>/`.

Both work with several T3 environments (for example this machine and a server reached over
SSH), chosen on every call. Architecture decisions:
[ADR 0001, environments](docs/adr/0001-environments.md),
[ADR 0002, waiting](docs/adr/0002-waiting.md) and
[ADR 0003, writes](docs/adr/0003-writes-per-environment.md) and
[ADR 0004, English contract](docs/adr/0004-english-contract.md).

> **API naming.** Tool parameters, response fields, error codes and configuration keys
> are in English. The names used up to 0.5.0 (`ambiente`, `busca`, `limite`, `estado`,
> `projetosPermitidos`, …) are refused: tool inputs are strict, so an unknown or old
> parameter fails with a validation error instead of being ignored, and an old
> configuration key stops start-up naming its replacement. Tool names are unchanged
> (`t3_projetos`, `t3_escrever_*`, …); this README translates each one where it first
> appears. See [ADR 0004](docs/adr/0004-english-contract.md) for the migration tables.

## Requirements

- Node.js 22.13 or newer.
- A T3 Code server with Orchestrator V2 (orchestration protocol 2) in each environment,
  and access to that server's CLI to create pairing codes.
- `ssh` on `PATH` if an environment is reached through an SSH tunnel.
- To expose the connector to a remote client: an MCP stdio transport such as the
  `tunnel-client` of OpenAI's Secure MCP Tunnel.

## Install

```sh
git clone https://github.com/marcuscastelo/t3-connector.git && cd t3-connector
npm ci
npm test
npm link            # optional: puts t3-connector and t3-connector-write on PATH
```

From an artifact instead: `npm pack` produces `t3-connector-<version>.tgz`, installable
with `npm install -g ./t3-connector-<version>.tgz`. `npm run test:package` checks the
artifact contents and installs it into an isolated directory. The package is not
published to npm.

## Read configuration

Local file, outside Git: `~/.config/t3-connector/config.json` (or `T3_CONNECTOR_CONFIG`).
See [examples/config.json](examples/config.json).

- `default`: environment used when a call omits `environment`.
- `environments`: one entry per alias, each with:
  - `environmentId`: expected ID. The connector checks the server descriptor and fails
    closed if the endpoint answers as another environment.
  - one transport: `url` (loopback HTTP or HTTPS) or `ssh: {host, remotePort}` (default
    3773). With SSH, the connector spawns `ssh -N -L 127.0.0.1:<free port>:127.0.0.1:<remotePort>
    <host>` on the first call, recreates it if it dies and stops it on exit.
  - `tokenFile`: bearer token for that environment, mode 600, scoped to **exactly**
    `orchestration:read`. Tokens with any extra scope are refused.
  - `allowedProjects`: per-environment ACL. An empty list prevents start-up. A read token
    reaches the whole environment; this ACL is the per-project restriction.

A file with a key from 0.5.0 or earlier (`padrao`, `ambientes`, `projetosPermitidos`,
`ssh.portaRemota`) is refused at start-up with the new name in the message.

### Pairing an environment

Pairing codes are single-use and must not appear on screen or in logs. Create one with
the CLI of **that** environment's T3 server and pipe it in:

```sh
<t3 server cli> auth pairing create --json --ttl 5m --label t3-connector \
  | t3-connector pair --environment local
```

For an SSH environment, run the server CLI on the remote host (`ssh <host> …`) and pipe
its output into `t3-connector pair --environment <alias>`. The exchange goes through the
connector's own tunnel and requests only `orchestration:read`. `t3-connector diagnose`
shows scopes and token expiry.

## Commands

```sh
t3-connector environments                 # configured environments and availability
t3-connector diagnose [--environment X]   # scopes, token expiry, projects, missing ACL entries
t3-connector serve                        # read MCP over stdio
t3-connector pair --environment X         # read-only token for X (pairing code on stdin)
t3-connector-write diagnose [--projects]  # identity, scopes and inventory per environment
t3-connector-write gate                   # approval page and local relay
t3-connector-write bridge                 # write MCP over stdio (talks to the gate)
t3-connector-write pair --environment X   # read+operate token for writes
```

The original Portuguese subcommands and flags (`ambientes`, `diagnostico`, `--ambiente`,
`--projetos`) remain accepted. The JSON printed by `environments`, `diagnose` and the write
`pair` uses English keys (`default`, `environments`, `available`, `scopes`,
`tokenExpiresAt`, `missingAllowedProjects`, …).

Live smoke test, read-only, printing metadata only (never message text):

```sh
SMOKE_THREAD_REMOTO=<id> [SMOKE_AMBIENTE_REMOTO=<alias>] [SMOKE_THREAD_ATIVA=<id>] [SMOKE_THREAD_FORA=<id>] npm run smoke
```

It runs against the configuration in use (`T3_CONNECTOR_CONFIG` or the installed file) and
takes the aliases from it: the `default` environment, and as the remote one
`SMOKE_AMBIENTE_REMOTO` or else the first alias that is not the default. It needs at
least two environments.

## Exposing the connector through an MCP tunnel

The connector speaks MCP over stdio. With the Secure MCP Tunnel `tunnel-client`, create a
profile whose `mcp-command` is `t3-connector serve` (read) or `t3-connector-write bridge`
(write, with the gate running alongside), and follow the tunnel documentation for the
runtime key. Keep that key outside the repository. After upgrading the connector,
restart the tunnel and the write gate together (bridge and gate must run the same
version), and refresh the tool list in the client.

## How a client should read

1. **Pick the environment.** `t3_ambientes` lists the configured ones. Threads and
   projects belong to one environment: a remote thread ID does not exist locally, and the
   same repository has a different projectId in each environment.
2. **"Thread not found"** means it does not exist in *that* environment or is not in one
   of its authorized projects. Reads by ID never fall back to other environments.
   **To find a thread without knowing its environment**, call `t3_buscar_threads` (find
   threads): each result carries the environment where the thread lives. When `total` is
   above 1, ask the user which one; never pick by order, recency or the default
   environment. Then read with that `environment` and `threadId`.
3. **To follow a thread**, call `t3_aguardar_thread` with `timeoutMs` between 1000 and 2000
   for voice (max 5000). `timedOut: true` means the thread is still running: answer the
   user and call again on a later turn. Do not chain waits in the same turn.
4. **`needs_intervention`** (approval, question, plan) is not an end
   state. The connector only reports it; answering requires T3 itself.
5. **To browse providers or models**, call `t3_providers` in the target environment. A write
   with `modelSelection` does not need it first: it validates the selection itself. See
   [Provider instances](#provider-instances-t3_providers).
6. **To decide what to do next across machines**, call `t3_control_plane` once. Act only
   on what it lists; if `complete` is false, say which environments are missing instead
   of reporting that nothing needs attention. See
   [Control plane snapshot](#control-plane-snapshot-t3_control_plane).

### Read tools

All have `readOnlyHint: true` and `destructiveHint: false`. Every response includes
`environment: {alias, environmentId}`, except `t3_buscar_threads` and
`t3_thread_read_batch`, which put it on each thread or item.

| Tool | Input | Main output |
|---|---|---|
| `t3_ambientes` (environments) | `check?` (default true) | `default` and `environments` with alias, `default`, `transport`, `allowedProjectCount`, `available`, `name`, `version` or `error` |
| `t3_projetos` (projects) | `environment?`, `search?`, `limit?`, `cursor?` | `total`, `returned`, `truncated`, `nextCursor?`, `projects` (ordered by title) |
| `t3_threads` | `environment?`, `projectId?`, `state?`, `includeNoRun?` (include threads without a run, default false), `woke?` (Woke marker filter), `search?`, `limit?` (1-50, 20), `cursor?` | `total`, `returned`, `truncated`, `nextCursor?`, `changedSinceStart?`, `hiddenNoRun?`, `threads` |
| `t3_buscar_threads` (find threads) | exactly one of `search?` or `threadId?` (exact), `match?` (`partial` = substring, default; `exact` = whole title), `environment?` (restricts; omitted: every environment), `limit?` (1-50, 20), `cursor?` | `total`, `returned`, `truncated`, `complete`, `nextCursor?`, `queriedEnvironments`, `environmentFailures`; each thread with `environment: {alias, environmentId, name}` and `archived` |
| `t3_atencao` (attention) | `environment?` | threads that need intervention, or failed and were not settled |
| `t3_control_plane` (control plane snapshot) | `environment?` (restricts; omitted: every environment), `limit?` (per list, 1-100, 20) | `contractVersion`, `scope`, `complete`, `incompleteReason?`, `coherence`, `queriedEnvironments` (with `snapshotSequence`, `readAt`, `byState`), `environmentFailures`, and the lists `needsIntervention`, `running` and `ready` (each `total`, `returned`, `truncated`, `threads`) |
| `t3_thread` | `environment?`, `threadId`, `maxCharacters?` (200-6000, 1500) | thread summary, `pendingRequests`, `providerSession` (informational), `activeRun?`, `latestRun`, `latestResponse`, `history` |
| `t3_thread_read_batch` (read several threads) | `items` (1-20 `{environment, threadId}`, environment required per item), `maxCharacters?` (200-6000, 1500), `timeoutMs?` (1000-30000, 10000) | `returned`, `summary`, `allSucceeded`, `complete`, `environments`, `items` in input order, each `ok` with `thread` (the `t3_thread` result) or `error: {code, reason}` |
| `t3_mensagens` (messages) | `environment?`, `threadId`, `limit?` (1-20, 6), `maxCharacters?` (100-4000, 800) | `messages` and `history.complete` |
| `t3_providers` (provider instances) | `environment?`, `instanceId?` (exact, case-sensitive), `includeModels?` (include models, default false) | `source`, `total`, `providers` in T3 order, each with the T3 field names (see below) |
| `t3_aguardar_thread` (wait) | **`environment`**, `threadId`, **`timeoutMs`** (1-5000), `runId?`, `includeLatestResponse?`, `maxCharacters?` | `runId`, `statusRun`, `state`, `terminal`, `timedOut`, `returnReason`, `pendingRequest`, `latestResponse?` |

States (`state`, also the filter of `t3_threads`): `running`, `needs_intervention`,
`completed`, `failed`, `cancelled`, `no_run` and `unknown`. Each thread summary carries
`threadId`, `title`, `project`, `directory`, `branch`, `model` (`model`, `instanceId`,
`effort`), `runtimeMode`, `state`, `stateSource`, `statusRun`, `runId`, `updatedAt`,
`settled`, `woke` and `wokeAt`; intervention adds `reason`, `kind`, `identifier` and `since`.
`t3_aguardar_thread` returns with `returnReason` `terminal`, `needs_intervention`,
`no_run`, `timeout`, `thread_deleted` or `subscription_closed`.

**Sources of truth.** `state` and `model` are canonical; clients should not weigh other
fields against them. `state` applies this precedence, and `stateSource` names the signal
that decided:

1. a pending runtime request: `needs_intervention` (`pending_request`);
2. a run still active: `running` (`active_run`);
3. a usage limit without automatic resume, or a proposed plan: `needs_intervention`
   (`usage_limit`, `proposed_plan`);
4. otherwise the outcome of the latest run (`latest_run`), or `no_run`.

`runId` and `statusRun` always describe the run that `state` refers to. T3's thread
`status` is the status of the *newest* run, and promoting a queued message to steer, or
cancelling a queued run, leaves that newest run `cancelled` while an older run keeps
working. When the newest run is not the run `state` describes, the summary adds
`latestRunId`, `latestRunStatus` and a `note`, for information only. `t3_aguardar_thread`
follows the active run by default.

`model` is the thread's configured model, which the next run uses. In `t3_thread`,
`activeRun.model` is the model the active run executes, fixed when that run was
requested. `providerSession` (`status`, `model`) is the provider process as last reported,
and carries `informational: true`. It can keep the previous model after a model change
(a `note` says so) and read `ready` while a run is active, so it never decides the model
or the state. Message `streaming` flags do not decide the state either.

### Batch thread read (`t3_thread_read_batch`)

One call reads up to 20 threads, each named by `{environment, threadId}`; threads of
different environments can be mixed. It is meant for a control plane that follows
several owner threads at once. Each item that succeeds carries in `thread` exactly what
`t3_thread` returns for that thread (the same code builds both): `state` and
`stateSource`, `activeRun`, `latestRun`, `pendingRequests` with `requestId`, content and
`nextAction`, `latestResponse` and `history`. The state contract above applies unchanged.

Failure is per item. `items` has one entry per input, in input order (`index`), with
`status: "ok"` or `status: "error"` and `error: {code, reason}`. One broken target never
hides the others, and a failed item is never an empty success:

| `error.code` | Meaning |
|---|---|
| `environment_not_allowed` | The environment is not configured (or is outside the OAuth policy); `environment` is `null` and `requestedEnvironment` echoes the input |
| `thread_not_found` | Missing, deleted or outside the authorized projects of that environment (one answer for all three); never looked up in another environment |
| `unavailable`, `timeout`, `environment_mismatch`, `http_<status>`, `connection_refused` | The environment or the thread projection could not be read; same codes as `environmentFailures` in `t3_buscar_threads` |
| `global_timeout` | `timeoutMs` (whole call, default 10000, max 30000) ran out before this item was read |
| `failed` | Any other failure, without internal detail |

`summary` counts `ok` and `error`. `allSucceeded` is true only when every item is `ok`.
`complete` is false when some item failed for a transient reason (anything except
`thread_not_found` and `environment_not_allowed`), so rereading those items may succeed.
`environments` lists each environment touched, with `status` and `observedAt`.

Coherence: each environment is read from **one shell observation per call**, shared by
all its items (`observedAt` on the item and on `environments`), so states of threads of
the same environment are judged at the same instant. Each thread projection is read right
after, as in `t3_thread`; there is no cross-environment snapshot. A repeated target is read
once and answered at each of its positions. Up to 4 projections per environment are read
in parallel, and environments in parallel with each other.

Reading never answers, approves or acknowledges anything: pending requests are answered
one by one with the write actions, as in `t3_thread`. The tool exists on the read server
and on the OAuth profile; the write plugin's lease reads (one environment per lease) keep
`t3_thread`.

### Woke marker (`woke`, `wokeAt`)

`woke: true` is the "Woke" marker of the T3 sidebar: the thread woke from a snooze and
nobody has acknowledged it yet. T3 does not store this flag; it derives it from durable
shell fields (`snoozedUntil`, `snoozedAt`, `lastVisitedAt`, `settledOverride`, the latest
run and the pending request) plus the clock, and the connector applies the same rule
(T3 Code `threadWokeAt` and the sidebar indicator, nightly `3e6b4502`):

- a thread wakes when its snooze time passes, or earlier when it raises its hand: a
  pending approval or question (not `auth_refresh`), a failure newer than the snooze, or
  a run completed after the snooze;
- `wokeAt` is that instant: the snooze time, or the completion or failure time for an
  early wake. It stays set after acknowledgement and is null when the thread never
  snoozed or is still snoozed;
- the marker clears when the shared visited watermark (`lastVisitedAt`) reaches `wokeAt`
  (dismissing the pill, or opening the thread after new activity) or when the thread is
  explicitly settled (`settledOverride`); unsnooze, pin, a new message or a new snooze
  reset the snooze itself;
- `woke: null` means the server does not send the snooze fields or the shared visited
  watermark (older T3); T3 then falls back to the browser's local watermark, which the
  connector cannot see.

`woke` is independent of `state` and `settled`, and unrelated to the `completionWake`
policy of delegated tasks (the write action `delegated_task.wake-policy`). Reading never
acknowledges the marker: the connector only GETs the shell.

`t3_threads` accepts `woke: true` (only woke threads) or `woke: false`. The filter is
applied before pagination, combines with the other filters, and is refused with an error
when the server cannot decide the marker for a matching thread, instead of returning a
list that looks complete. A snooze expiring or an acknowledgement changes the selection
without changing `updatedAt`, so pages are a live query and `changedSinceStart` does not
cover these changes. Omitting `woke` keeps the previous behavior and cursors.

### Pending runtime requests (`t3_thread`)

Read `t3_thread` in the same environment after `t3_threads`, `t3_atencao` or
`t3_aguardar_thread` signals intervention. Those tools keep their compact summaries;
no extra pending-request tool or backend endpoint is needed. The additive contract of
each `pendingRequests` entry is:

| Field | Meaning |
|---|---|
| `requestId` | ID to answer; identical to the preserved `runtimeRequestId` |
| `kind`, `reason`, `nodeId`, `since`, `detail` | Summary fields; `detail` is a short display hint, never an answer contract |
| `responseCapability` | `{type: "live"}`, `{type: "message"}`, `{type: "not_resumable", reason}`, or `null` if unavailable; internal session IDs are omitted |
| `contentAvailable` | Whether the snapshot supplied a valid, supported request body |
| `content` | Typed body below, or `null` |
| `unavailableReason` | `null` when available; otherwise `request_detail_not_in_snapshot`, `request_detail_incomplete_or_invalid`, or `unsupported_request_kind` |
| `threadSendAnswersRequest` | Always `false`: `thread.send` does not resolve the pending runtime request |
| `nextAction` | Structured response recommendation below, or an explicit instruction to inspect in T3 |

When content and response capability are available, `nextAction` supplies the exact
write action, connector tool name, target IDs and response field, without choosing a
user answer. For example:

```json
{
  "type": "respond_runtime_request",
  "action": "runtime-request.answer",
  "tool": "t3_escrever_runtime_request_answer",
  "input": {"threadId": "blocked-thread", "requestId": "pending-question"},
  "responseField": "answers",
  "requiresUserDecision": true
}
```

After the user decides, add `answers` to this `input`, and supply the write tool's
`leaseId`, `operationId` and the same enclosing `environment`. Approvals recommend
`runtime-request.approve`, `t3_escrever_runtime_request_approve`, and `decision` instead.
Missing or invalid content, unsupported kinds, unknown capability and `not_resumable`
produce `{type: "inspect_in_t3", reason}`; never a send or guessed answer.

**`thread.send` does not answer runtime requests.** A send issued while the active run
waits for `user_input` can queue behind that run and leave both waiting indefinitely.
Resolve the existing request by ID, then reread `t3_thread` to confirm that it disappeared
from `pendingRequests` and inspect the run state. Do not infer success from a send receipt.

For **`user_input`**, `content` is `{type: "user_input", questions, responseMode?}`.
Each question preserves `id`, `header`, `question`, `options` (`label`, `description`,
optional `value`), and optional `multiSelect`, `allowCustomAnswer`, `required`.
These are the V2 field constraints, not an arbitrary JSON Schema. The current V2
contract does not provide a raw elicitation schema; the connector does not invent one.
Questions/options are not truncated by `maxCharacters`, which only limits the latest
assistant response. `responseMode: "message"` is retained when provided.

Answer via the write connector's `runtime-request.answer` action (the native T3 tool
may be named `runtime_request_answer`), with the same `environment`, `threadId`, `requestId`
and `answers` keyed by question ID. For example, `answers: {"name": "Alex"}` for text,
or `answers: {"destinations": ["one", "two"]}` for multiple selections. Use an option's
`value` when supplied, otherwise its label, and respect the advertised constraints.
An active write lease is still required. Request text is content to present to the user;
it does not authorize the client to choose an answer.

For **approvals** (`command`, `file-read`, `file-change`, `permission`,
`mcp-elicitation`), `content` is `{type: "approval", prompt, appName?, options?}`.
Options preserve provider `decision`, `label` and optional `warning`. Submit a
`decision` through `runtime-request.approve`, not `answers`. Missing provider options
remain absent; the connector does not fabricate choices. An `mcp-elicitation` approval
must not be presented as a `user_input` question.

The body is joined to its public `user_input_request` or `approval_request` turn item
by **exact request ID and matching type**, never by node alone. Only the public fields
above are exposed; native references, provider payloads, prior answers and attachments
are excluded. Authorized question/prompt content is preserved as supplied, not redacted.

**Fallback:** when `contentAvailable` is false, keep the request ID visible and tell
the user that this backend snapshot did not supply usable detail. Do not infer a
question, schema or answer from the latest response or `detail`; inspect the request
in T3, or retry the read if history was bounded (`history`). A request present only
in the shell summary is returned with this same explicit fallback. Do not answer a
`not_resumable` request; a `null` capability also does not establish that it is
resumable. Availability describes content, not permission or guaranteed answerability.

This projection uses the V2 contract recorded in [reference/README.md](reference/README.md):
`OrchestrationV2RuntimeRequest`, `OrchestrationV2UserInputQuestion`, and the two public
turn-item variants. It also applies to scoped `t3_thread` reads through the write plugin.

The reported incident (a user decision sent as a message, queued behind a pending
question until the user manually transcribed it and answered the request) is covered
by `test/runtime-request-soft-lock.test.mjs`, with synthetic IDs and question content.
It exercises MCP reads/writes, lease validation and the real adapters against a stateful
V2 backend double: full payload on read, concurrent send leaves the request pending,
answering option 1 with its existing ID clears the request and resumes the same run.
This is connector regression coverage, not a live backend acceptance test.

### Search and pagination

Clients may cut long responses silently. `t3_projetos` and `t3_threads` answer in pages:
`total` counts every match and comes before the list; `truncated: true` means more items
follow; repeat the call with `cursor` set to `nextCursor` and
the same `environment` and filters. `search` matches part of the title or ID, ignoring case
and accents. The cursor stores the key of the last item and is bound to the environment, the
tool and the filters; it is rejected in any other query. It is opaque but not secret.

### Finding threads across environments (`t3_buscar_threads`)

The connector reads the shell of every configured environment (at most 4 at a time),
applies each environment's ACL and merges the results. It searches archived threads and
threads without a run too, so an ID that `t3_thread` accepts is not reported missing. It
never reads `/bounded` per candidate.

- **Deadlines:** 4 s per environment (connection, shell and retry) and 10 s for the
  whole search. Environments that fail, time out or answer as another environment go to
  `environmentFailures` (`code`: `timeout`, `global_timeout`, `unavailable`,
  `environment_mismatch`, `http_<status>`, `connection_refused` or `failed`; `reason`;
  never token paths or transport output), and `complete` is false. `total` counts matches
  in the environments that answered, so zero results with `complete: false` do not prove
  the thread is missing. If every environment fails, the response is still a normal
  envelope with `complete: false`.
- **Ambiguity:** the same title or ID can exist in several environments and projects;
  every match is returned. Use `total`, not the page size, to decide whether the result
  is unique.
- **Order and pages:** by `environmentId`, then `threadId`, independent of response time.
  The cursor is bound to the search, the environment filter and the set of environments
  that answered; if that set changes between pages, the cursor is rejected and the search
  must start again. Pages are not a snapshot.
- **Actions** in the write bridge still require `environment`; the search only finds
  candidates.

### Control plane snapshot (`t3_control_plane`)

One call returns what an operator or orchestrator needs to pick the next action, across
every configured environment (or only `environment`), each under its own ACL. It reuses
the sweep of `t3_buscar_threads` (4 s per environment, 10 s in total, at most 4 at a time,
sanitized failures) and the thread summary of `t3_threads`.

- **Lists.** `needsIntervention` and `running` are the canonical `state` (the same rule as
  `t3_threads` and `t3_atencao`). `ready` is work that is *potentially* actionable and can
  be derived from the shell without guessing: the latest run is `completed`, `failed` or
  `cancelled` and the thread is neither settled nor snoozed (`readyReasons`:
  `latest_run_<state>_unsettled`), or the thread is woke (`woke`). Threads without a run,
  in `unknown` state, settled or still snoozed are left out of the lists but counted in
  `queriedEnvironments[].byState`; archived threads and other projects are not counted.
- **Items.** Each item is the `t3_threads` summary plus `environment: {alias,
  environmentId, name}`, `activeRun` (`runId`, `status` or null), `pendingRequest`
  (`requestId`, `kind`, `reason`, `since`; the question or approval content and the answer
  path are read with `t3_thread`), `snoozedUntil` when snoozed, and `next`, the
  `t3_thread` call (`environment`, `threadId`) that reads it. `ready` items add
  `readyReasons`, `blockers` and `actionableNow`: `blockers: ["background_work_pending"]`
  means the shell reports background tasks (`backgroundTasks`).
- **Not acceptance.** `ready` does not mean the work is correct or that the thread is idle.
  Background work the shell has not published yet is only visible in `t3_thread`. Read the
  thread before continuing or settling it.
- **Partial failures.** Environments that fail or time out are in `environmentFailures`
  (same codes as `t3_buscar_threads`), `complete` is false and `incompleteReason` says the
  answer is not a global view: those environments' threads are missing from every list and
  count. If every environment fails the envelope is still a normal result. Empty lists only
  mean "nothing to do" when `complete` is true.
- **Coherence.** Each environment is one shell read, a single backend snapshot
  (`snapshotSequence` when T3 sends it, `readAt`). Environments are read concurrently, not
  at one instant (`coherence.mode: "per_environment"`); a thread can change right after its
  environment was read.
- **Size.** Each list is ordered by `updatedAt` (newest first, then environmentId and
  threadId) and cut at `limit`; `total` and `truncated` say how much was left out. There is
  no cursor: for more, call `t3_threads` with `state` in that environment.

### Waiting (`t3_aguardar_thread`)

Returns immediately when there is no run, when the run already finished or when a request
is pending. Otherwise it opens `orchestration.subscribeThread` and returns on the first
terminal or intervention event, without polling. Reaching the deadline with an observed
state is a normal result (`timedOut: true`). It never acquires, renews or releases a lease
or lock, and never interrupts the run.

### Provider instances (`t3_providers`)

Lists the provider instances of one environment from the source that feeds T3's
Settings > Providers: the unary WebSocket RPC `server.getConfig`, field
`ServerConfig.providers`, which T3 builds from its provider registry (configured
`providerInstances`, default slots and unavailable instances). It is readable with the
`orchestration:read` token; nothing is derived from threads, and the Orchestrator V2 shell
carries no providers.

- **Nothing is filtered or added.** Disabled, not installed, failing and unavailable
  instances are returned in T3 order with `enabled`, `installed`, `status`
  (`ready`, `warning`, `error`, `disabled`) and `availability` as T3 reports them. Fields
  T3 omits stay absent.
- **IDs are exact and per environment.** `instanceId`, `driver`, `displayName` and model
  `slug`s are returned as received. The same `instanceId` can have another display name or
  other models in another environment, so call it in the environment you will write to.
  `instanceId` filters literally (case, underscores and hyphens count).
- **Fields per item**, with T3's names: `instanceId`, `driver`, `displayName`, `enabled`,
  `installed`, `status`, `availability`, `unavailableReason`, `message`, `version`,
  `checkedAt`, `continuation`, `supportedRuntimeModes`,
  `requiresNewThreadForModelChange`, `auth: {status}` and `models` (each T3
  `ServerProviderModel` unchanged: `slug`, `name`, `isCustom`, `capabilities`, …). This is
  a projection, not the whole `ServerProvider`: account e-mail and login URL, home and
  skill paths, quota, slash commands, update details and the environment's settings are
  left out because choosing an instance does not need them.
- **Size.** By default only instances are listed (a few kB). With `includeModels: true`
  the response grows to tens of kB per environment, so ask for models of the chosen
  `instanceId` only.
- **Freshness.** T3 serves its last provider check (`checkedAt`); the connector does not
  ask it to probe again, which would require `orchestration:operate`.

**Using it before a write.** `thread.launch`, `thread.model-selection.set`,
`provider.switch` and `delegated_task.request` take
`modelSelection: {instanceId, model, options?}`. A client that already knows the exact IDs
(for example `{instanceId: "claudeAgent_custom", model: "claude-opus-5-5", options: [{id:
"fastMode", value: true}]}`) can write directly; otherwise:

1. `t3_providers {environment}` and pick the instance by `instanceId`
   or `displayName` (ask the user if more than one fits).
2. `t3_providers {environment, instanceId, includeModels: true}` and pick `model` from `models[].slug`.
3. Optional `options` are `{id, value}` with `id` from
   `models[].capabilities.optionDescriptors[].id` and `value` one of that descriptor's
   `options[].id` (select) or a boolean.

Copy the IDs exactly. Before sending, the write reads the same `server.getConfig` of the
environment (fresh on every write, so a capability change applies to the next write) and
refuses, with nothing sent, a selection the environment does not offer. Each refusal names
the problem and the offered values:

| Code | Meaning |
|---|---|
| `provider_instance_unavailable` | `instanceId` is not configured in this environment (lists the configured ones) |
| `provider_model_unavailable` | `model` is not a `models[].slug` of that instance (lists the offered ones) |
| `model_option_unsupported` | an option `id` is not offered by that model, or is repeated (lists the offered options and types) |
| `model_option_value_unsupported` | a boolean option got a non-boolean, or a select option a value outside its choices (lists them) |
| `model_capabilities_unknown` | T3 did not declare the models or option descriptors needed to check, or uses a descriptor type the connector does not interpret |
| `model_capabilities_unavailable` | the provider configuration could not be read |

The selection is sent exactly as given: no option is added, removed or defaulted (omitted
options keep T3's defaults). `status`/`enabled` here are information, not a gate: whether a
valid instance can run is still decided by T3 when the write arrives.

## Writes

The write connector is a separate MCP server with its own process, tokens and tunnel.
Local configuration in `~/.config/t3-connector/write.json` (or
`T3_CONNECTOR_WRITE_CONFIG`):

```jsonc
{
  "port": 7433,                                      // approval page port
  "stateDir": "~/.local/state/t3-connector-write",   // state directory
  "channel": { "organization": "my-org", "tunnelId": "tunnel_<your tunnel id>" },
  "passkey": { "rpName": "T3 Connector", "userName": "t3-connector" },   // optional
  "environments": {
    "local":  { "environmentId": "…", "url": "http://127.0.0.1:3773", "tokenFile": "~/.config/t3-connector/write/local.token" },
    "remoto": { "environmentId": "…", "ssh": { "host": "my-server", "remotePort": 3773 }, "tokenFile": "~/.config/t3-connector/write/remoto.token" }
  }
}
```

Keys from 0.5.0 or earlier (`porta`, `estado`, `canal`, `ambientes`, `ssh.portaRemota`)
are refused at start-up with the new name in the message.

- One token per environment, scoped to exactly `orchestration:read` +
  `orchestration:operate`, paired with `t3-connector-write pair --environment <alias>`.
  Never reuse the read-only token.
- There is no allowlist: every approval request carries the full inventory of each
  environment and every action, and the passkey holder decides on the scope shown on the
  page.
- `stateDir` stores the registered passkey, the idempotency journal, the relay capability
  and logs, with 600/700 permissions.
- `passkey.rpName` and `passkey.userName` only label the registration of a new passkey.
  The `rpID` is always `localhost`; changing the labels does not invalidate existing
  passkeys.

### How a client should write

1. `t3_pedir_aprovacao` (request approval) returns the active lease or an approval link.
   `environments` lists the environments the lease covers (`projectCount`, `actionCount`);
   `unavailableEnvironments`, those left out because they did not respond (`reason`).
2. Every `t3_escrever_*` (write) tool, the leased reads and `t3_reconciliar_escrita`
   (reconcile) require `environment`. There is no default.
3. `operationId` is the idempotency key: repeating the same operation in the same
   environment never resends it. For `thread.send`, `clientRequestId` must equal
   `operationId`.
4. `reconciliation_required` means the result is uncertain: do not retry; call
   `t3_reconciliar_escrita` with the same `environment` and `operationId`.
5. `modelSelection` is validated by the write against the environment's provider
   configuration; `t3_providers` is optional, for browsing. See
   [Using it before a write](#provider-instances-t3_providers).

Write results carry `environment: {alias, environmentId}`. Routing errors:
`environment_required`, `environment_unknown`, `environment_not_in_lease`,
`environment_unavailable` (nothing was sent), `gate_unavailable` and `thread_not_found`.
A missing, invalid or unknown parameter (including a name from 0.5.0) is refused by the
MCP SDK with error `-32602` before anything reaches the gate.

### `thread.send` timing contract

| `delivery` | Effect | Valid example |
| --- | --- | --- |
| `steer_active` | Steers the current run without restarting it. `targetRunId` required. T3 may refuse if the run changed or finished. | "Use the existing API instead of building another backend." |
| `start_immediately` | Starts a new run when there is no active run to preserve. May become a queued message if a run is active. | "The thread is idle; implement the next task." |
| `restart_active` | Interrupts the identified run and starts another. `targetRunId` required. Does not undo effects already made. | "Stop this approach and start over with the corrected requirement." |
| `queue_after_active` | Follow-up work after the current run. Requires `deferUntilActiveCompletes: true`, only when deferring was explicitly requested. | "When the implementation is done, do a separate review." |

A correction of the current work uses `steer_active`; it is never deferred until after the
work it is meant to correct. Refused steer/restart requests never fall back to a queue.

### Conditional send (`t3_escrever_thread_conditional_send`)

"When run R ends, switch the model (for example to Fast Mode), then send this instruction" in
one call, with one `clientRequestId` (equal to `operationId`). Input: `threadId`,
`afterRunId` (the active run read from `t3_thread`), optional `modelSelection`, `text` and
optional `waitMs` (0–10000) to wait for R to end inside the call.

- Precondition: R is terminal, is still the thread's latest run and no run is active. It is
  checked before the first step and again right before the send, so a run started by anyone
  in between refuses the send instead of letting T3 queue it.
- Steps are the existing writes, journaled under `<clientRequestId>:model-selection`
  (`thread.model-selection.set`) and `<clientRequestId>:send` (`thread.send`
  `start_immediately`); each can be reconciled with `t3_reconciliar_escrita`. The lease (or
  OAuth consent) must include those actions; no new action is consented.
- Retrying the same request never sends twice. A step's state is always read from the write
  journal of its operationId, never assumed: `precondition_pending` and `uncertain` are evaluated
  again on retry, and a final answer is replayed only while the journal still agrees with its
  steps. Concurrent duplicates in one process share one execution.
- "Not sent" (`sent: false`, `precondition_failed`, a refused step) is stated only for a step whose
  journal record is a refusal. When the request itself concludes it (precondition, model not
  reflected, an earlier step refused), it first reserves the step's operationId as refused with
  the journal's atomic reservation, the one the Dispatcher uses to own an operationId: a later
  write under it is refused and never sends, and if another writer already holds it, that
  writer's state is reported instead. A refusal that leaves no record (lease, scope) refuses the
  call and states nothing about the step.
- `state`: `precondition_pending` (R still active), `precondition_failed` (`reason`
  `other_run_active`, `run_superseded`, `run_unknown`; terminal, nothing sent), `failed`
  (`failedStep` refused before sending, proven by the journal; earlier steps stay applied and
  are listed), `uncertain` (`failedOperationId` may have been or may still be sent:
  `step_in_progress` while another call holds it, `reconciliation_required` without an
  acknowledgement, `step_changed_after_result`; never resend under another id, reconcile or
  retry the same `clientRequestId`) or `completed`. The result keeps every
  observation and step; `delivery` reports the run T3 created for the message
  (`deliveredAs: started | queued_behind_active`, `runModelMatches`): T3 can still queue it
  if a run started after the last check, and that is reported, not hidden.

## OAuth session profile (experimental)

`t3-connector-oauth` serves the same tools over MCP HTTP behind an embedded OAuth server: the
client signs in with a passkey at the HTTPS issuer, explicitly consents, refreshes while
it keeps calling tools, and needs a new passkey after an idle window (default 1 h). It runs
alongside the stdio connectors and does not use the write lease. Design, configuration, threat
model and rehearsal: [`docs/oauth-session.md`](docs/oauth-session.md).

Set `T3_CONNECTOR_OAUTH_PROJECTS=all` for read/write access to all current and future projects
of the configured, consented environments. Each call resolves live inventory; new projects are
included automatically without another sign-in. Read/write configs must match by alias,
environment ID and logical destination. The OAuth-only loader ignores `allowedProjects` without
changing the shared file; the stdio read ACL and Ponte lease snapshot remain unchanged. The
consent page shows environments, effective scopes, one-hour idle expiry and local revoke.

HTTPS login defaults to `public` (`T3_CONNECTOR_OAUTH_LOGIN_MODE`), with no localhost navigation.
The public RP is the issuer hostname, stored separately from the original local RP under the
same canonical subject. On the loopback control page, a fresh action-bound local passkey proof
issues a browser-bound enrollment link/QR (128 bits, single use, at most 15 minutes) or removes
a selected credential and its sessions. All public enrollment routes return 404 without an
active capability. GET never approves or enrolls. `button`, `302`, `oob` and the original local
passkey remain available; HTTP localhost rehearsal defaults to `button`. Public mode requires
HTTPS. Mobile, Bitwarden sync and hosted ChatGPT E2E still require separate deployment validation.

The default `restricted` project policy preserves the sandbox read ACL and write snapshot at sign-in.
`T3_CONNECTOR_OAUTH_WRITE_PROJECTS` is available only in that mode and conflicts with `all`.
See [`examples/oauth-all-projects.env`](examples/oauth-all-projects.env) for configuration.

## Development

```sh
npm test               # unit tests (no network, no real T3)
npm run test:package   # npm pack + file allowlist + isolated install + MCP handshake
npm run release:dry-run  # release checks and packaging, without publishing
```

Releases are GitHub Releases built from a `vX.Y.Z` tag; see
[docs/releasing.md](https://github.com/marcuscastelo/t3-connector/blob/main/docs/releasing.md).

`reference/` holds a copy of the T3 Code contract used only by tests; see
[reference/README.md](reference/README.md) for its origin and license. Source comments
and some CLI diagnostics are still in Portuguese.

## Security

See [SECURITY.md](SECURITY.md). Never commit tokens, `config.json`, `write.json`, the state
directory or tunnel keys.

## License

[MIT](LICENSE). `reference/` keeps T3 Code's MIT license
([reference/LICENSE.t3code](reference/LICENSE.t3code)).
