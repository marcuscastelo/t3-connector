# Spike: ChatGPT as OAuth MCP client — re-login after `invalid_grant`, passkey on localhost

Status: **harness validated without ChatGPT; ChatGPT rehearsal pending** (needs Marcus for UV and the test connection).

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

_Pending — filled in after the session._

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

## Verdict

_Pending._
