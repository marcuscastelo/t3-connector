# OAuth session profile (experimental)

Status: implemented locally and covered by automated tests; **not yet rehearsed end to end with
ChatGPT using this code** (the spike harness was). Nothing here changes `t3-connector` (stdio, read)
or `t3-connector-write` (stdio, passkey lease). Both keep working as before.

Goal: a client such as ChatGPT connects once with OAuth, the user approves the first sign-in with a
passkey (WebAuthn, user verification) on a local control page, and from then on the client reads
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
| Login transactions | `src/oauth/transactions.mjs` | Server-side state of each sign-in. The browser only carries opaque handles; the resume handle exists only after a verified passkey and still needs the transaction cookie. 5 min TTL. |
| Control plane | `src/oauth/control-plane.mjs` | Loopback only, Host `localhost:<port>`, exact Origin and JSON on every POST. `/login` (passkey approval, shows client, callback host, scopes and the write scope), `/enroll` (ticket printed on the terminal, single use, 15 min), `/` (sessions, revoke, revoke all, kill switch; releasing the kill switch needs a passkey). |
| Resource server | `src/oauth/resource-server.mjs` | Streamable HTTP, stateless, JSON responses. Global OAuth (initialize and tools/list too). Facade over inner catalogs: scope per tool, activity admitted per `tools/call`, session re-checked before a result leaves. |
| T3 catalog | `src/oauth/t3-tools.mjs`, `src/oauth/session-writes.mjs` | The eight existing read tools (read config) and, when configured, the write catalog without `leaseId`, authorized by the session. |
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
4. Login mode `button` (default): page with a top-level link to
   `http://localhost:7435/login#handoff=…`. Mode `302`: immediate redirect there. Mode `oob`: the page
   shows a code to type into the local page. All modes also show the code and poll, as a fallback.
5. The local page shows the client, callback host, scopes and the write scope (backend inventory
   taken now and frozen into the sign-in), then asks for the passkey with
   `userVerification: required`, RP ID `localhost`, origin `http://localhost:7435`.
6. On success the browser returns to `/resume` on the public origin. With the transaction cookie the
   AS creates the session, issues a code and redirects to the client callback with `code`, the
   original `state` and `iss`.
7. Client exchanges the code at `/token` with `private_key_jwt` and the PKCE verifier and gets an
   access token and a refresh token.

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

`session-writes.mjs` reuses the existing `Dispatcher` unchanged (journal reservation before any
await, target and workspace preflight, `uncertain` before sending, no resend of uncertain
operations, final synchronous authorization immediately before the single outbound call). Only its
structural `gate` is replaced by `SessionWriteGate`, keyed by session id:

- grants: the inventory frozen when the user approved the sign-in (environments unavailable then get
  no grant; projects created later need a new sign-in);
- caller: `oauth:<subject>|oauth-issuer:<issuer>`, built by the new
  `identidadeSessaoOAuth()` in `src/escrita/identidade.mjs` (additive export). It is stable across
  refresh and sign-ins, so the dedupe key survives them;
- journal: `<oauth state>/write-journal.sqlite`, separate from the lease journal;
- fail closed: when the Dispatcher closes its gate (journal failure, uncertain send), every OAuth
  session ends;
- targets outside the frozen grant are refused before the Dispatcher runs, so a model asking for an
  unapproved project gets `scope_denied` without ending the session.

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
  gets a 401. Proactive refresh by the real client must be confirmed in the end-to-end rehearsal.
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
- The only edit to existing source is the additive `identidadeSessaoOAuth()` export.
- Both paths may hold connections to the same backend with the same read+operate token if the
  operator points `T3_CONNECTOR_OAUTH_WRITE_CONFIG` at the existing `write.json` (only its
  `ambientes` are used). Their journals and dedupe namespaces stay separate.
- Cut-over (retiring the lease bridge) is a separate, explicitly authorized step.

## 4. Threat model

| Threat | Controls | Residual |
|---|---|---|
| Stolen access token | 60 s lifetime, single audience, session checked on every request, idle and revocation | Bearer replay during its lifetime; an attacker's tool calls keep the session active. No PoP on the ChatGPT→RS hop (ChatGPT documents no DPoP). |
| Stolen refresh token | `private_key_jwt` required, rotation, reuse ends the session, session check on refresh | A thief who also holds the client key can refresh; first use of a stolen token can win the race against the legitimate client. |
| Forged client / client impersonation | CIMD allowlist, JWKS signature check, `aud`, short lifetime, `jti` replay cache | Compromise of the client's signing key (OpenAI side) is out of our reach. |
| Authorization code interception | PKCE S256, single use, 60 s, exact callback, client binding; reuse ends the session | — |
| Login CSRF / transaction swap / phishing link | Transaction cookie bound to the browser that started `/authorize`, handoff and resume handles single use, approval page shows client, callback host and write scope | A user tricked into approving an attacker-initiated sign-in still grants access; the page is the defence. |
| Mix-up | `iss` on every callback, fixed issuer | — |
| Cross-site driving of the control plane | Loopback only, exact Host (DNS rebinding), exact Origin and JSON on every POST, CSP, no framing | A local process can call the control plane directly: it can list, revoke and kill (DoS), not approve sign-ins (needs a passkey) nor release the kill switch. |
| Malicious enrollment | Ticket printed only on the starting terminal, single use, 15 min | Anyone with terminal access to the host can enroll. |
| Passkey assertion replay | Challenge per transaction, 120 s, consumed before verification, counter check, UV required | Synced passkeys are not device-bound. |
| Prompt injection driving writes | Frozen grants, typed actions only, journal/dedupe, no resend of uncertain writes | Within an active session any approved action can be invoked without another passkey; that is the accepted trade-off of the UX. |
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
| `T3_CONNECTOR_OAUTH_LOGIN_MODE` | `button` | `button`, `302` or `oob`. |
| `T3_CONNECTOR_OAUTH_CLIENTS` | `https://chatgpt.com/oauth/client.json` | Comma-separated allowlist of CIMD client ids. |
| `T3_CONNECTOR_OAUTH_ALLOWED_ORIGINS` | `https://chatgpt.com` | Browser `Origin` values accepted on `/mcp` (requests without `Origin` are accepted). |
| `T3_CONNECTOR_OAUTH_WRITE_CONFIG` | unset | Path to a write config (`write.json` format). Unset: no write tools. |
| `T3_CONNECTOR_CONFIG` | `~/.config/t3-connector/config.json` | Read config (same as `t3-connector`). |
| `T3_CONNECTOR_OAUTH_VERBOSE` | unset | `1` echoes the redacted event log to stderr. |

The event log `<state>/events.jsonl` does not receive tokens, codes, cookies, handles or `state`.
Session and credential ids are written as 8-hex hash prefixes at the sink. Request-controlled
values are logged only when they belong to a fixed set (known MCP methods, tools present in the
catalog, `grant_type` values, `Sec-Fetch-Site` values, allowlisted client ids, our own error
codes); anything else is logged as a hash, so a secret sent in the wrong position is not persisted.

## 6. Local rehearsal

```sh
t3-connector-oauth rehearsal          # prints the MCP URL, the local control URL and an enroll ticket
```

1. Open the printed `http://localhost:7435/enroll`, enter the ticket, create the passkey.
2. Put an HTTPS ingress in front of `127.0.0.1:7434` and restart with
   `T3_CONNECTOR_OAUTH_ISSUER=https://<ingress host>` (the issuer must be the public origin).
3. Create the client connection with `<issuer>/mcp`, OAuth. Approve with the passkey.
4. Call `rehearsal_now`, `rehearsal_note_write`; watch `http://localhost:7435/` (sessions) and
   `events.jsonl`. Use a short `T3_CONNECTOR_OAUTH_IDLE_SECONDS` to observe idle expiry.

The rehearsal state directory is separate from `serve`'s.

## 7. Acceptance criteria

Automated (in `npm test`):

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
- full first access over HTTP in the three login modes with a software passkey; resume needs the
  original cookie and is single use; UV, origin and challenge failures refuse approval;
- revoke, revoke all and kill switch immediate; kill blocks sign-in; release needs a passkey and
  revives nothing; sign-ins approved before a kill or revoke-all cannot resume afterwards;
- scope: absent → default, mixed → supported subset, explicit unsupported-only → `invalid_scope`; kill switch and passkeys survive restart, sessions do not;
- control plane refuses foreign Host, Origin, non-JSON and missing tickets; public listener refuses
  foreign Host and browser Origins;
- T3 catalog: eight reads + write catalog without `leaseId`; write scope shown and frozen; dedupe
  across refresh and sign-ins; unavailable environment and late projects refused; revocation during
  preflight stops the send; journal failure ends all sessions; channel identities and lease ids are
  never accepted by the session gate; no secret or raw identifier in the event log, including
  client-controlled strings.

End to end with ChatGPT (to run, needs authorization): first access with passkey → read and write
→ at least 10 minutes of refresh rotations without a new passkey while calling tools → idle expiry
(short window) → Reconnect + passkey → read and write again, old tokens refused → local revoke and
kill switch → connector restart. Record versions and events without secrets.

The spike (ChatGPT web, 04/10/2026, verdict GO with caveat) already proved, with its own harness:
the localhost passkey detour (button and 302), CIMD with `private_key_jwt` at code and refresh,
early refresh with 60 s access tokens, and recovery of every dead-session case through Reconnect →
Continue → passkey without recreating the connection, the interrupted call resuming without being
resent. Server-side natural idle expiry passed. Pending for the product E2E (not covered by the
spike):

- tool resumption after Reconnect in the natural idle case;
- `private_key_jwt` signature verification against ChatGPT's real JWKS (implemented and unit
  tested here; the spike harness did not verify signatures);
- write tools and ChatGPT's own write confirmation dialog;
- platform authenticator (Touch ID) besides the Bitwarden passkey;
- a real 1 h idle window, measured by a background process rather than an agent polling;
- browser restart, concurrent conversations on the same connection, and mobile.

## 8. Decisions for Marcus (smallest choice made, recommendation)

1. **Ingress.** Implemented: any HTTPS ingress in front of the public listener, issuer fixed by
   configuration. Recommendation: a stable hostname (named tunnel or reverse proxy on a domain you
   control). A quick tunnel changes hostname per run, which changes the issuer and forces a new
   connection each time; fine for rehearsal only.
2. **Persistence across restart.** Implemented: restart ends every session (new passkey sign-in).
   Recommendation: keep it for the first version; persisting sessions needs durable token storage,
   restart-safe clocks and its own review.
3. **Absolute cap.** Implemented: off, to honour "no interaction while active". Recommendation:
   keep off; set `T3_CONNECTOR_OAUTH_MAX_AGE_SECONDS` if a daily passkey is acceptable.
4. **Write catalog.** Implemented: the same actions as the lease path (including `acceptAlways`,
   rollback and full-access launch), limited by the frozen inventory. Recommendation: decide whether
   any of these should be excluded from the session profile before the first real use.
5. **Read scope.** Implemented: reads follow the read config allowlist (`projetosPermitidos`), not
   the write grant. Recommendation: keep; it matches the existing read connector.
6. **Fail closed on uncertain writes.** Implemented: an uncertain send ends every OAuth session
   (parity with the lease gate). Recommendation: keep until real failure modes are observed.
7. **Cut-over.** Not done. The lease bridge stays until an authorized cut-over after the E2E.

## 9. Known limits

- No DPoP / mTLS sender constraint on the ChatGPT hop; bearer profile.
- Single local subject (one passkey owner per installation); multiple passkeys can be enrolled for it.
- Stateless MCP transport: no server-initiated notifications or standalone SSE stream.
- The control plane has no separate admin login; any local process can revoke or kill.
- `/.well-known/openid-configuration` returns the OAuth metadata (no ID tokens, no userinfo),
  because ChatGPT probes it; this is not an OpenID Provider.
