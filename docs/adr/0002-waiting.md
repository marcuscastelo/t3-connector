# ADR 0002: short wait over a WS subscription, without polling

Date: 2026-10-03. Status: accepted.

## Context

ChatGPT wants to follow a thread launched through the connector without calling
`t3_thread` in a loop. A voice conversation must remain usable, so a long wait cannot
block the only interaction flow.

Facts gathered (upstream T3 Code commit `8ed276c246b6`, MCP SDK 1.32.0, tunnel-client
0.0.14):

1. The native `t3_thread_wait` is a tool of the app's internal MCP server
   (`apps/server/src/mcp/OrchestratorMcpService.ts:1879-1898`) and requires the
   provider-session bearer. Under the hood, `ThreadManagementService.waitForThread`
   re-reads the projection every 250 ms (`orchestration-v2/ThreadManagementService.ts:610-661`).
   There is no HTTP route or WS RPC for waiting that accepts an environment token.
2. `orchestration.subscribeThread` (WS) only requires `orchestration:read`
   (`auth/RpcAuthorization.ts:24-35`). It delivers a snapshot, a `synchronized` marker and
   live events through PubSub, with no periodic loop (`ws.ts:648-755`). The
   `run.updated` and `runtime-request.updated` events carry the full run and request
   (`packages/contracts/src/orchestrationV2.ts:1514-1576`). The subscription was verified
   in two environments with a read token.
3. The SDK hands `extra.signal` to the handler and aborts it on
   `notifications/cancelled` (`shared/protocol.js:173-179, 338-343`). Through
   `tunnel-client dev proxy`, the client received the cancellation in 102 ms, but the
   handler ran until its own limit (1,502 ms) without an abort. End-to-end cancellation is
   therefore not proven.
4. The real request limit of ChatGPT voice mode is unknown. The client SDK defaults to
   60 s and the local proxy to 30 s.

## Decision

- Tool `t3_aguardar_thread` on top of `orchestration.subscribeThread`.
- `ambiente` and `timeoutMs` are required. `timeoutMs` ranges from 1 to 5,000 ms; for
  voice, 1,000 to 2,000 ms.
- The deadline covers the whole call: connection, authorization, WS ticket, snapshot and
  events. It is not a timer for the waiting phase only.
- Returns immediately when there is no run (`sem_execucao`), when the run already finished
  or when a request is pending (`precisa_intervencao`). Otherwise it returns on the first
  terminal or intervention event, or at the deadline.
- Reaching the deadline with an observed state is a normal result (`timedOut: true`),
  never an error. With no state observed at all (environment down), it is a transport
  error.
- Selected run: the given `runId`, or the latest run when the call starts. A new run that
  starts during the wait does not change the selection.
- `extra.signal` is propagated: cancelling closes only the wait's own resources. Since
  cancellation through the tunnel does not reach the handler, the short ceiling is what
  guarantees the wait ends.
- Never acquires, renews or releases a claim, lease or lock. Never sends a run
  `interrupt`/`cancel`. When done, it sends `Interrupt` only for its own subscription and
  closes the socket.
- To follow a long thread, the client repeats short waits between conversation turns.
  The connector has no asynchronous notification; that would be a separate product
  decision.

## Consequences

- No polling in the connector: only server events. The native 250 ms polling of
  `waitForThread` is not used.
- If a future T3 version exposes waiting over HTTP/WS with a read token, switch the
  implementation and keep the contract.
- If the real voice-mode limit is below 5 s, lower `TETO_MS`.
