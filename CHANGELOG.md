# Changelog

## Unreleased

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
