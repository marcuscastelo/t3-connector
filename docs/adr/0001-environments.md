# ADR 0001: one endpoint per environment, chosen on every call

Date: 2026-10-03. Status: accepted.

## Context

The T3 Code client (web/Electron) shows threads from several environments because it
keeps one connection per environment. A server does not aggregate the others:
`GET /api/orchestration/threads/<id>/bounded` for a thread that lives in the remote
environment returns 404 on the local server and 200 on the remote one. HTTP/WS routes act
on the connected server and take no target environment
(`packages/contracts/src/environmentHttp.ts:430-459, 528-562`;
`apps/server/src/orchestration-v2/http.ts:175-222`, upstream commit `8ed276c246b6`).

The same repository registered in two environments gets a different projectId in each
(for example a UUID locally and `mcp-project:<uuid>` remotely).

In the setup that motivated this decision, the remote environment served HTTP on
`0.0.0.0:3773` inside a private network, without HTTPS.

## Options

| Option | Verdict |
|---|---|
| A. Connector with several endpoints; local over loopback, remote through the connector's own `ssh -L` | chosen |
| B. Remote over HTTPS on the private network | requires TLS or a reverse proxy on the remote host |
| C. Local T3 server as a proxy for the remote ones | no such API; would require changing T3 and storing remote auth on the server |

Plain HTTP over the private network works but breaks the loopback-only HTTP rule. The SSH
tunnel keeps that rule and reuses the SSH identity the operator already has
(`ssh <host>`).

## Decision

- The config lists environments by alias. Each has an expected `environmentId`, a
  transport (loopback/HTTPS `url` or `ssh: {host, remotePort}`), its own token file and
  its own `allowedProjects`. (Key and parameter names as renamed by
  [ADR 0004](0004-english-contract.md).)
- Every tool accepts `environment` (alias or environmentId). When omitted, the config
  `default` applies. Waiting requires `environment`.
- There is no mutable global selector: the environment is chosen on every call.
- On connect, the connector checks the descriptor (`environmentId` as expected, protocol
  2) and the session (scopes exactly `orchestration:read`). Any mismatch fails closed.
- Authorization is by the (environment, projectId) pair. A missing thread and an
  out-of-scope thread get the same refusal. When an ID is not found, the connector does
  not search other environments.
- Exception, for discovery only (2026-10-03): `t3_buscar_threads` searches by title or ID
  in every configured environment and returns each candidate with its environment. It
  reads the shell of each environment with that environment's ACL, 4 s per environment
  and 10 s in total; failures are reported per environment and the result is marked
  incomplete instead of failing. It never chooses among candidates. Reads by ID and every
  write action keep requiring a single environment, with no fallback.
- Every response carries `environment: {alias, environmentId}` (`ambiente` before
  [ADR 0004](0004-english-contract.md)).
- The SSH tunnel is a child process of the connector on a free loopback port. It starts on
  the first call to that environment and is recreated if it dies. The connector only
  terminates processes it created.

## Consequences

- An unavailable remote environment does not take the connector down: only calls to it
  fail, with a specific message.
- Each environment issues its own token, paired by the connector itself
  (`t3-connector pair --environment <alias>`) with `scope=orchestration:read`.
- The connector ACL is the only per-project restriction. A T3 read token reaches the
  whole environment.
