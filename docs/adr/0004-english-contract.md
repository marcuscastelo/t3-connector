# ADR 0004: English public contract

Date: 2026-10-04. Status: accepted (Marcus, 2026-10-04: full English contract, breaking
change accepted, no backward compatibility required).

## Context

The repository and its documentation are in English, but the MCP contract kept the names
of the private prototype: `ambiente`, `busca`, `limite`, `estado`, `projetosPermitidos`,
and so on. 0.5.0 translated descriptions only and declared the names stable.

Constraints found in the code (SDK 1.32.0, Zod 4):

- With a raw shape, the SDK builds a stripping object and **silently drops** unknown
  top-level keys before the handler runs. A call with an old name such as
  `{ambiente: "remoto"}` would lose it and run against the default environment.
- Write action inputs (`input`) are strict and already English. The dispatch hash covers
  the action ID and the parsed `input`, not the envelope (`leaseId`, environment,
  `operationId`), so renaming the envelope does not change operation hashes or journal
  keys. The channel identity prefix `canal:` is part of the persisted journal key and is
  internal; it stays.
- The public package has no running installation yet: the active Ponte runs the private
  `t3-ponte` 0.4.1 package. Its owner states that the only current client is their own
  ChatGPT chat, which re-reads the tool list.

## Decision

1. **Parameters, responses, codes and configuration keys are English.** No Portuguese
   alias is accepted and no Portuguese duplicate is returned.
2. **Old names fail explicitly.** Every tool input schema is strict
   (`z.strictObject`): an unknown key, including an old name, is refused with the SDK
   validation error (`-32602 … Unrecognized key`) before T3 or the relay is called, instead
   of being dropped. Old enum values (`state: "rodando"`) fail the same way.
3. **Old configuration keys fail explicitly** at start-up, naming the replacement
   (`"padrao" foi renomeado para "default"`). Ignoring them would silently change the
   default environment or the SSH port. The write config keeps refusing allowlist keys in
   any spelling (`projetos`, `acoes`, `projetosPermitidos`, `projects`, `actions`,
   `allowedProjects`).
4. **The gate keeps its internal names; the bridge translates.** The private relay between
   bridge and gate still carries `ambiente` in its envelope and the gate's internal codes
   and summary fields; the bridge returns `environment`, the English approval summary and
   English error codes. Leased-read parameters travel in English, so bridge and gate must
   run the same version (they ship in one package and restart together).
5. **Cursors are rebuilt.** Cursor signatures use the English labels; a cursor issued by a
   previous version is refused as invalid and the query restarts without a cursor.
6. **Tool names do not change here.** `t3_projetos`, `t3_escrever_*` and the others are
   kept, and `nextAction.tool` keeps naming the existing tool (see Open questions).

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
`diagnose`); the Portuguese subcommands and flags remain accepted by the CLI, which is not
part of the MCP contract.

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

## Consequences

- Breaking for every client that uses an old parameter name, reads a response field or
  matches an error code by name. It fails explicitly; nothing is silently re-routed.
  Clients driven by a model re-read `tools/list` and the descriptions, which use the new
  names.
- Installing this version means converting the configuration files to the English keys
  (table above); the connector refuses to start until then.
- Bridge and gate are upgraded and restarted together.
- Operator CLI JSON (`environments`, `diagnose`, write `pair`) uses English keys.
  Configuration validation messages and other CLI prose remain Portuguese.

## Open questions

- **Tool names.** Without compatibility, English names (`t3_projects`,
  `t3_search_threads`, `t3_write_<action>`, …) would be a plain rename: 8 read tools,
  the approval, reconcile and 5 leased reads, the 42 generated write names, the
  `nextAction.tool` value, the guarded-read list, the package check, docs and tests. It
  also renames the tools that the Ponte's tunnel profiles and the OAuth profile expose.
  Not decided here; this change keeps the names.
