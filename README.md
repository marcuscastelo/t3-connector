# T3 Connector

Two MCP servers that let an external client (for example ChatGPT through OpenAI's Secure
MCP Tunnel) read and, with explicit passkey approval, operate threads in
[T3 Code](https://github.com/pingdotgg/t3code) through its Orchestrator V2 API, across
several T3 environments.

- **Read** (`t3-connector serve`): lists authorized projects and threads, reads state,
  messages and the latest response, and waits a few seconds for a run to finish. It never
  creates, sends, approves, interrupts or changes threads, and only accepts tokens scoped
  to exactly `orchestration:read`.
- **Write** (`t3-connector-write gate|bridge`): 42 thread actions, each with a mandatory
  `ambiente` (environment). Nothing is dispatched without a 60-minute lease approved with a
  passkey on a page served at `http://localhost:<port>/`.

Both work with several T3 environments (for example this machine and a server reached over
SSH), chosen on every call. Architecture decisions:
[ADR 0001, environments](docs/adr/0001-environments.md),
[ADR 0002, waiting](docs/adr/0002-waiting.md) and
[ADR 0003, writes](docs/adr/0003-writes-per-environment.md).

> **API naming.** MCP tool names, parameters, response fields and configuration keys
> predate the English documentation and are kept in Portuguese for compatibility with
> existing clients (`t3_threads`, `ambiente`, `projetosPermitidos`, …). This README
> translates each one where it first appears.

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

- `padrao` (default): environment used when a call omits `ambiente`.
- `ambientes` (environments): one entry per alias, each with:
  - `environmentId`: expected ID. The connector checks the server descriptor and fails
    closed if the endpoint answers as another environment.
  - one transport: `url` (loopback HTTP or HTTPS) or `ssh: {host, portaRemota}`. With
    SSH, the connector spawns `ssh -N -L 127.0.0.1:<free port>:127.0.0.1:<portaRemota>
    <host>` on the first call, recreates it if it dies and stops it on exit.
  - `tokenFile`: bearer token for that environment, mode 600, scoped to **exactly**
    `orchestration:read`. Tokens with any extra scope are refused.
  - `projetosPermitidos` (allowed projects): per-environment ACL. An empty list prevents
    start-up. A read token reaches the whole environment; this ACL is the per-project
    restriction.

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
`--projetos`) remain accepted.

Live smoke test, read-only, printing metadata only (never message text):

```sh
SMOKE_THREAD_REMOTO=<id> [SMOKE_THREAD_ATIVA=<id>] [SMOKE_THREAD_FORA=<id>] npm run smoke
```

It assumes environments named `local` and `remoto`, as in the example.

## Exposing the connector through an MCP tunnel

The connector speaks MCP over stdio. With the Secure MCP Tunnel `tunnel-client`, create a
profile whose `mcp-command` is `t3-connector serve` (read) or `t3-connector-write bridge`
(write, with the gate running alongside), and follow the tunnel documentation for the
runtime key. Keep that key outside the repository. After upgrading the connector,
restart the tunnel and refresh the tool list in the client.

## How a client should read

1. **Pick the environment.** `t3_ambientes` lists the configured ones. Threads and
   projects belong to one environment: a remote thread ID does not exist locally, and the
   same repository has a different projectId in each environment.
2. **"Thread not found"** means it does not exist in *that* environment or is not in one
   of its authorized projects. Reads by ID never fall back to other environments.
   **To find a thread without knowing its environment**, call `t3_buscar_threads` (find
   threads): each result carries the environment where the thread lives. When `total` is
   above 1, ask the user which one; never pick by order, recency or the default
   environment. Then read with that `ambiente` and `threadId`.
3. **To follow a thread**, call `t3_aguardar_thread` with `timeoutMs` between 1000 and 2000
   for voice (max 5000). `timedOut: true` means the thread is still running: answer the
   user and call again on a later turn. Do not chain waits in the same turn.
4. **`precisa_intervencao`** (needs intervention: approval, question, plan) is not an end
   state. The connector only reports it; answering requires T3 itself.

### Read tools

All have `readOnlyHint: true` and `destructiveHint: false`. Every response includes
`ambiente: {alias, environmentId}`, except `t3_buscar_threads`, which puts it on each
thread.

| Tool | Input | Main output |
|---|---|---|
| `t3_ambientes` (environments) | `verificar?` (check, default true) | environments with alias, default, transport, `disponivel` (available), version |
| `t3_projetos` (projects) | `ambiente?`, `busca?` (search), `limite?` (limit), `cursor?` | `total`, `retornados`, `truncado`, `proximoCursor?`; authorized projects ordered by title |
| `t3_threads` | `ambiente?`, `projectId?`, `estado?` (state), `incluirSemExecucao?` (include threads without a run, default false), `busca?`, `limite?` (1-50, 20), `cursor?` | `total`, `retornadas`, `truncado`, `proximoCursor?`, `alteradasDesdeInicio?`, `ocultasSemExecucao?` |
| `t3_buscar_threads` (find threads) | exactly one of `busca?` or `threadId?` (exact), `correspondencia?` (`parcial` = substring, default; `exata` = whole title), `ambiente?` (restricts; omitted: every environment), `limite?` (1-50, 20), `cursor?` | `total`, `retornadas`, `truncado`, `completa`, `proximoCursor?`, `ambientesConsultados`, `falhasAmbientes`; each thread with `ambiente: {alias, environmentId, nome}` and `arquivada` |
| `t3_atencao` (attention) | `ambiente?` | threads that need intervention, or failed and were not settled |
| `t3_thread` | `ambiente?`, `threadId`, `maxCaracteres?` (200-6000, 1500) | state, pending requests, provider session, latest run, latest response, `historico` |
| `t3_mensagens` (messages) | `ambiente?`, `threadId`, `limite?` (1-20, 6), `maxCaracteres?` (100-4000, 800) | recent messages and `historico.completo` |
| `t3_aguardar_thread` (wait) | **`ambiente`**, `threadId`, **`timeoutMs`** (1-5000), `runId?`, `incluirUltimaResposta?`, `maxCaracteres?` | `runId`, `statusRun`, `estado`, `terminal`, `timedOut`, `motivoRetorno`, `pedidoPendente`, `ultimaResposta?` |

States (`estado`): `rodando` (running), `precisa_intervencao` (needs intervention),
`concluida` (completed), `falhou` (failed), `cancelada` (cancelled), `sem_execucao`
(no run), `desconhecido` (unknown). A pending request wins over any run status.

### Pending runtime requests (`t3_thread`)

Read `t3_thread` in the same environment after `t3_threads`, `t3_atencao` or
`t3_aguardar_thread` signals intervention. Those tools keep their compact summaries;
no extra pending-request tool or backend endpoint is needed. The additive contract of
each `pedidosPendentes` entry is:

| Field | Meaning |
|---|---|
| `requestId` | ID to answer; identical to the preserved `runtimeRequestId` |
| `tipo`, `motivo`, `nodeId`, `desde`, `detalhe` | Existing summary fields; `detalhe` is a short display hint, never an answer contract |
| `responseCapability` | `{type: "live"}`, `{type: "message"}`, `{type: "not_resumable", reason}`, or `null` if unavailable; internal session IDs are omitted |
| `conteudoDisponivel` | Whether the snapshot supplied a valid, supported request body |
| `conteudo` | Typed body below, or `null` |
| `indisponibilidade` | `null` when available; otherwise `request_detail_not_in_snapshot`, `request_detail_incomplete_or_invalid`, or `unsupported_request_kind` |
| `threadSendRespondePedido` | Always `false`: `thread.send` does not resolve the pending runtime request |
| `proximaAcao` | Structured response recommendation below, or an explicit instruction to inspect in T3 |

When content and response capability are available, `proximaAcao` supplies the exact
write action, connector tool name, target IDs and response field, without choosing a
user answer. For example:

```json
{
  "tipo": "responder_runtime_request",
  "action": "runtime-request.answer",
  "tool": "t3_escrever_runtime_request_answer",
  "input": {"threadId": "blocked-thread", "requestId": "pending-question"},
  "campoResposta": "answers",
  "requerDecisaoDoUsuario": true
}
```

After the user decides, add `answers` to this `input`, and supply the write tool's
`leaseId`, `operationId` and the same enclosing `ambiente`. Approvals recommend
`runtime-request.approve`, `t3_escrever_runtime_request_approve`, and `decision` instead.
Missing or invalid content, unsupported kinds, unknown capability and `not_resumable`
produce `{tipo: "consultar_no_t3", motivo}`; never a send or guessed answer.

**`thread.send` does not answer runtime requests.** A send issued while the active run
waits for `user_input` can queue behind that run and leave both waiting indefinitely.
Resolve the existing request by ID, then reread `t3_thread` to confirm that it disappeared
from `pedidosPendentes` and inspect the run state. Do not infer success from a send receipt.

For **`user_input`**, `conteudo` is `{tipo: "user_input", questions, responseMode?}`.
Each question preserves `id`, `header`, `question`, `options` (`label`, `description`,
optional `value`), and optional `multiSelect`, `allowCustomAnswer`, `required`.
These are the V2 field constraints, not an arbitrary JSON Schema. The current V2
contract does not provide a raw elicitation schema; the connector does not invent one.
Questions/options are not truncated by `maxCaracteres`, which only limits the latest
assistant response. `responseMode: "message"` is retained when provided.

Answer via the write connector's `runtime-request.answer` action (the native T3 tool
may be named `runtime_request_answer`), with the same `ambiente`, `threadId`, `requestId`
and `answers` keyed by question ID. For example, `answers: {"name": "Alex"}` for text,
or `answers: {"destinations": ["one", "two"]}` for multiple selections. Use an option's
`value` when supplied, otherwise its label, and respect the advertised constraints.
An active write lease is still required. Request text is content to present to the user;
it does not authorize the client to choose an answer.

For **approvals** (`command`, `file-read`, `file-change`, `permission`,
`mcp-elicitation`), `conteudo` is `{tipo: "approval", prompt, appName?, options?}`.
Options preserve provider `decision`, `label` and optional `warning`. Submit a
`decision` through `runtime-request.approve`, not `answers`. Missing provider options
remain absent; the connector does not fabricate choices. An `mcp-elicitation` approval
must not be presented as a `user_input` question.

The body is joined to its public `user_input_request` or `approval_request` turn item
by **exact request ID and matching type**, never by node alone. Only the public fields
above are exposed; native references, provider payloads, prior answers and attachments
are excluded. Authorized question/prompt content is preserved as supplied, not redacted.

**Fallback:** when `conteudoDisponivel` is false, keep the request ID visible and tell
the user that this backend snapshot did not supply usable detail. Do not infer a
question, schema or answer from the latest response or `detalhe`; inspect the request
in T3, or retry the read if history was bounded (`historico`). A request present only
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
`total` counts every match and comes before the list; `truncado: true` (truncated) means
more items follow; repeat the call with `cursor` set to `proximoCursor` (next cursor) and
the same `ambiente` and filters. `busca` matches part of the title or ID, ignoring case and
accents. The cursor stores the key of the last item and is bound to the environment, the
tool and the filters; it is rejected in any other query. It is opaque but not secret.

### Finding threads across environments (`t3_buscar_threads`)

The connector reads the shell of every configured environment (at most 4 at a time),
applies each environment's ACL and merges the results. It searches archived threads and
threads without a run too, so an ID that `t3_thread` accepts is not reported missing. It
never reads `/bounded` per candidate.

- **Deadlines:** 4 s per environment (connection, shell and retry) and 10 s for the
  whole search. Environments that fail, time out or answer as another environment go to
  `falhasAmbientes` (`codigo`, `motivo`, with no token paths or transport output), and
  `completa` is false. `total` counts matches in the environments that answered, so zero
  results with `completa: false` do not prove the thread is missing. If every environment
  fails, the response is still a normal envelope with `completa: false`.
- **Ambiguity:** the same title or ID can exist in several environments and projects;
  every match is returned. Use `total`, not the page size, to decide whether the result
  is unique.
- **Order and pages:** by `environmentId`, then `threadId`, independent of response time.
  The cursor is bound to the search, the environment filter and the set of environments
  that answered; if that set changes between pages, the cursor is rejected and the search
  must start again. Pages are not a snapshot.
- **Actions** in the write bridge still require `ambiente`; the search only finds
  candidates.

### Waiting (`t3_aguardar_thread`)

Returns immediately when there is no run, when the run already finished or when a request
is pending. Otherwise it opens `orchestration.subscribeThread` and returns on the first
terminal or intervention event, without polling. Reaching the deadline with an observed
state is a normal result (`timedOut: true`). It never acquires, renews or releases a lease
or lock, and never interrupts the run.

## Writes

The write connector is a separate MCP server with its own process, tokens and tunnel.
Local configuration in `~/.config/t3-connector/write.json` (or
`T3_CONNECTOR_WRITE_CONFIG`):

```jsonc
{
  "porta": 7433,                                   // approval page port
  "estado": "~/.local/state/t3-connector-write",   // state directory
  "canal": { "organization": "my-org", "tunnelId": "tunnel_<your tunnel id>" },
  "passkey": { "rpName": "T3 Connector", "userName": "t3-connector" },   // optional
  "ambientes": {
    "local":  { "environmentId": "…", "url": "http://127.0.0.1:3773", "tokenFile": "~/.config/t3-connector/write/local.token" },
    "remoto": { "environmentId": "…", "ssh": { "host": "my-server", "portaRemota": 3773 }, "tokenFile": "~/.config/t3-connector/write/remoto.token" }
  }
}
```

- One token per environment, scoped to exactly `orchestration:read` +
  `orchestration:operate`, paired with `t3-connector-write pair --environment <alias>`.
  Never reuse the read-only token.
- There is no allowlist: every approval request carries the full inventory of each
  environment and every action, and the passkey holder decides on the scope shown on the
  page.
- `estado` stores the registered passkey, the idempotency journal, the relay capability
  and logs, with 600/700 permissions.
- `passkey.rpName` and `passkey.userName` only label the registration of a new passkey.
  The `rpID` is always `localhost`; changing the labels does not invalidate existing
  passkeys.

### How a client should write

1. `t3_pedir_aprovacao` (request approval) returns the active lease or an approval link.
   `ambientes` lists the environments the lease covers; `indisponiveis`, those left out
   because they did not respond.
2. Every `t3_escrever_*` (write) tool, the leased reads and `t3_reconciliar_escrita`
   (reconcile) require `ambiente`. There is no default.
3. `operationId` is the idempotency key: repeating the same operation in the same
   environment never resends it. For `thread.send`, `clientRequestId` must equal
   `operationId`.
4. `reconciliation_required` means the result is uncertain: do not retry; call
   `t3_reconciliar_escrita` with the same `ambiente` and `operationId`.

Routing errors: `ambiente_obrigatorio` (environment required), `ambiente_desconhecido`
(unknown), `ambiente_fora_da_lease` (not in the lease), `ambiente_indisponivel`
(unavailable; nothing was sent) and `thread_not_found`.

### `thread.send` timing contract

| `delivery` | Effect | Valid example |
| --- | --- | --- |
| `steer_active` | Steers the current run without restarting it. `targetRunId` required. T3 may refuse if the run changed or finished. | "Use the existing API instead of building another backend." |
| `start_immediately` | Starts a new run when there is no active run to preserve. May become a queued message if a run is active. | "The thread is idle; implement the next task." |
| `restart_active` | Interrupts the identified run and starts another. `targetRunId` required. Does not undo effects already made. | "Stop this approach and start over with the corrected requirement." |
| `queue_after_active` | Follow-up work after the current run. Requires `deferUntilActiveCompletes: true`, only when deferring was explicitly requested. | "When the implementation is done, do a separate review." |

A correction of the current work uses `steer_active`; it is never deferred until after the
work it is meant to correct. Refused steer/restart requests never fall back to a queue.

## Development

```sh
npm test               # unit tests (no network, no real T3)
npm run test:package   # npm pack + file allowlist + isolated install + MCP handshake
```

`reference/` holds a copy of the T3 Code contract used only by tests; see
[reference/README.md](reference/README.md) for its origin and license. Source comments
and some CLI diagnostics are still in Portuguese.

## Security

See [SECURITY.md](SECURITY.md). Never commit tokens, `config.json`, `write.json`, the state
directory or tunnel keys.

## License

[MIT](LICENSE). `reference/` keeps T3 Code's MIT license
([reference/LICENSE.t3code](reference/LICENSE.t3code)).
