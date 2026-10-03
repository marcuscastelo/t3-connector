# ADR 0003: writes routed per environment, behind a passkey-approved lease

Date: 2026-10-03. Status: accepted.

## Context

Reads (0.2.0) already chose the environment on every call (ADR 0001). Writes lived in a
separate prototype, without Git, bound to a single environment: fixed URL, token,
environmentId and destination; a lease scope with one environment only; guarded reads
with a project hard-coded. ChatGPT could not continue a thread living in a remote
environment.

## Decision

1. **Same repository, separate MCP servers.** Writes move into this repository
   (`src/escrita`, `bin/t3-connector-write.mjs`, `web/`). They keep their own process,
   token, tunnel and client plugin. The read server stays lease-free and has no mutating
   tools; losing or revoking one does not affect the other.
2. **`ambiente` is required** on every write tool, guarded read and reconcile (alias or
   environmentId). Writes have no default environment. Missing →
   `ambiente_obrigatorio`; unknown → `ambiente_desconhecido`. There is never a fallback.
3. **Lease scope v2:** `{scopeVersion: 2, runtimeMode, environments: [grant]}`, one grant
   per environment with `alias`, `environmentId`, `destination` (`t3://<environmentId>`),
   projects, actions and readable projects. The gate authorizes the (environment, project)
   pair; an environment outside the lease → `ambiente_fora_da_lease`.
4. **Full inventory in each request.** Every request carries the whole inventory of each
   environment at that moment and every action. The config has no project or action
   allowlist: the control is the passkey holder reviewing the scope shown on the page,
   grouped by environment. Environments that do not respond are left out and listed in
   `indisponiveis`. A new project or environment only enters with a new request and a new
   passkey assertion.
5. **One connection per environment.** Tokens scoped to exactly `orchestration:read` +
   `orchestration:operate` per environment; remote environments use the same SSH
   transport as reads. The WS opens on demand before the gate's final check. If it drops,
   pending operations become uncertain and only new operations open another socket:
   nothing is resent.
6. **Dedup stable across restarts.** The channel identity no longer includes the boot
   (`canal:<org>|securetunnel:<tunnelId>`), and the journal key is
   `['v2', environmentId, destination, channel, operationId]`. The same operationId in
   another environment is a different operation; in the same environment it is never
   resent.
7. **Workspace checked where the work runs.** Same rule as the prototype in every
   environment: an existing worktree must have a canonical path equal to an approved root.
   `realpath` runs where the thread executes: locally for the local environment, through
   `ssh <host> realpath -e` for remote ones. Creating a new worktree is still refused
   (`workspace_plan_required`).
8. **Guarded reads and reconcile in the gate.** The separate read sidecar is gone: the
   relay has `read` and `reconcile` per environment, checking the lease before and after.

## Consequences

- A refusal before sending returns the reason (`thread_not_found`, `scope_denied`,
  `ambiente_*`, `workspace_*`); after sending without an answer it returns
  `reconciliation_required` and the lease closes, as before.
- The new journal lives in the `estado` directory of the write config. The prototype
  journal is not migrated: its keys included the boot, so they no longer deduplicated
  across restarts.
- Upgrading requires restarting the gate (in-memory lease), a new passkey approval, and
  refreshing the tool list in the client when the catalog changes.
