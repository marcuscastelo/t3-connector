# ADR 0004: English public contract, with the Portuguese names as deprecated aliases

Date: 2026-10-04. Status: proposed (not released).

## Context

The repository and its documentation are in English, but the MCP contract kept the names
of the private prototype: `ambiente`, `busca`, `limite`, `estado`, `projetosPermitidos`,
and so on. 0.5.0 translated descriptions only and declared the names stable. Clients
already call the tools with those names, and existing configuration files use those keys.

Constraints found in the code (SDK 1.32.0, Zod 4):

- The SDK builds the input object from the registered shape and **silently drops**
  unknown top-level keys before the handler runs. Sending `environment` to 0.5.0 is
  ignored, not refused; sending both names cannot be detected unless both reach the
  handler.
- The SDK has no notion of parameter aliases. JSON Schema can list two properties, not two
  names for one field.
- Write action inputs (`input`) are strict and already English. The dispatch hash covers
  the action ID and the parsed `input`, not the envelope (`leaseId`, environment,
  `operationId`), so renaming the envelope does not change operation hashes or journal
  keys. The channel identity prefix `canal:` is part of the persisted journal key and is
  internal; it stays.
- The write bridge and the gate are separate processes that talk through a private relay.
  After an upgrade the gate may still run the previous version until restarted.

## Decision

1. **Parameters are English in `tools/list`.** Each tool advertises only the English
   name; required fields keep `required` in the JSON Schema.
2. **The Portuguese names stay accepted as hidden, deprecated aliases.** The tool input
   object lets extra keys through and `src/parametros.mjs` maps them to the English name.
   The alias value is validated with the same schema as the English field.
3. **Both names with different values fail** with `parameter_conflict`; equal values are
   accepted. Enum values follow the name: the English name takes English values only, and
   the legacy name takes its legacy values only (`estado: "rodando"` or
   `state: "running"`, never `state: "rodando"`).
4. **Configuration keys are English** in both config files, with the previous keys
   accepted. The same key in both spellings with different values is refused at
   start-up. The write config keeps refusing allowlist keys in any spelling
   (`projetos`, `acoes`, `projetosPermitidos`, `projects`, `actions`, `allowedProjects`).
5. **The private relay keeps the previous names** (`ambiente` and the Portuguese read
   parameters). It is not a client contract, and a gate on the previous version still
   understands a new bridge.
6. **Tool names do not change here.** `t3_projetos`, `t3_escrever_*` and the others are
   kept. Renaming them is a separate decision (see Open questions).

### Parameter migration

| Previous name | English name | Tools |
|---|---|---|
| `ambiente` | `environment` | every read tool except `t3_ambientes`; every write tool except `t3_pedir_aprovacao` |
| `busca` | `search` | `t3_projetos`, `t3_threads`, `t3_buscar_threads` |
| `limite` | `limit` | `t3_projetos`, `t3_threads`, `t3_buscar_threads`, `t3_mensagens` |
| `estado` | `state` | `t3_threads` |
| `incluirSemExecucao` | `includeNoRun` | `t3_threads` |
| `correspondencia` | `match` | `t3_buscar_threads` |
| `maxCaracteres` | `maxCharacters` | `t3_thread`, `t3_mensagens`, `t3_aguardar_thread` |
| `incluirUltimaResposta` | `includeLatestResponse` | `t3_aguardar_thread` |
| `verificar` | `check` | `t3_ambientes` |

| Previous value | English value | Parameter |
|---|---|---|
| `rodando`, `precisa_intervencao`, `concluida`, `falhou`, `cancelada`, `sem_execucao`, `desconhecido` | `running`, `needs_intervention`, `completed`, `failed`, `cancelled`, `no_run`, `unknown` | `estado` → `state` |
| `parcial`, `exata` | `partial`, `exact` | `correspondencia` → `match` |

### Configuration migration

| Previous key | English key | File |
|---|---|---|
| `padrao` | `default` | read |
| `ambientes` | `environments` | read, write |
| `projetosPermitidos` | `allowedProjects` | read |
| `ssh.portaRemota` | `ssh.remotePort` | read, write |
| `porta` | `port` | write |
| `estado` | `stateDir` | write |
| `canal` | `channel` | write |

CLI flags already had English names (`--environment`, `--projects`, `environments`,
`diagnose`); the Portuguese ones remain.

### New error codes

`parameter_conflict`, `parameter_invalid` (invalid value in a deprecated alias) and
`parameter_required`. A write call with neither `environment` nor `ambiente` still fails
with `ambiente_obrigatorio`, before anything reaches the relay.

## Consequences

- Existing calls and configuration files keep working without change. A client that
  re-reads `tools/list` sees only the English names.
- An unknown key is still ignored, as before; only the known aliases are inspected.
- Cursors issued before the change stay valid: their signature uses internal labels, not
  parameter names.
- The aliases are part of the public contract until a release that announces their
  removal. Removing them is a breaking change.

## Open questions

- **Tool names.** English names (`t3_projects`, `t3_search_threads`, `t3_write_<action>`,
  …) would need either a second registration per tool, doubling the write catalog to 91
  entries in `tools/list`, or a hidden name resolver in front of the SDK's tool dispatch.
  Both have costs for clients that choose tools from the list. Not decided here.
