# Spike: ChatGPT as OAuth MCP client — re-login after `invalid_grant`, passkey on localhost

Status: **ChatGPT rehearsal done on 2026-10-04; verdict GO with caveat.** One sub-step (tool resuming after Reconnect in the natural-idle scenario) is not confirmed; see H1.

Validates only the two unchecked blockers of `ARQUITETURA-SESSAO.md` (§1, §3, §8, §9, §13):

- **H1** — after a failed refresh (`invalid_grant`) or a 401 `invalid_token` with a nominally valid AT, ChatGPT restarts authorization (new `/authorize` with PKCE) in a way the user can complete, without deleting/recreating the connection.
- **H2** — during `/authorize` (public HTTPS) the browser can go to `http://localhost:<port>`, complete WebAuthn with `userVerification=required` (RP ID `localhost`), return to `/resume` on the public origin, and ChatGPT receives `code`+`state`+`iss` and exchanges it.

Nothing in `src/`, `bin/` or the stdio contract was changed. The harness imports `src/escrita/webauthn.mjs` and `test/escrita-fixtures.mjs` read-only.

## Harness

| File | Role |
|---|---|
| `harness.mjs` | Toy AS + MCP RS on the public listener (127.0.0.1:7534, behind the quick tunnel) and a local control-plane (localhost:7533, loopback only, never tunnelled). |
| `run.sh up\|down\|status` | Starts a `cloudflared` quick tunnel to 7534 only, then the harness with `PUBLIC_BASE` = tunnel URL. State in `.state/` (gitignored). |
| `e2e-local.mjs` | Node-only proof: client (DCR+PKCE), cookie jar and a software authenticator (UV flag). |
| `chrome-e2e.mjs` | Real browser proof: headless Chrome + CDP virtual authenticator (UV=true) through the public tunnel. |

AS/RS behaviour:

- PRMD (RFC 9728) at `/.well-known/oauth-protected-resource[/mcp]`; AS metadata (RFC 8414) at `/.well-known/oauth-authorization-server` (also served at `openid-configuration` to observe what the client probes).
- Client registration: DCR (`/register`) and CIMD (`client_id` as HTTPS URL) both advertised; whichever ChatGPT uses is logged. `private_key_jwt` assertions are accepted and their shape logged, **signature not verified** (out of scope).
- `/authorize`: `response_type=code`, PKCE `S256` mandatory, `resource` must equal the MCP URL when sent, exact `redirect_uri`. Creates a 10-min transaction bound to a `HttpOnly; Secure; SameSite=Lax` cookie. Three modes:
  - `button`: page with a top-level link to `http://localhost:7533/login#handoff=…` (also shows the out-of-band code as a fallback hint and polls status).
  - `302`: immediate redirect to the same localhost URL.
  - `oob`: page shows a 6-char code; user opens `http://localhost:7533/login` in any tab, types it, approves; the public page polls `/authorize/status` (cookie-bound) and continues to `/resume`.
- Local `/login`: shows client, callback host, scope, resource; WebAuthn assertion with `userVerification: required`, RP `localhost`, origin `http://localhost:7533`; on success the transaction gets a one-time resume handle.
- `/resume?h=…`: requires the transaction cookie, approval, single use; redirects to the client callback with `code`, original `state`, `iss`.
- `/token`: `authorization_code` (PKCE check, code single-use 60 s, redirect/resource match) and `refresh_token` (rotation; reuse → `invalid_grant` + session dead). AT opaque, 60 s. Idle 120 s counted only from `tools/call`; refresh does not renew idle.
- `/mcp`: Streamable HTTP (SDK 1.32.0, stateless, JSON responses), two harmless tools `spike_now`, `spike_echo`. Missing/invalid/expired/revoked token or dead session → 401 with `WWW-Authenticate: Bearer resource_metadata=…, scope=…[, error="invalid_token"]`.
- Local admin (panel at `http://localhost:7533/`, POST endpoints require exact Origin or none): switch mode, fail next refresh (`invalid_grant`), kill sessions (AT → 401, RT → `invalid_grant`), revoke ATs only (RT still valid), add a note to the log.
- Log `.state/events.jsonl`: no tokens, codes, cookies, state or handles in clear (8-hex SHA-256 prefix or booleans). Timestamps UTC in the file; converted to Brasília in this report.

## Pre-ChatGPT evidence (2026-10-03, Brasília)

Environment: macOS 26 (Darwin 25.5.0), Node 22.22.3, cloudflared 2026.5.2, Google Chrome 154.0.8037.93 (headless), harness SDK `@modelcontextprotocol/sdk` 1.32.0, `@simplewebauthn/server` 13.3.3.

1. `e2e-local.mjs` (software authenticator, no tunnel) — **ALL OK** at 21:42: 401+`resource_metadata` → PRMD → AS metadata → DCR → `/authorize` in all three modes → local UV → `/resume` without cookie refused (400) and with cookie → callback with `state` and `iss` checked → `/token` → MCP `initialize` + `tools/call`; refresh rotation; old RT reuse → `invalid_grant` and the new AT → 401 `invalid_token`; forced `invalid_grant`; ATs revoked → 401, then refresh → tool OK.
2. `chrome-e2e.mjs` through the quick tunnel (public HTTPS) — **PASS button, PASS 302, PASS oob** at 21:44. In Chrome 154 the top-level navigation `https://<tunnel>/authorize` → `http://localhost:7533/login` worked by click and by 302; `isSecureContext=true` on localhost; fragment cleared from history; WebAuthn with UV succeeded; return to `https://<tunnel>/resume` carried the `SameSite=Lax` cookie; callback received `code`, `state`, `iss`. The OOB variant completed with the code typed in a second tab while the first tab polled.
3. Local guards: admin POST with foreign `Origin` → 403 `origin_invalid`; wrong `Host` on the local listener → 403.

This proves the mechanism in a normal browser tab. It does **not** prove anything about ChatGPT's linking window, its handling of `invalid_grant`/401, or Firefox-based browsers.

## ChatGPT rehearsal

Session 2026-10-04 (Brasília). ChatGPT web in a Firefox-based browser (server log UA `Firefox/157.0`; Zen/Twilight), macOS. One test app created in Developer mode (no duplicates), pointing to the quick tunnel `https://<redacted>.trycloudflare.com/mcp`. ChatGPT UI actions were driven by a computer-use executor; the passkey UV (Touch ID) was done by Marcus. Fresh state dir; harness commit `ad2727c` unchanged.

### H2 — button variant: PASS

Events (`.state/events.jsonl`, times converted to Brasília, tokens/codes only as hash prefixes):

| Time | Event |
|---|---|
| 23:55:35 | `local.enrolled` — test passkey for RP `localhost` |
| 00:00:25 | `mcp.401 no_token` → `discovery` PRMD, AS metadata, and also `/.well-known/openid-configuration` (UA `Python/3.14 aiohttp/3.13.5`) |
| 00:01:35 | `client.cimd` — `client_id=https://chatgpt.com/oauth/client.json`, `token_endpoint_auth_method=private_key_jwt`, `redirect_uris=[https://chatgpt.com/connector_platform_oauth_redirect]`, `jwks` present |
| 00:01:35 | `authorize` — CIMD, `response_type=code`, PKCE `S256`, `state` present, `resource=<BASE>/mcp`, `scope="spike:read spike:write"` |
| 00:01:42 | `local.login_page` — top-level navigation to `http://localhost:7533/login`, `Sec-Fetch-Site: cross-site`, no Referer |
| 00:01:46 | `local.uv_ok` — WebAuthn assertion with UV verified (`userVerification=required`) |
| 00:01:46 | `resume` — transaction cookie present and valid (`SameSite=Lax` survived the localhost detour) |
| 00:01:46 | `callback.redirect` → `chatgpt.com` with `code`, original `state`, `iss` |
| 00:01:50 | `token.issued` — `authorization_code`, client auth `private_key_jwt` (assertion `iss=sub`, `aud=<BASE>/token`, `jti` present), PKCE ok |
| 00:01:51–55 | `token.refreshed` ×2 (also `private_key_jwt`), then `mcp.ok`: `server/discover`, `initialize`, `notifications/initialized`, `tools/list` |
| 00:02:44–45 | `token.refreshed` → `mcp.ok initialize` → `mcp.ok tools/call:spike_echo` (chat returned `echo: oauth-spike-e2e-20261004`, per the executor's report) |

Observations:

- ChatGPT used **CIMD with `private_key_jwt`** (not DCR), at authorization-code **and** refresh. Signature not verified by the harness (out of scope).
- ChatGPT refreshes eagerly: two refreshes within 5 s of the code exchange, and another right before the tool call, although the AT (60 s) was still valid.
- No browser block on HTTPS → `http://localhost` → HTTPS in this browser.
- **Not observed conclusively:** whether the linking window was a popup or a tab, whether it closed by itself, and the exact Touch ID UI. Not recorded here.
- The harness idle was raised from 120 s to 1800 s at 00:02:11 (logged with `mark`) so the happy path would not expire; natural idle is tested separately below.

### H2 — 302 variant: PASS

Step A (00:13–00:15): login mode switched to `302`. After `Reconnect → Continue`, `/authorize` at 00:15:00.388 answered 302 and the browser was on `http://localhost:7533/login` 0.25 s later (`Referer: chatgpt.com`, `Sec-Fetch-Site: cross-site`), with no intermediate button page. UV at 00:15:29, `/resume` with valid cookie, callback with `code`/`state`/`iss`, `token.issued` at 00:15:33 (session `s3`), `tools/call:spike_now` at 00:15:38. Repeated in C2 and B with the same result.

The passkey was served by **Bitwarden** in the browser (the executor selected `oauth-spike` in the Bitwarden prompt); no Touch ID prompt or browser security warning was observed. The harness verified the UV flag on every assertion (`userVerification=required`), but what Bitwarden does to assert UV (vault unlock state) was not inspected.

### H1 — failed refresh / dead session

All scenarios on the same test app; it was never deleted, disconnected or recreated. UI text and clicks come from the computer-use executor's reports; server events from `.state/events.jsonl`.

| Scenario | Server-side trigger | What ChatGPT did (log) | UI (executor) | Recovery |
|---|---|---|---|---|
| H1a — `invalid_grant` on refresh | 00:03 next refresh forced to fail; session `s1` killed on use | 00:06:29 `refresh_token` → `invalid_grant`; 00:07:15 new `/authorize` (PKCE S256, new `state`) — 46 s later, after the user clicked | "connection expired", **Reconnect** | Reconnect → Continue → Open local control → Approve with passkey; 00:07:37 token (`s2`), 00:07:44 `tools/call` **resumed without resending** |
| Step A — dead session, AT expired | `s2` killed 00:08:03, AT 60 s already expired | 00:14:13 `refresh_token` → `invalid_grant` | Reconnect | 302 path, `s3`, tool 00:15:38 |
| H1c — 401, RT still valid | 00:15:55 AT revoked only (RT valid, AT TTL 3600 s) | 00:16:36 `tools/call` and `initialize` → 401 `invalid_token`; discovery re-read; **no `/token` call** — the valid RT was never used | "Your OAuth spike (test) connection has expired. Reconnect it before ChatGPT can use it for this request." **Not now** / **Reconnect** | C2: Reconnect → 302 → passkey; 00:19:13 token (`s4`), 00:19:18 tool |
| H1b — 401, session dead, AT nominally valid | 00:20:00 session `s4` killed, its AT valid for ~1 h | 00:20:33 401 `session_admin_kill` on `tools/call` and `initialize`; **no `/token` call** | same text, Not now / Reconnect | Reconnect → 302 → passkey; 00:22:01 token (`s5`), 00:22:08 tool |
| Natural idle | idle limit 120 s from 00:22:28, no admin action; last `tools/call` 00:22:08 | 00:24:11 `s5` dead `idle_expired`; 00:24:45 401 `session_idle_expired` on `tools/call` and `initialize`; **00:24:46 `refresh_token` → `invalid_grant` (`session_idle_expired`)** | same text, Not now / Reconnect; Reconnect clicked → "Continue to OAuth spike (test)" shown | _see below_ |

Findings:

- Recovery always required one manual **Reconnect** (plus Continue and the passkey). ChatGPT never opened the login by itself after a refresh failure or a 401.
- Recovery never required deleting or recreating the connection, and the interrupted tool call resumed after login without being resent.
- After a 401, ChatGPT did **not** try the refresh token in H1c and H1b, but **did** try it once in the natural-idle case (00:24:46, refused with `invalid_grant`). The trigger for that difference is not known; no conclusion is drawn about ChatGPT never refreshing after a 401.
- With a 60 s AT, ChatGPT refreshed proactively (right after the code exchange and before calls). With a 3600 s AT it called with the existing AT. Both refreshes and 401 handling are compatible with: refresh does not renew idle, a dead session (idle or revoked) refuses both the AT and the RT, and recovery costs Reconnect plus a new UV.
- Natural idle, server side: PASS. The session expired by itself and both the nominally valid AT and the RT were refused. Recovery: the Reconnect screen opened, but the computer-use executor lost window focus to another executor sharing the same screen, then could not raise the tab automatically. **Not confirmed:** after the GUI was released (00:51), the executor tried three automatic ways to raise the tab (Raise, tab-bar shortcut, tab list) and all failed; no `/authorize` reached the harness between 00:51 and 03:39. The recovery path itself is identical to H1a, step A, C2 and H1b (all four completed and resumed the tool), but it was not observed after natural idle.

### Script

Preparation (agent): `./run.sh up` → public MCP URL; panel at `http://localhost:7533/`.

1. In the same browser used for ChatGPT, open `http://localhost:7533/enroll` → "Create passkey" (test passkey `oauth-spike`, RP `localhost`).
2. ChatGPT → Settings → Apps/Connectors → Advanced → Developer mode on → create an app/connector: name `OAuth spike (test)`, URL = the MCP URL, authentication OAuth. Create. (mode `button`)
3. Login window/tab: "Open local control (localhost)" → "Approve with passkey" → UV → back to ChatGPT. Note: popup or tab, any warning, whether it closed by itself. **[H2 button]**
4. New chat with the app enabled: "call spike_now". Wait ~90 s, call again (silent refresh expected).
5. Panel: "Fail next refresh". Wait ~70 s (AT expires), call `spike_now`. Do only what ChatGPT offers (no deleting the app). Note exactly what appears. If it offers login, complete it. **[H1 invalid_grant]**
6. Panel: mode `302`. Then "Kill sessions" and call `spike_now` right away (AT still valid). Note UI; complete re-login if offered. **[H1 401 + H2 302]**
7. Panel: "Revoke ATs only", call `spike_now`. Expect silent refresh and success. **[H1 401 with live RT]**
8. Leave the chat idle > 2 min (idle 120 s), then call `spike_now`. **[H1 natural idle]**
9. If 3 or 5 failed: panel mode `oob`, retry the login via what ChatGPT offers, use the code. **[H2 fallback]**
10. Cleanup: delete the test app in ChatGPT; delete the `localhost / oauth-spike` passkey from the passkey manager.

## Verdict: GO with caveat

| Hypothesis | Variant | Result |
|---|---|---|
| H2 | button (top-level link to localhost) | **PASS** |
| H2 | automatic 302 to localhost | **PASS** |
| H2 | out-of-band code fallback | not needed with ChatGPT (passed only in the Chrome rehearsal) |
| H1 | `invalid_grant` on refresh | **PASS with manual action**: Reconnect → Continue → passkey, no connection recreated, call resumed |
| H1 | 401 with RT still valid (AT revoked) | **PASS with manual action**; ChatGPT did not try the RT |
| H1 | 401 with session dead, AT nominally valid | **PASS with manual action**; ChatGPT did not try the RT |
| H1 | natural idle | server side **PASS** (AT and RT refused; ChatGPT did try one refresh → `invalid_grant`); Reconnect prompt shown; tool resumption after re-login **not confirmed** (GUI focus, not OAuth) |

Per the go/no-go rule: H2 passes without recreating the connection, and H1 needs a simple manual action (Reconnect) but never a recreated connection, so the result is **GO with caveat**.

UX cost to accept in the architecture:

- every dead session (idle, revocation, kill switch, authority restart) costs the user Reconnect + Continue + passkey; ChatGPT does not start the login by itself;
- `401` never led to a successful silent refresh here, so ordinary token expiry must happen by ChatGPT's proactive refresh (short AT), never by 401;
- the localhost passkey requires the browser on the same host as the control-plane; mobile or remote browsers were not tested.

Limits of this evidence:

- one browser (Firefox 157-based Twilight), one ChatGPT account, one day; ChatGPT behaviour can change without notice;
- passkey served by Bitwarden; Touch ID / platform authenticator not exercised;
- the harness did not verify the `private_key_jwt` signature;
- popup-versus-tab and whether the linking window closed by itself were not observed conclusively;
- no write tool and no ChatGPT write-confirmation dialog were exercised (the tools were read-only);
- AT/RT behaviour across a browser restart, a long (1 h) real idle, and concurrent conversations was not tested.

Teardown: run `./run.sh down`, delete the test app in ChatGPT, and delete the `oauth-spike` passkey (RP `localhost`) from Bitwarden.
