# OAuth session profile (experimental)

Status: implemented locally and covered by automated tests; **not yet rehearsed end to end with
ChatGPT using this code** (the spike harness was). Nothing here changes `t3-connector` (stdio, read)
or `t3-connector-write` (stdio, passkey lease). Both keep working as before.

Goal: a client such as ChatGPT connects once with OAuth, the user approves the first sign-in with a
passkey (WebAuthn, user verification) at the HTTPS issuer, explicitly consents, and then reads
and writes through one MCP resource over HTTP. Rotating refresh keeps the connection alive without
interaction while the client keeps calling tools. After a configurable idle window (default 1 h)
without tool calls, the next call needs a new passkey sign-in. Revocation and the kill switch are
immediate.

## 1. Smallest end-to-end increment (what exists)

| Piece | File | Notes |
|---|---|---|
| Session authority | `src/oauth/session-authority.mjs` | Server-side source of truth. Idle window, optional max age, revoke, revoke all, kill switch. Monotonic + wall clock: elapsed time accumulates per observation, adding the larger advance of the two clocks and never a negative one, so suspend and wall rollback cannot give back counted time (when the clocks diverge it can count slightly more, expiring early). An interval nobody observed, e.g. suspend and rollback both while idle, cannot be reconstructed. Terminal states never revive. |
| Token store | `src/oauth/token-store.mjs` | Single-use codes (60 s), opaque access tokens (default 60 s, truncated to the idle deadline), rotating refresh tokens (24 h per generation). Used codes and consumed refresh tokens stay as tombstones until their session ends, so reuse ends the session at any time. Only HMACs of token values are stored. `redirect_uri` at `/token` is checked when sent and may be omitted (OAuth 2.1 with PKCE); the authorization request always requires the exact registered callback. |
| Client registry | `src/oauth/clients.mjs` | Allowlisted CIMD clients only. `private_key_jwt` verified against the document's JWKS (ES256, RS256, PS256): signature, `iss`=`sub`=client, `aud`, numeric `exp` with at most 10 min of remaining validity, and when `iat` is present (it is optional in RFC 7523) at most 10 min from `iat` to `exp`; malformed time claims refused; `jti` replay cache; key rotation (one refetch on unknown `kid`). Client documents are read as a stream and cut at 64 KiB. No `none`, no secrets, no DCR. |
| Authorization server | `src/oauth/authorization-server.mjs` | Metadata (also served at `/.well-known/openid-configuration`, which ChatGPT probes), `/authorize` (code + PKCE S256 only, exact callback, single resource, unknown scopes dropped, explicit request with no supported scope refused), `/resume`, `/token`, `/revoke`. RFC 9207 `iss` on every callback. |
| Login transactions | `src/oauth/transactions.mjs` | Server-side state of each sign-in. The browser only carries opaque handles; the resume handle exists only after a verified passkey and still needs the transaction cookie. 5 min TTL, at most 128 live transactions. Public lookup needs the cookie, mode, epoch and actual map membership. |
| Control plane | `src/oauth/control-plane.mjs` | Loopback only, Host `localhost:<port>`, exact Origin and JSON on every POST. `/login` (passkey approval, shows client, callback host, scopes and the write scope), `/enroll` (ticket printed on the terminal, single use, 15 min), `/` (sessions, revoke, revoke all, kill switch; releasing the kill switch needs a passkey). |
| Public sign-in / enrollment | `src/oauth/public-login.mjs`, `src/oauth/public-enrollment.mjs` | Separate issuer RP, UV then explicit consent, no private inventory before UV; locally authorized temporary browser-bound enrollment. |
| Credential administration / storage | `src/oauth/credential-admin.mjs`, `src/oauth/credential-storage.mjs`, `src/oauth/passkeys.mjs` | Local action-bound UV, independent RP maps/files, canonical subject, bounded serialized verification/mutation and synchronous guarded persistence. |
| Resource server | `src/oauth/resource-server.mjs` | Streamable HTTP, stateless, JSON responses. Global OAuth (initialize and tools/list too). Facade over inner catalogs: scope per tool, activity admitted per `tools/call`, session re-checked before a result leaves. |
| T3 catalog | `src/oauth/t3-tools.mjs`, `src/oauth/session-writes.mjs` | The eight existing read tools and optional write catalog without `leaseId`. OAuth/all authorizes live inventory in consented environments; restricted mode retains the read ACL and write snapshot. |
| Rehearsal tools | `src/oauth/rehearsal-tools.mjs` | `rehearsal_now`, `rehearsal_echo`, `rehearsal_notes` (read) and `rehearsal_note_write` (write, in memory). No backend. |
| Entry point | `bin/t3-connector-oauth.mjs` | `serve`, `rehearsal`, `--version`. |

Two listeners:

- **public** `127.0.0.1:7434` (AS + RS). An HTTPS ingress (reverse proxy or tunnel) forwards the
  public issuer origin to it. The issuer is configuration; `Host` must match it and
  `X-Forwarded-*` is never used.
- **local** `localhost:7435` (control plane). Never exposed through the ingress.

### First access

1. Client calls `/mcp` without a token → `401` with `WWW-Authenticate: Bearer resource_metadata=…`.
2. Client reads the protected resource metadata and the AS metadata, fetches nothing from us for
   registration (CIMD: its `client_id` is an HTTPS URL we fetch only if allowlisted).
3. Browser opens `/authorize`. The AS validates the client document, exact callback, PKCE S256 and
   resource, creates a transaction and sets an `HttpOnly; SameSite=Lax` cookie (`Secure` when the
   issuer is HTTPS).
4. Login mode `public` (default for HTTPS): the issuer page shows the actual client, callback
   host, effective scopes and resource. A deliberate button starts the public-RP passkey ceremony;
   it does not start automatically. RP ID is the issuer hostname, origin is exactly the issuer.
   No public page or fallback navigates to localhost. Missing public credentials require
   administrative enrollment; the page never downgrades to the local RP.
5. After UV, private inventory/policy is fetched once and frozen for this transaction. A second
   deliberate button approves the connection, showing requested scopes, configured idle/max-age,
   environment identities/destinations and unavailable hosts. Verbs and action counts follow the
   effective scopes and configured write capabilities: read-only consent has no write actions,
   and a deployment without write tools explicitly states that writing is unavailable, even if
   the client requested `connector:write`. In `all` mode the boundary is read
   and/or write of **all current and future projects** of the consented environments (Polaris and
   Sirius in this deployment), with automatic inclusion; no unrequested write/read claim.
   Restricted mode retains its write snapshot. Authentication alone creates no session or code.
6. Approval returns the existing `/resume` handle. With the original cookie, the AS creates the
   session and redirects to the exact registered callback with a code, original `state` and `iss`.
   Parallel verify/consent/resume attempts cannot create a second approval or session.

`button`, `302` and `oob` remain explicit desktop modes: top-level local link, immediate local
redirect, or code typed into the local page, with the existing polling/OOB fallback. Their local
RP remains `localhost`, origin `http://localhost:<local port>`. HTTP localhost rehearsal defaults
to `button`; `public` is invalid with any HTTP issuer.
7. Client exchanges the code at `/token` with `private_key_jwt` and the PKCE verifier and gets an
   access token and a refresh token.

### Public credential enrollment and removal

The original local credential and `passkeys.json` remain separate from `passkeys-public.json`.
Public storage has schema version, exact issuer origin/RP ID and the **existing canonical subject**.
Mismatch/corruption fails boot; changing issuer requires an explicit credential migration, not
reinterpretation. Both files use atomic synchronous writes, mode 0600, in a 0700 state directory.
Restart preserves keys/subject and ends all sessions, transactions and public enrollment tickets.

On the local control page, **Authorize public passkey enrollment** requires a fresh local-passkey
UV proof bound specifically to issuance. The protected response shows a link and locally rendered
QR. A public assertion or kill-release proof cannot issue, reveal, list or remove credentials.
`SIGUSR2` retains its existing local bootstrap behavior; there is no public signal/terminal issuer.

The link is a 128-bit, single-use administrative capability in a URL fragment. It is stored only
as a digest in memory, never logged or persisted. The page immediately removes the fragment;
every POST requires that capability plus an enrollment-browser cookie. The first valid options
request claims it atomically for that browser. One generation is outstanding, at most 15 minutes;
replacement, kill, revoke-all, restart and success invalidate it. Challenges expire within 120 s.
Generation/epoch/browser/freshness checks run after crypto and immediately before the synchronous
credential commit. An invalid guess cannot consume an operator's valid ticket or a replacement.

With no active capability, **all** public `/enroll`, `/enroll/options`, `/enroll/verify` routes
return 404 before parsing or work. During an authorized window GET serves a generic page, not an
authenticated enrollment; possession of the link grants power to add a public credential for the
canonical subject. Protect the link/QR as administrative secrets. There is no public startup ticket,
permanent registration endpoint, password/PIN fallback or proxy to the local handler.

**Manage credentials** also needs fresh local, action-bound UV to list keys or remove the selected
RP/key. Once bounded queue admission and synchronous durable intent persistence succeed,
removal immediately ends that key's sessions/AT/RT and pending authenticated/approved
transactions, blocks in-flight counter writes, and preserves other keys and the local recovery RP.
The per-RP credential file stores `pendingDeletions` alongside its keys through a flushed
owner-only temporary file and atomic rename. A pending/failed key stays stored but disabled;
options omit it and verification cannot save its counter. Other counter/registration commits
preserve the intent. The local list shows `active`, `pending` or `failed`; **Finish removal with
local passkey** obtains a new action-bound proof and completes deletion without re-enabling it.
Restart loads incomplete intents as `pending`, keeps those keys unusable and requires a fresh
local proof to finish (no automatic deletion or restored authority). Success removes both key
and intent. Queue overload or failure to persist the initial intent rejects admission before any
revocation transition: the operation has not been accepted and must be retried. A failure after
intent commit leaves the key disabled and its sessions/approvals canceled, even after restart.
The last usable local key cannot be removed. Public keys cannot self-administer. Local bootstrap
recovery remains a separately authorized, terminal-only mechanism, including during kill.

### Public ceremony and browser controls

`/authorize/passkey/options`, `/authorize/passkey/verify`, `/authorize/consent/view` and
`/authorize/consent` require exact issuer Origin, JSON, opaque transaction handle and initiating
cookie, live/unapproved `public` map member, TTL and authority epoch. Present `Sec-Fetch-Site`
must be `same-origin`; absent metadata still requires all mandatory checks. Challenges are
purpose/RP/origin/tx/cookie bound, consumed before verification, and expire at the earlier of
120 s or transaction expiry. Authentication freshness is 120 s through consent. Options
replacement cannot reset attempt budgets. A second authorize in the same browser cancels the
older public transaction; its older tab fails clearly. Removed keys and canceled references cannot
resume. `crossOrigin` other than absent/false, and any `topOrigin`, are refused for both RPs.
UV, UP, signature, challenge, origin, RP and counter checks remain mandatory, including zero-counter
synced keys. Verification, registration and final deletion run in a bounded per-RP queue with
generation guards. Deletion-intent admission writes immediately outside that queue. Each guarded
OAuth credential save updates disk, the live Map and its credential generation synchronously
before returning, so every intent snapshots committed state, including another key's latest
counter or a just-enrolled key. The unchanged core verifier's later identical Map update finishes
before queued final deletion; it cannot restore a removed key.

HTTPS cookies are host-only `__Host-t3c_tx` / `__Host-t3c_enroll`, Secure, HttpOnly, SameSite=Lax,
Path=/, no Domain; duplicate names fail closed. HTTP rehearsal retains `t3c_tx`. Success/error
responses have no-store, no-referrer, nosniff and framing denial; HTML uses nonce CSP with
`frame-ancestors 'none'`, `object-src 'none'`, base/form denial and same-origin fetch/script.
The pinned SimpleWebAuthn bundle is served by `/authorize/vendor/swa.js`; QR rendering uses
local matrix data, with no external script, analytics, font or QR service. Client metadata remains
escaped/textContent. Ceremony endpoints have no credentialed cross-origin CORS/preflight.

**GET never approves or enrolls.** Existing OAuth navigation effects remain: authorize creates a
transaction/cookie; resume consumes an already approved transaction and issues the bound code.
Do not apply ceremony Fetch Metadata restrictions to OAuth top-level navigation or signed
server-to-server token/revoke requests. AS browser routes stay on the public issuer, never the
MCP-only tunnel listener; local administrative routes stay loopback-only.

### Steady state, idle, revocation

- The client refreshes with `private_key_jwt`; each refresh consumes the presented refresh token.
  **Refresh, initialize, tools/list, ping and notifications never extend the session.**
- Each authorized `tools/call` that reaches the facade restarts the idle window (it counts at
  admission, before the backend answers; a call with invalid arguments for a known tool still
  counts).
- After `idleSeconds` without a tool call the session is terminal: the RS answers `401
  invalid_token` and the AS answers `invalid_grant`, even for tokens that have not expired yet.
- Local revoke, revoke all and the kill switch end sessions at once; tokens resolve to nothing on
  the next request. Revoke all and the kill switch also cancel sign-ins in progress, even ones
  already approved with a passkey but not yet resumed (authority epoch). The kill switch is persisted (`<state>/kill-switch`) and also blocks new
  sign-ins until released with a passkey; releasing it revives nothing.
- A connector restart ends every session (sessions and tokens live in memory). Passkeys, the
  subject id and the kill switch persist.

### Writes

`T3_CONNECTOR_OAUTH_PROJECTS=all` selects dynamic authorization for both reads and writes.
The session freezes the policy, configured environment aliases, environment IDs, logical
`destination` values and action catalog, **without project IDs**. Refresh never changes this
consent. A configured host can be offline at sign-in and become usable later; an empty inventory
is valid. New environments or changed identities/destinations require new consent.

The OAuth-only read loader validates the same endpoint identities, transports and token paths,
but ignores `allowedProjects` in this mode. It never edits the shared config. Read and write
configurations must contain exactly the same aliases, environment IDs and logical destinations;
boot fails on divergence. Read-only deployments need no write config. Reads still use read-only
backend credentials. The eight tool names and schemas remain unchanged. Each `tools/call` opens
its own read server and live context, including concurrent messages in one accepted HTTP JSON-RPC
batch. Catalog discovery owns a separate context and fetches no project inventory. Each inventory
observation remains paired with that invocation's private project Set; deleted/empty observations
cannot inherit another call's authority. Each call verifies thread membership in the chosen host
before bounded thread reads or subscriptions. Search preserves partial failures and pagination. No ID lookup
falls back to another host.

Writes use an operation-local `SessionWriteGate` and the existing `Dispatcher` with optional
OAuth preflight hooks. Legacy callers do not use these hooks. Ordering remains:

1. Check session, caller, consented environment and action.
2. Atomically reserve the journal key, or dedupe/conflict without sending or fetching inventory.
3. Fetch a verified live shell and resolve every thread reference and project root from it.
4. Check workspace and prepare the connection.
5. Revalidate live ownership and roots after preparation and any asynchronous canonicalization.
6. Record `uncertain`, check authority synchronously, audit and recheck, invoke once, record receipt.

The caller is `oauth:<subject>|oauth-issuer:<issuer>` and remains stable across sign-ins and refresh.
The journal is `<oauth state>/write-journal.sqlite`, separate from the lease journal. Journal/audit
failures and uncertain sends end every OAuth session. Missing/deleted projects or moved/deleted
threads fail before invoking T3; rejected operations stay journaled without costing a reconnect.
A reservation error before any durable commit leaves no record and has sent nothing; another
attempt still fails closed while storage remains unavailable. If reservation committed before
reporting failure, its `preparing` record dedupes after storage recovery and fresh sign-in without
sending. Stored `rejected`/`uncertain` operations likewise never resend on reconnection. Dedupe
requires a durable record; an absent reservation cannot remember an operation that never sent.

Existing worktrees must have canonical paths equal to current project roots. New worktrees
(`workspaceStrategy.type=worktree`, with `baseRef`, optional `branch` and `startFromOrigin`)
are forwarded to T3 as of 0.11.0. Fork, merge-back and delegated actions validate all source/target references.

Reconciliation authorizes the current session/caller/environment/action and the caller-bound
journal record, without requiring a historical project's continued existence. It never repeats a
mutation. A targetless rejected record returns `{state: "rejected", observation: null, sent: false}`;
other targetless states remain refused. Authority is rechecked after observation and audit.

There is an unavoidable race between the last live GET and the remote mutation RPC. Stronger
atomic ownership guarantees require a backend revision/predicate checked by that RPC. The
connector revalidation does not claim atomicity with the backend.

With `T3_CONNECTOR_OAUTH_PROJECTS` unset (or `restricted`), the sandbox-compatible legacy mode
keeps the read `allowedProjects` ACL and the write inventory frozen at sign-in. Its optional
`T3_CONNECTOR_OAUTH_WRITE_PROJECTS=alias:projectId,…` narrows that snapshot. It does not provide
future-project access. Setting this variable with `all` is a boot error. The stdio ACL validator,
Ponte gate, lease TTL and `grantFromInventory` snapshot remain unchanged.

`thread.launch`, `delegated_task.request` and `thread.runtime-mode.set` accept an optional
`runtimeMode`: `approval-required`, `auto-accept-edits`, `auto` or `full-access`. Omission keeps
the existing `full-access` default, including the setter's old no-parameter behavior. T3 decides
provider support; the connector forwards the selected mode without upgrading it. The consent's
`full-access` is the authorization ceiling, not a requirement to use that execution mode.
Interaction mode behavior is unchanged.

#### Native T3 tools (opt-in)

`T3_CONNECTOR_OAUTH_NATIVE_TOOLS=1` (only with `T3_CONNECTOR_OAUTH_PROJECTS=all`) adds thin
wrappers over native T3 MCP tools that the connector did not cover (inventory:
`INVENTARIO-MCP-NATIVO.md`, T3 8ed276c2). They keep the native names, arguments and result shapes;
T3 validates the semantics and its typed errors come back as `<ErrorTag>: <message>`. As with
project deletion, they are listed and callable only for a session consented with them.

- Reads (`connector:read`): `t3_environment_read`, `t3_project_read`, `t3_thread_configuration`,
  `t3_thread_transfers`, `t3_queue_list`, `t3_queue_read`, `t3_thread_search`,
  `t3_worktree_status`, `t3_worktree_list`, `list_scheduled_tasks`. Arguments are the native ones
  plus `environment`.
- Writes (`connector:write`): `t3_project_create`, `t3_project_update`, `t3_project_clone`,
  `t3_environment_preferences_update`, `schedule_task`, `update_scheduled_task`,
  `delete_scheduled_task`, `run_scheduled_task_now`. Arguments are
  `{environment, operationId, input}`, where `input` holds the native arguments, journaled like any
  write.

Remote differences from the native tools:

- **Calling context.** The native "calling thread/project" is an explicit `threadId` (queue,
  configuration, transfers, worktree, `schedule_task`) or `projectId` (scheduler list, update,
  delete, run now). `t3_thread_search` filters by `projectId` only when given.
- **Authorization.** Native caller guards (a live full-access/default thread) are replaced by the
  OAuth consent and the live project inventory of the environment. Project create/clone and
  preferences are environment-scoped.
- **Idempotency.** Where T3 accepts a `commandId` (project create/update, schedule create), it is
  derived from the operation, so a repeated operation is replayed by T3 and the journal. Native
  calls without a key (createNew, clone, runNow, settings, scheduler update/delete) are deduped
  only by the journal.
- **Errors.** A typed T3 refusal after the send is final (`failed`): no reconciliation and no
  session teardown. An untyped failure stays uncertain and fails closed, as for every other write.
- **Results.** Results are the native projections of what T3 answered. A title-only
  `t3_project_create` reads the project list afterwards to return the full Project.
- **Run state.** `run_scheduled_task_now` starts a new manual run on every call. Completion means
  the scheduler bookkeeping ran, not that the provider finished.

Not wrapped, with the reason:

- `t3_attachment_*` and `t3_thread_send_attachments`: the bytes go to the T3 origin, which a
  remote client cannot reach.
- `t3_thread_read` and `list_thread_pull_requests`: their results are server-side projections, so
  a remote copy would be a reimplementation, not a thin wrapper.
- `t3_thread_update`: rename and regenerate are covered by `thread.metadata.update`; the legacy PR
  link branch's result is not available atomically over WS.
- `t3_thread_launch` and `t3_project_delete`: covered by existing actions.
- Local-session, preview and device tools: out of scope.
- Moving or reassigning a thread: there is no native primitive.

#### Project deletion (opt-in)

`T3_CONNECTOR_OAUTH_PROJECT_ADMIN=1` (only with `T3_CONNECTOR_OAUTH_PROJECTS=all`; any other value
is off) adds three OAuth tools. They are listed and callable only for a session whose consent
includes the project actions, that is, one consented after the flag is on; an older session's
frozen action list never gains them. The lease bridge (Ponte), stdio and `ACTIONS` catalogs are
unchanged.

- `t3_contar_threads_projeto`: the full live thread count of one project: `total`, `active`,
  `archived`, `withoutRun` (overlapping) and `busy` (active run or pending request). A malformed
  thread row (missing id, project, status, or with an invalid field) makes it incomplete. The HTTP
  shell carries only active threads; archived ones come from WS
  `orchestration.getArchivedShellSnapshot`. The count is `complete` only when both reads observed
  the same `snapshotSequence`. Otherwise it reads again (3 attempts), then answers
  `complete:false, total:null`, never zero.
- `t3_escrever_project_delete`: refused before sending (`project_not_empty`) unless the full count
  is 0, and always sent with `force:false`, so T3's own refusal still applies. A refusal is never
  escalated to force.
- `t3_escrever_project_delete_force`: requires `force: true` (literal), `confirmProjectId` equal to
  `projectId`, and `expectedThreadCount` equal to the full count taken as the last read before
  the send, after the target validation. It is refused when a thread
  of the project has an active run or a pending request. T3 deletes each thread (cancelling its
  pending work), then the project.

Both use WS `projects.mutate` (`project.delete`) with a `commandId` derived from the operation key,
so T3 replays the receipt of a command it already committed. The operation journal dedupes as for
any write. Same operationId and same input returns the recorded result, including the receipt
and the post-check; same operationId and other
input is `operation_conflict`. The receipt is `{projectId, deletedAt}`; T3 returns no sequence or
deleted-thread count, and the connector invents none. The project is soft-deleted, and its
workspace directory on disk is kept. Moving threads between projects is not offered: T3 has no
native command that changes a thread's `projectId`.

**Concurrency (backend limit).** In T3 8ed276c2, `ProjectService.deleteChildThreads` reads the
project's threads outside the project lock, and `thread.create` neither checks the project nor
takes that lock. So another client creating a thread during a delete can leave a live thread linked
to a deleted project. The connector:

- serializes its own project-scoped writes (`thread.launch`, `thread.fork`, the deletes) per
  environment and project;
- re-reads the full count right before sending;
- after the delete, reads it again and reports `postCheck: "live_threads_remain"` with
  `liveThreadsAfterDelete`, plus an audit event, instead of a clean result.

It cannot exclude other clients (T3 UI, MCP, scheduler). Treat the guarantee as connector-local
until T3 makes the check and the delete one transaction.

A native refusal after the send (the project gained a thread between the connector's count and
T3's check) is uncertain for the connector. Like any uncertain send, it fails closed: no retry,
sessions end, and reconciliation is by `t3_reconciliar_escrita`.

## 2. What ChatGPT does, and why the token lifetimes are what they are

Measured in the spike (ChatGPT web, 04/10/2026):

1. Registration by CIMD: `client_id=https://chatgpt.com/oauth/client.json`, `private_key_jwt` at code
   and refresh, callback `https://chatgpt.com/connector_platform_oauth_redirect`, PKCE S256,
   `resource` sent, `iss` accepted. It also probes `/.well-known/openid-configuration`.
2. With a 60 s access token it refreshes early: right after the code exchange and before each call.
   With a 3600 s access token it just calls with the token it has.
3. After a `401 invalid_token` it is not reliable about refreshing: with only the access token
   revoked (refresh token still valid) and with a dead session it did not call `/token`; after
   natural idle expiry it tried one refresh and got `invalid_grant`. In every dead-session case the
   UI showed "connection expired" with a manual Reconnect; it never opened the sign-in by itself
   and never required recreating the connection.
4. Reconnect → Continue → passkey redoes `/authorize` with PKCE without recreating the app, and the
   interrupted call resumed without being resent.
5. Server side, natural idle expiry worked: the session ended by itself and both the nominally
   valid access token and the refresh token were refused.
6. The detour HTTPS `/authorize` → `http://localhost/login` (passkey, UV) → `/resume` → callback worked
   with button and with 302 in a Firefox-based browser.

Consequences built into the defaults:

- **Access tokens are short (60 s)** because the spike saw ChatGPT refresh before each call with
  that lifetime. The intent is that normal expiry happens through refresh, not through a 401.
- **A 401 is meant for a dead session** (idle, revocation, kill switch, restart). That costs a
  Reconnect plus a new passkey, which is the intended behaviour after idle. This is a deployment
  condition, not a server guarantee: the server always rejects an expired access token, so if a
  client presents one (missed or late refresh, long delay between refresh and request) it also
  gets a 401. The ChatGPT E2E (section 7) confirmed proactive refresh right before each tool call.
- Revoking only access tokens (not exposed in the product UI) would therefore cost a Reconnect too.
- **Do not raise the access-token lifetime for ChatGPT.** With a long token it stops refreshing
  early and calls with the token it has; when that token expires the call gets a 401, which costs
  a Reconnect before the idle window ends. The setting exists for other clients.
- Accepted UX cost (spike verdict, provisional GO with caveat): one manual Reconnect + passkey per
  dead session (idle, revocation, kill switch, restart).

## 3. Coexistence with the passkey lease

| Lease path (unchanged) | OAuth session path (new) |
|---|---|
| `t3-connector-write` gate + bridge, stdio | `t3-connector-oauth serve`, HTTP |
| `~/.local/state/t3-connector-write` (or configured `estado`), `credentials.json` | `~/.local/state/t3-connector/oauth`, `passkeys.json` |
| Gate port from write config (e.g. 7433) | 7434 public, 7435 local (different WebAuthn origin) |
| Fixed 60 min lease, no renewal, channel identity | Idle window, rotating refresh, subject identity |
| `write-journal.sqlite` in the lease state | `write-journal.sqlite` in the OAuth state |

Guarantees:

- The OAuth code never constructs a `Gate` (it only reuses the pure `grantDoAmbiente` helper), never reads or writes lease state, never
  accepts a lease id as a session id and never accepts a channel or mTLS identity as an OAuth caller
  (and vice versa: the lease `Gate` keeps its own identity check, which the OAuth identity never
  satisfies because leases are bound to the channel caller key).
- Refresh therefore cannot extend or bypass a lease: they are different authorities with different
  stores. Writes through the bridge still need a lease; writes through HTTP need a live session.
- OAuth wraps the existing crypto abstraction; the Ponte gate, lease and credential storage remain independent and unchanged.
- Both paths may hold connections to the same backend with the same read+operate token if the
  operator points `T3_CONNECTOR_OAUTH_WRITE_CONFIG` at the existing `write.json` (only its
  `environments` are used). Their journals and dedupe namespaces stay separate.
- Cut-over (retiring the lease bridge) is a separate, explicitly authorized step.

## 4. Threat model

| Threat | Controls | Residual |
|---|---|---|
| Stolen access token | 60 s lifetime, single audience, session checked on every request, idle and revocation | Bearer replay during its lifetime; an attacker's tool calls keep the session active. No PoP on the ChatGPT→RS hop (ChatGPT documents no DPoP). |
| Stolen refresh token | `private_key_jwt` required, rotation, reuse ends the session, session check on refresh | A thief who also holds the client key can refresh; first use of a stolen token can win the race against the legitimate client. |
| Forged client / client impersonation | CIMD allowlist, JWKS signature check, `aud`, short lifetime, `jti` replay cache | Compromise of the client's signing key (OpenAI side) is out of our reach. |
| Authorization code interception | PKCE S256, single use, 60 s, exact callback, client binding; reuse ends the session | — |
| Login CSRF / transaction swap / phishing link | Transaction cookie bound to the browser that started `/authorize`, handoff and resume handles single use, approval page shows client, callback host, scopes and environment policy | A user tricked into approving an attacker-initiated sign-in still grants access; the page is the defence. |
| Mix-up | `iss` on every callback, fixed issuer | — |
| Cross-site driving of the control plane | Loopback only, exact Host (DNS rebinding), exact Origin and JSON on every POST, CSP, no framing | A local process can call the control plane directly: it can list, revoke and kill (DoS), not approve sign-ins (needs a passkey) nor release the kill switch. |
| Malicious enrollment | Local action-bound UV issues public capability, browser/generation/epoch bound, single use, ≤15 min; guarded commit | A stolen capability authorizes enrollment; terminal-only local bootstrap remains a separate recovery path. |
| Passkey assertion replay | Challenge per transaction, 120 s, consumed before verification, counter check, UV required | Synced passkeys are not device-bound. |
| Prompt injection driving writes | Consented environment boundary, live inventory/ownership, typed actions, workspace checks, journal/dedupe, no resend of uncertain writes | In all mode injection or a compromised bearer can reach every current and future project of the consented hosts during the active session. Human action restrictions are policy; the passkey is not per-action approval. |
| Activity forgery | Only `tools/call` counts | Any client with a valid token can keep the session alive with harmless calls; the connector cannot see human presence. |
| Connector host compromise | State directory 0700, files 0600, HMAC-only token storage | Root or same-user malware controls everything (as with the lease). |
| Ingress / tunnel | TLS at the ingress; no trust in forwarded headers | The ingress sees bearer tokens and data. |
| SSRF via client metadata | Only allowlisted client ids are fetched; `redirect: error`; 64 KiB, 5 s limits | `jwks_uri` inside an allowlisted document is trusted as part of that document. |

## 5. Configuration

`t3-connector-oauth` reads environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `T3_CONNECTOR_OAUTH_ISSUER` | required for `serve`; `http://localhost:<public port>` for `rehearsal` | Public HTTPS origin of the ingress. MCP URL is `<issuer>/mcp`. Changing it invalidates existing connections. |
| `T3_CONNECTOR_OAUTH_PUBLIC_PORT` | 7434 | Public listener on 127.0.0.1. |
| `T3_CONNECTOR_OAUTH_LOCAL_PORT` | 7435 | Control plane (`http://localhost:<port>`, also the WebAuthn origin). |
| `T3_CONNECTOR_OAUTH_STATE_DIR` | `$XDG_STATE_HOME/t3-connector/oauth` (`oauth-rehearsal` for rehearsal) | Passkeys, kill switch, event log, write journal. |
| `T3_CONNECTOR_OAUTH_IDLE_SECONDS` | 3600 | Idle window (60 … 604800). |
| `T3_CONNECTOR_OAUTH_ACCESS_TOKEN_SECONDS` | 60 | Access token lifetime (30 … 3600). Keep it short for ChatGPT (section 2). |
| `T3_CONNECTOR_OAUTH_REFRESH_TOKEN_SECONDS` | 86400 | Lifetime of each refresh token generation. |
| `T3_CONNECTOR_OAUTH_MAX_AGE_SECONDS` | 0 (off) | Optional absolute session cap; when set, a new passkey is needed after it even with activity. |
| `T3_CONNECTOR_OAUTH_LOGIN_MODE` | `public` for HTTPS, `button` for HTTP localhost rehearsal | `public` requires HTTPS; explicit `button`, `302`, `oob` preserve local desktop handoff. |
| `T3_CONNECTOR_OAUTH_CLIENTS` | `https://chatgpt.com/oauth/client.json` | Comma-separated allowlist of CIMD client ids. |
| `T3_CONNECTOR_OAUTH_ALLOWED_ORIGINS` | `https://chatgpt.com` | Browser `Origin` values accepted on `/mcp` (requests without `Origin` are accepted). |
| `T3_CONNECTOR_OAUTH_WRITE_CONFIG` | unset | Path to a write config (`write.json` format). Unset: no write tools. |
| `T3_CONNECTOR_OAUTH_PROJECTS` | `restricted` | `all`: read/write consent for all current and future projects of configured environments, with live inventory per call. Ignores the shared read ACL only inside OAuth. Read/write environment sets must match. |
| `T3_CONNECTOR_OAUTH_PROJECT_ADMIN` | off | `1` (with `PROJECTS=all`): adds the project count and project delete tools (see Writes, Project deletion). |
| `T3_CONNECTOR_OAUTH_NATIVE_TOOLS` | off | `1` (with `PROJECTS=all`): adds thin wrappers over native T3 MCP tools (see Writes, Native T3 tools). |
| `T3_CONNECTOR_OAUTH_WRITE_PROJECTS` | unset | Restricted mode only: `alias:projectId,…` narrows the frozen write snapshot for sandboxes. Conflicts with `all`; boot fails. |
| `T3_CONNECTOR_CONFIG` | `~/.config/t3-connector/config.json` | Read config (same as `t3-connector`). |
| `T3_CONNECTOR_OAUTH_VERBOSE` | unset | `1` echoes the redacted event log to stderr. |
| `T3_CONNECTOR_OAUTH_RESOURCE` | unset | Tunnel mode (5.1): the exact canonical MCP resource named by the tunnel service. Exact HTTPS URL with a path; compared verbatim. |
| `T3_CONNECTOR_OAUTH_TUNNEL_PORT` | unset | Tunnel mode (5.1): loopback listener for the tunnel client. Set together with `T3_CONNECTOR_OAUTH_RESOURCE`. |
| `T3_CONNECTOR_OAUTH_ADVERTISED_RESOURCE` | unset | Tunnel mode only: exact https URL advertised in the local protected resource metadata instead of `T3_CONNECTOR_OAUTH_RESOURCE`, when the accepted resource (the hosted tunnel endpoint) is not reachable from the tunnel client. Never accepted for authorization or tokens. |

The event log `<state>/events.jsonl` does not receive tokens, codes, cookies, handles or `state`.

### 5.1 Tunnel mode (MCP through an OpenAI Secure MCP Tunnel)

The Secure MCP Tunnel (`tunnel-client`, the transport of the stdio Ponte) can carry an HTTP MCP
server with OAuth: it forwards the `Authorization` header to a private target, runs the protected
resource discovery from the local network and rewrites the `resource` (and `resource_metadata`) to
the tunnel service's own MCP URL. It does not publish browser routes, so `/authorize` and `/resume`
still need the public HTTPS issuer, and `/token` stays a direct public call.

With `T3_CONNECTOR_OAUTH_RESOURCE` and `T3_CONNECTOR_OAUTH_TUNNEL_PORT` set:

- the public listener serves only the authorization server (metadata, `/authorize`, `/resume`,
  `/token`, `/revoke`, public ceremonies/consent/vendor and capability-gated public enrollment); `/mcp` and the protected resource metadata answer 404 there;
- the tunnel listener (`127.0.0.1:<tunnel port>`, Host `127.0.0.1:<port>` or `localhost:<port>`
  only, 421 otherwise) serves `/mcp` and its metadata, never the authorization server;
- the metadata names the issuer as authorization server and, as `resource`, the configured
  resource R — or the advertised value A when `T3_CONNECTOR_OAUTH_ADVERTISED_RESOURCE` is set (see
  below); `/authorize`, `/token`, refresh and the resource server accept only R, and tokens are
  bound to it;
- an `/authorize` with another resource is refused (`invalid_target`) and logged as
  `authorize_unknown_resource` with a hash of the requested value only.

The exact resource is the one the tunnel service puts in the rewritten protected resource metadata.
When that value cannot be read from the tunnel side, a temporary opt-in capture can record it:
set `T3_CONNECTOR_OAUTH_RESOURCE_CAPTURE_FILE` (absolute path in an owner-only directory) and
`T3_CONNECTOR_OAUTH_RESOURCE_CAPTURE_MATCH` (the tunnel ID) together. A refused resource is then also
written to that file (0600, atomic; temporary files removed on a best-effort basis) only when it is already a canonical https
URL — lowercase host, optional port, a path of unreserved characters only (no percent encoding,
query, fragment or credentials), the tunnel ID as a whole path segment, at most 512 characters;
anything else stays hash-only. This is a request-supplied candidate, not trusted discovery: its hash
matching the refused request's `requestedHash` only correlates it with that request; corroborate it
before configuring it. After disabling, remove the capture file and any `.resource-capture-*`
remnant in that directory (only those). The request is refused exactly as before. Use a private
directory reserved for this diagnostic under trusted ancestors. Remove both settings and the file once the resource is
configured.
Read it from the tunnel side (the tunnel client's logged discovery URLs and status UI, or the
rewritten metadata). Request values are not a source, except for the opt-in diagnostic below, whose
candidate must be corroborated; restart with the value set.

Observed in production (tunnel-client 0.0.14): the hosted resource ChatGPT sends is an internal
OpenAI gateway URL (`https://tunnel-service.gateway.<…>.internal.api.openai.org/v1/mcp/<tunnel_id>`)
that tunnel-client cannot reach; advertising it locally makes tunnel-client's own startup discovery
time out on that origin and never register the discovery target. Configure it as
`T3_CONNECTOR_OAUTH_RESOURCE` (R) and advertise a reachable exact URL with
`T3_CONNECTOR_OAUTH_ADVERTISED_RESOURCE` (A). This depends on the hosted tunnel rewriting both the
metadata `resource` and the challenge's `resource_metadata` before any external client reads them:
a client that saw A directly could not authenticate, because A is never accepted. The internal
hostname and this workaround are observed behaviour of the current service, not a public API
guarantee; keep the two values separate (no alias acceptance).

Tunnel client profile (`server_urls`, channel `main`): `http://127.0.0.1:<tunnel port>/mcp`.

Session and credential ids are written as 8-hex hash prefixes at the sink. Request-controlled
values are logged only when they belong to a fixed set (known MCP methods, tools present in the
catalog, `grant_type` values, `Sec-Fetch-Site` values, allowlisted client ids, our own error
codes); anything else is logged as a hash, so a secret sent in the wrong position is not persisted.

### 5.2 Admission, resource bounds and ingress requirements

Application defaults (finite bounds, not a measured capacity claim):

| Work | Bound / deadline |
|---|---|
| Public authorize | 10/min/socket source, burst 5; 128 live tx, one active tx per browser cookie |
| Ceremony POSTs | 60/min/socket source, burst 30; 8 admitted workers, before body parsing |
| Per transaction/capability | 5 options, ≥1 s spacing; 5 submitted failures; 120 s challenge/auth freshness |
| Per RP crypto/mutations | 1 active + 8 queued, 10 s queue/work deadline, 32 credentials |
| Rate buckets / local admin | 256 buckets; local admin 60/min burst 30, 8 workers, 16 proofs |
| CIMD/JWKS | 4 single-flight loads, 5 s deadline, 64 KiB; 32 clients/callbacks, 16 keys, 4096 JTI replay entries |
| HTTP | 64 connections/listener, 100 requests/socket, 5 s headers/body/keepalive, 10 s request/socket timeout, 64 KiB body; bounded JSON depth/nodes/strings |
| Sessions/tokens | 128 live sessions; 65,536 token records globally, 4096 per family; reuse tombstones never evicted from a live family |
| Audit | One 1 MiB file + one rotated file; repeated rejections aggregated for 60 s in a map of at most 128 entries |

Overload is 429 with Retry-After; expired work cannot persist after timeout. A blocked crypto job
holds its bounded slot until it settles. Operator recovery is through fresh transactions/tickets
and replenished admission budgets, not a permanent subject-wide lockout. Token-capacity exhaustion
ends the offending session and purges its family instead of dropping replay detection. Policy
version 3 is required for live all-project scope; incompatible sessions fail closed. Changing
configuration/policy requires restart and fresh consent, which already terminates old sessions.

The app trusts only the socket peer for rate accounting. Behind ingress all users share that
budget; spoofed forwarded IP/Host/proto headers never select identity. Deployment must enforce
per-client edge throttles (authorize 10/min burst 5, ceremonies 60/min burst 30), ≤64 KiB bodies,
finite header/body deadlines, bounded connections, no caching and no framing/header rewriting.
Only the AS/public ceremony paths above may reach this listener; never proxy local `/api/*`, `/`,
local enrollment or the MCP tunnel's listener. Pin the configured issuer Host. Configure HSTS
at the HTTPS edge only after checking coverage. Disable query/body/cookie/Authorization logging
for authorize/resume/token/revoke/enrollment and any proxy response dump: codes and OAuth state
necessarily use callback/navigation URLs, while tickets use fragments and assertions use bodies.
App audits never receive tickets, cookies, assertion bodies, codes or tokens. These edge controls
and mobile/Bitwarden/hosted ChatGPT compatibility require separately authorized deployment/E2E;
the software-authenticator loopback fixture does not prove them.

## 6. Local rehearsal

```sh
t3-connector-oauth rehearsal          # prints the MCP URL, the local control URL and an enroll ticket
```

1. Open the printed `http://localhost:7435/enroll`, enter the ticket, create the passkey.
2. Put an HTTPS ingress in front of `127.0.0.1:7434` and restart with
   `T3_CONNECTOR_OAUTH_ISSUER=https://<ingress host>` (the issuer must be the public origin).
3. On the local control page authorize public enrollment with the original local passkey, open
   the fragment link/QR at the issuer and create the independent public credential. Then connect
   with `<issuer>/mcp`, OAuth: public UV, explicit consent, registered callback. Set an explicit
   desktop mode to continue testing the original local handoff instead.
4. Call `rehearsal_now`, `rehearsal_note_write`; watch `http://localhost:7435/` (sessions) and
   `events.jsonl`. Use a short `T3_CONNECTOR_OAUTH_IDLE_SECONDS` to observe idle expiry.

The rehearsal state directory is separate from `serve`'s.

## 7. Acceptance criteria

Automated (in `npm test`), including `test/oauth-public.test.mjs` with software authenticators,
synthetic keys/state, controlled HTTPS issuer identity over ephemeral loopback HTTP ingress and
mutable fake inventories:

- independent RP/storage/canonical subject and restart; strict clientData cross-origin validation,
  signature/UP/UV/counter behavior; storage corruption/mismatch fail closed;
- cookie-bound public UV then explicit consent; no private inventory before authentication;
  single-use challenge/purpose/TTL/replacement/attempt budgets, scope-aware consent snapshot;
- concurrent verify/consent/resume; wrong tabs/cookies, expiry/kill/revoke/removal during blocked
  crypto/inventory and after approval refuse sessions/persistence;
- local action-bound capability issuance/removal, atomic browser claim, single generation,
  replacement/reset/restart invalidation, failed registration never consumes newer capability;
- real HTTP removal queue rejection, timeout/epoch guard and storage failures, fresh local-UV
  retry without restart, durable pending revocation after restart, and last-local-key protection;
- revoked-key AT/RT/pending approvals rejected, in-flight counter cannot restore deleted key;
- headers/CSP/cookies, escaped client metadata, no secrets in audit, bounded queues/maps/CIMD,
  slow/oversized/malformed bodies, admission/attempt exhaustion and operator recovery;
- all-mode newly created projects readable and writable in the same public session on both hosts,
  unavailable-host recovery, identity mismatch and incompatible policy version denied; local/public
  canonical caller dedupe/reconcile and existing stdio ACL unchanged;

- idle boundary exact; refresh/initialize/tools/list/ping do not extend; a tool call does;
  suspended monotonic clock and wall rollback do not rejuvenate, alone or combined (idle and max
  age); terminal states never revive;
- code single use (reuse ends the session, also after cleanup), PKCE, client, callback and
  resource binding; expired unused codes end their pending session;
- refresh rotation over 70 simulated minutes with activity; reuse ends the session (`invalid_grant`,
  then `401`);
- `private_key_jwt`: valid ES256/RS256/PS256; wrong key, tampered payload, `alg` none/HS256, wrong
  `aud`, expired, too long, future `iat`, missing `jti`, replay, no assertion → `invalid_client`;
  allowlist enforced before any fetch; key rotation;
- full first access over HTTP in the three local login modes with a software passkey; resume needs the
  original cookie and is single use; UV, origin and challenge failures refuse approval;
- revoke, revoke all and kill switch immediate; kill blocks sign-in; release needs a passkey and
  revives nothing; sign-ins approved before a kill or revoke-all cannot resume afterwards;
- scope: absent → default, mixed → supported subset, explicit unsupported-only → `invalid_scope`; kill switch and passkeys survive restart, sessions do not;
- control plane refuses foreign Host, Origin, non-JSON and missing tickets; public listener refuses
  foreign Host and browser Origins;
- T3 catalog: eight reads + write catalog without `leaseId`; all-mode environment consent and
  projects created after sign-in readable/writable in the same session on both hosts; empty and
  recovered inventories; unchanged stdio ACL/config bytes; concurrent scopes; deleted/moved targets,
  workspace roots, cross-host references and mismatched identities refused with zero invokes;
  actual HTTP batches with distinct/deleted/empty same-host inventory observations keep private
  invocation scopes; consent text/rows reflect requested scopes, offered actions, no-write
  deployments and configured idle/max-age; reservation/uncertain persistence/dispatch audit
  failures invoke zero times, invoke/receipt failures exactly once, with journal state and fresh
  sign-in retry assertions;
  restricted sandbox snapshots preserved; dedupe across refresh/sign-ins; revocation during
  preflight stops the send; journal failure ends all sessions; channel identities and lease ids are
  never accepted by the session gate; no secret or raw identifier in the event log, including
  client-controlled strings.

Composition harness (not in `npm test`): `node test/composition/harness.mjs <supervisionar-transporte.mjs>`
runs a synthetic OAuth client through an ingress proxy supervised by the Ponte's transport
supervisor helper, into this AS/RS and the session writes over a real SQLite journal and a doubled
backend that counts sends. It covers an ingress outage (same session after refresh, idle not
renewed), a response lost after the write reached the server (reconcile, repeat the same
operationId, one send) and an outstanding send while the ingress dies (uncertain, fail closed, no
resend, reconcilable after a new sign-in). It is not the OpenAI tunnel-client and says nothing about
client-side retries.

Historical local-handoff E2E (before public login), with ChatGPT web, 04/10/2026, through a quick tunnel (rehearsal tools, then `serve`
with writes limited to one scratch project): **passed** — passkey enrollment and first access in 3
apps; `private_key_jwt` with ChatGPT's real JWKS (RS256) at code and every refresh; proactive refresh
and rotation with no reuse; real read; real launch/title/archive with ChatGPT's confirmation dialog
(only for `destructiveHint=true`), sandbox restored; activity counted only on tool calls; natural
1 h idle expiry measured by a background process; Reconnect → passkey → tool after idle, old refresh
refused, call not resent; two concurrent chats on one session (2.5 s apart) with sequential refresh.
Still not covered: Touch ID (Bitwarden served every ceremony), browser restart, mobile, ChatGPT's own
retries, and the production path (the OpenAI Secure MCP Tunnel of section 5.1 with a stable
authorization server hostname). A quick tunnel run proves the OAuth flow, not that path.

The spike (ChatGPT web, 04/10/2026, verdict GO with caveat) had already proved, with its own harness:
the localhost passkey detour (button and 302), CIMD with `private_key_jwt` at code and refresh,
early refresh with 60 s access tokens, and recovery of every dead-session case through Reconnect →
Continue → passkey without recreating the connection.

## 8. Decisions for Marcus (smallest choice made, recommendation)

1. **Ingress.** Decided (04/10/2026): MCP through the OpenAI Secure MCP Tunnel (tunnel mode,
   section 5.1, same transport as the stdio Ponte) and only the authorization server on a stable
   HTTPS hostname. A quick tunnel changes hostname per run, which changes the issuer and forces a new
   connection each time; fine for rehearsal only.
2. **Persistence across restart.** Implemented: restart ends every session (new passkey sign-in).
   Recommendation: keep it for the first version; persisting sessions needs durable token storage,
   restart-safe clocks and its own review.
3. **Absolute cap.** Implemented: off, to honour "no interaction while active". Recommendation:
   keep off; set `T3_CONNECTOR_OAUTH_MAX_AGE_SECONDS` if a daily passkey is acceptable.
4. **Write catalog.** Implemented: the same actions as the lease path (including `acceptAlways`,
   rollback and full-access launch). Marcus chose full read/write access to every current and future
   project of the consented environments in all mode. Human restrictions on actions remain policy.
5. **Read scope.** OAuth/all resolves live inventory per call with read-only credentials. Restricted
   OAuth and the stdio read connector keep the read ACL. Shared configs stay unchanged.
6. **Fail closed on uncertain writes.** Implemented: an uncertain send ends every OAuth session
   (parity with the lease gate). Recommendation: keep until real failure modes are observed.
7. **Cut-over.** Not done. The lease bridge stays until an authorized cut-over after the E2E.

## 9. Known limits

- No DPoP / mTLS sender constraint on the ChatGPT hop; bearer profile.
- Project deletion cannot exclude another client creating a thread during the delete (T3 backend); the connector reports live threads left on a deleted project.
- Single canonical subject (one owner per installation); independent local and public-RP credentials. Public mobile/sync/hosted E2E remains unverified.
- Stateless MCP transport: no server-initiated notifications or standalone SSE stream.
- Any local process can revoke or kill. Credential listing/enrollment issuance/removal and kill release each require local UV; the control page itself has no separate admin login.
- `/.well-known/openid-configuration` returns the OAuth metadata (no ID tokens, no userinfo),
  because ChatGPT probes it; this is not an OpenID Provider.
