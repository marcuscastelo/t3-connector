# ADR 0004: English public contract, with Portuguese input names as deprecated aliases

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
6. **Responses are English only.** Response fields, state and return values, search
   failure codes, write error codes and connector-generated messages are renamed, with no
   Portuguese duplicate in the payload. This is a breaking change for any client that
   reads fields by name; it is listed in the changelog and needs a release that says so.
   Duplicating every field would double payloads that clients already cut when large, and
   keep two names alive for each value with no way to retire them.
7. **The bridge translates what the gate returns.** Mutation and reconcile results
   (`ambiente` → `environment`), the approval summary and the gate's error codes are
   renamed in the bridge. Leased reads return what the gate's read server produces, so
   they switch to English when the gate restarts on the new version.
8. **Tool names do not change here.** `t3_projetos`, `t3_escrever_*` and the others are
   kept, and `nextAction.tool` keeps naming the existing tool. Renaming them is a separate
   decision (see Open questions).

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

### Response migration

| Previous field | English field | Where |
|---|---|---|
| `ambiente` | `environment` | envelope of every read and write result; search items; wait result |
| `padrao`, `ambientes` | `default`, `environments` | `t3_ambientes`, `t3-connector environments` |
| `transporte`, `projetosAutorizados`, `disponivel`, `nome`, `versao`, `erro` | `transport`, `allowedProjectCount`, `available`, `name`, `version`, `error` | `t3_ambientes` items |
| `busca`, `retornados`/`retornadas`, `truncado`, `proximoCursor` | `search`, `returned`, `truncated`, `nextCursor` | lists and search |
| `projetos`, `titulo`, `diretorio`, `threadsRodando`, `threadsPrecisandoIntervencao` | `projects`, `title`, `directory`, `runningThreads`, `threadsNeedingIntervention` | `t3_projetos` |
| `alteradasDesdeInicio`, `ocultasSemExecucao` | `changedSinceStart`, `hiddenNoRun` | `t3_threads` |
| `correspondencia`, `completa`, `ambientesConsultados` (`encontradas`), `falhasAmbientes` (`codigo`, `motivo`), `arquivada` | `match`, `complete`, `queriedEnvironments` (`found`), `environmentFailures` (`code`, `reason`), `archived` | `t3_buscar_threads` |
| `titulo`, `projeto`, `diretorio`, `modelo` (`modelo`, `instancia`, `esforco`), `modoExecucao`, `atualizadaEm`, `encerradaNaLista` | `title`, `project`, `directory`, `model` (`model`, `instanceId`, `effort`), `runtimeMode`, `updatedAt`, `settled` | thread summary |
| `estado`, `motivo`, `tipo`, `identificador`, `desde`, `liberaEm`, `retomaEm`, `observacao`, `tarefasEmSegundoPlano` (`descricao`), `erro`, `classeErro` | `state`, `reason`, `kind`, `identifier`, `since`, `resetAt`, `resumeAt`, `note`, `backgroundTasks` (`description`), `error`, `errorClass` | thread state |
| `pedidosPendentes`, `sessaoProvider` (`diretorio`, `modelo`), `ultimoRun`, `ultimaResposta`, `historico` (`completo`, `orcamentoExcedido`) | `pendingRequests`, `providerSession` (`directory`, `model`), `latestRun`, `latestResponse`, `history` (`complete`, `payloadBudgetExceeded`) | `t3_thread` |
| `texto`, `truncada`, `emAndamento`, `atualizadaEm`, `criadaEm`, `papel`, `mensagens` | `text`, `truncated`, `streaming`, `updatedAt`, `createdAt`, `role`, `messages` | latest response, `t3_mensagens` |
| `titulo`, `estado`, `motivoRetorno`, `pedidoPendente` (`tipo`, `motivo`, `desde`), `observadoEm`, `ultimaResposta` | `title`, `state`, `returnReason`, `pendingRequest` (`kind`, `reason`, `since`), `observedAt`, `latestResponse` | `t3_aguardar_thread` |
| `tipo`, `motivo`, `desde`, `detalhe`, `conteudo` (`tipo`), `conteudoDisponivel`, `indisponibilidade`, `threadSendRespondePedido`, `proximaAcao` (`tipo`, `motivo`, `campoResposta`, `requerDecisaoDoUsuario`) | `kind`, `reason`, `since`, `detail`, `content` (`type`), `contentAvailable`, `unavailableReason`, `threadSendAnswersRequest`, `nextAction` (`type`, `reason`, `responseField`, `requiresUserDecision`) | `pendingRequests[]` |
| `ambientes` (`projetos`, `acoes`), `indisponiveis` (`motivo`) | `environments` (`projectCount`, `actionCount`), `unavailableEnvironments` (`reason`) | `t3_pedir_aprovacao` |

`runtimeRequestId`, `requestId`, `statusRun`, `runId`, `responseCapability`, question and
option fields, and every field that was already English are unchanged.

| Previous value | English value | Field |
|---|---|---|
| `rodando`, `precisa_intervencao`, `concluida`, `falhou`, `cancelada`, `sem_execucao`, `desconhecido` | `running`, `needs_intervention`, `completed`, `failed`, `cancelled`, `no_run`, `unknown` | `state` |
| `parcial`, `exata` | `partial`, `exact` | `match` |
| `precisa_intervencao`, `sem_execucao`, `prazo`, `thread_apagada`, `subscription_encerrada` | `needs_intervention`, `no_run`, `timeout`, `thread_deleted`, `subscription_closed` | `returnReason` (`terminal` unchanged) |
| `consultar_no_t3`, `responder_runtime_request` | `inspect_in_t3`, `respond_runtime_request` | `nextAction.type` |
| `prazo`, `prazo_global`, `indisponivel`, `environment_divergente`, `conexao_recusada`, `falha` | `timeout`, `global_timeout`, `unavailable`, `environment_mismatch`, `connection_refused`, `failed` | `environmentFailures[].code` (`http_<status>` unchanged) |
| `ambiente_obrigatorio`, `ambiente_desconhecido`, `ambiente_fora_da_lease`, `ambiente_indisponivel`, `gate_indisponivel`, `sem_projetos` | `environment_required`, `environment_unknown`, `environment_not_in_lease`, `environment_unavailable`, `gate_unavailable`, `no_projects` | write error codes, `unavailableEnvironments[].reason` |

Request kinds (`command`, `user_input`, …), run statuses, `responseCapability.type` and
the remaining write error codes were already English. Error and reason messages written
by the connector are English; text that comes from T3 or the user is passed through.

### New error codes

`parameter_conflict`, `parameter_invalid` (invalid value in a deprecated alias) and
`parameter_required`. A write call with neither `environment` nor `ambiente` fails with
`environment_required`, before anything reaches the relay.

## Consequences

- Existing calls and configuration files keep working without change. A client that
  re-reads `tools/list` sees only the English names.
- Clients that read response fields or match error codes by name must move to the English
  names; the release that ships this is a breaking one. Clients driven by a model read the
  updated tool descriptions, which name the new fields.
- An unknown key is still ignored, as before; only the known aliases are inspected.
- Cursors issued before the change stay valid: their signature keeps the internal labels
  (`parcial`, `exata`, the previous state values), not parameter names.
- The private relay is unchanged, so a bridge and a gate on different versions still
  work; leased reads answer with the previous names until the gate restarts.
- Operator CLI JSON (`environments`, `diagnose`, write `pair`) uses English keys.
  Configuration validation messages and other CLI prose remain Portuguese.
- The aliases are part of the public contract until a release that announces their
  removal. Removing them is a breaking change.

## Open questions

- **Tool names.** English names (`t3_projects`, `t3_search_threads`, `t3_write_<action>`,
  …) would need either a second registration per tool, doubling the write catalog to 91
  entries in `tools/list`, or a hidden name resolver in front of the SDK's tool dispatch.
  Both have costs for clients that choose tools from the list. Not decided here.
