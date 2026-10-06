# Investigação: thread/execution snapshot coerente

## Resumo (10 linhas)

1. `t3_thread` combina shell HTTP e `/bounded` em duas leituras e não valida suas sequências.
2. `state` já resolve run ativo versus último run, mas não representa todo o trabalho do provider.
3. `latestResponse` já contém `runId` e `updatedAt`; falta declarar sua relação com os runs atuais.
4. Background work é observável no backend V2 de referência: roster de provider thread e turn items ativos.
5. A shell publica um roster derivado para a UI, com gates que podem produzir vazio durante atividade foreground.
6. Claude limpa tasks por `task_notification`/roster replacement; Codex projeta comandos e subagents.
7. A recusa Claude encontrada protege troca de processo/modelo/política, não proíbe qualquer send com background.
8. O wait atual termina no run terminal e ignora atualização de roster, provider turn, subagent e turn item.
9. BFS precisa compartilhar a mesma aquisição e derivação; hoje `settlement` pode ser de outro instante que a resposta principal.
10. Recomenda-se snapshot versionado com cobertura, coerência, identidade da resposta e blockers; ausência de sinal não prova ausência de processo.

## Proveniência e limites da investigação

- **C** = connector `34cc095bf9ed2b5452b87729da51e6d878404af3`, checkout solicitado, release 0.11.2. Todas as citações `C arquivo:linha` são desse commit, salvo indicação contrária.
- **F** = BFS `d862666940080f3a693a52eec65b554bc7aee01f` (`feat/bfs-agent-stories-80-20`). **B** = batch `9c039dcda3e0bf9c5c387513266e2e7ec98643e3` (`feat/batch-thread-ops`). Lidos por `git show`, sem checkout.
- **D** = design batch `754a1c9d57fddf49d3f117ef0ffb70f2aee132d9`, `investigate/batch-tool-opportunities`.
- **T** = backend T3 `8ed276c246b624631e7d39241ebfd22d8314cb68`. Fonte: repositório upstream `pingdotgg/t3code`, lido por `git show 8ed276c2:<arquivo>` num clone local, numeração com `nl -ba`. Não é necessário extrair arquivos nem trocar o checkout. `reference/README.md:3,10` em C confirma a mesma origem do contrato incorporado.
- O checkout de trabalho local desse clone do T3 está num commit e numa branch de fork que não contêm a árvore V2, e a base local do nightly também não; nada foi alterado. Esses checkouts não são evidência de qual backend serve o incidente.
- A ref **local** `main` do connector ainda resolve para `1432b6c`, anterior a C. Executei os diffs `main...<branch>` solicitados, mas eles incluem alterações anteriores à 0.11.2; usei também `34cc095...<branch>` para isolar BFS/batch. Nenhuma ref foi atualizada. `t3code/active-run-state-precedence` resolve para `47db656`, presente na ancestralidade de C; `fix/thread-effective-state-contract` local resolve para `8fb3946`, não é a implementação final da correção.
- `investigate/settle-safety` aponta para C. Seu documento existe no filesystem da worktree irmã em `investigacao/settle-prematuro.md`, mas **não existe no commit** (`git show` recusa esse caminho). Cite-o como documento local não versionado, nunca como fonte Git. Linhas 7–16 distinguem preflight, aceite e ausência de CAS.
- **Fato verificado** significa comportamento/contrato demonstrado no código citado. **Proposta** significa desenho recomendado aqui. **Hipótese** significa explicação do incidente ainda sem logs, eventos ou reprodução. Nenhuma sessão privada/transcript de usuário foi lida, nenhum serviço foi consultado ou alterado, e testes não foram executados nesta investigação de leitura.

## 1. Onde as respostas são montadas, campos e fontes

### `t3_thread`

Registro e handler: **C `src/servidor.mjs:307,323`**. Sequência: `cliente.shell()` → autorização/projeto da thread → `cliente.thread(id)` (`/bounded`) → combinação dos campos (**C `src/servidor.mjs:324,327,330,342`**). O cliente HTTP diferencia shell, full e bounded em **C `src/t3.mjs:86,88,89`**. Não há leitura full nesse handler atual, evento ao vivo nem journal.

| Campo público atual | Fonte e regra | Evidência em C |
|---|---|---|
| `environment` | Registro/identidade do environment da chamada | `src/servidor.mjs:95,100` |
| `threadId`, `title`, `project`, `directory`, `branch`, `model`, `runtimeMode`, `updatedAt`, `settled` | Thread/projeto da **shell**; directory = worktree ou root do projeto; model configurado para próximo run | `src/servidor.mjs:41` |
| `state`, `stateSource`, `runId`, `statusRun`; eventualmente `latestRunId`, `latestRunStatus`, `note` | Shell + pendentes do bounded; pedido > ativo > limite/plano > último run | `src/estado.mjs:79,85,92,99,112,124,135` |
| `activeRun` | ID/status ativo da shell; ordinal/model e, quando presente, status do run do bounded | `src/servidor.mjs:331,334` |
| `latestRun` | ID e status da shell; ordinal do bounded ou null | `src/servidor.mjs:333,348` |
| `pendingRequests` | `runtimeRequests.pending` + turnItems do bounded, com fallback para ID da shell ausente da projeção | `src/pedidos-runtime.mjs:28,73` |
| `providerSession` | Sessão da instância da thread mais recentemente atualizada no bounded; publica status/directory/model/informational/note | `src/servidor.mjs:60` |
| `latestResponse` | Última mensagem assistant não vazia **da janela**; `messageId`, `runId`, text, truncated, streaming, updatedAt | `src/estado.mjs:178` |
| `history` | `!bounded.hasMoreHistory`, `payloadBudgetExceeded` | `src/servidor.mjs:350` |
| `backgroundTasks` | Apenas se `state` cair no caso latest status completed, e só se a shell tiver roster não vazio; kind/taskId/description | `src/estado.mjs:135` |
| `error`, `errorClass` | Apenas caso latest failed; shell.lastError/lastErrorClass | `src/estado.mjs:144` |

**Não saem como campos próprios:** `activeRunId` bruto, `activityRunStatus`, activeProviderThreadId, providerThreads/providerTurns, subagents, activity/turnItems, fila completa, sequence, projection.updatedAt, sessão.id/updatedAt/lastError. `activeRun.runId` expõe o identificador ativo quando a shell o informa. `latestResponse.createdAt` existe no backend mas não é projetado aqui. `t3_mensagens` publica createdAt, sem runId (**C `src/servidor.mjs:373`**). A fila tem ferramentas separadas em **C `src/escrita/native.mjs:191,200`**, usando full projection e ordenação por queuePosition/ordinal (**C `src/escrita/native.mjs:43`**).

**Incoerências possíveis, verificadas pelo fluxo:** shell antiga diz running, bounded já diz completed: `state/statusRun` seguem shell, enquanto `activeRun.status` pode ser completed; shell completed antiga + bounded com novo run não altera a seleção do latestRun. `state` pode continuar needs_intervention por pedido antigo da shell mesmo se o bounded já o resolveu; `pendingRequests` não duplica esse ID se a projeção contém o pedido resolvido (**C `src/estado.mjs:92`**, **C `src/pedidos-runtime.mjs:76`**). Não há teste de sequência/freshness antes de devolver esse conjunto.

### `t3_aguardar_thread`

Registro/schema: **C `src/servidor.mjs:390,398`**. Implementação: **C `src/espera.mjs:41,53`**. Usa shell inicial para ACL/seleção e, quando precisa esperar/obter resposta, ticket WS + `orchestration.subscribeThread`, snapshot + eventos. A saída é montada em **C `src/espera.mjs:59`**: environment, projectId, threadId, title, runId, statusRun, state, terminal, timedOut, returnReason, pendingRequest, observedAt, elapsedMs, timeoutMs e latestResponse opcional. Diferentemente de `t3_thread`, filtra resposta pelo run seguido (**C `src/espera.mjs:78`**).

A shell e o snapshot de subscription são observações distintas. Metadados continuam da shell; o run seguido é escolhido a partir dela e mantido, salvo fallback de seleção ao receber snapshot (**C `src/espera.mjs:105,138`**). `observedAt` é relógio do connector, atualizado em cada lote; não é timestamp do último progresso real nem watermark do backend (**C `src/espera.mjs:83,155`**).

### `thread.send` e o nome público correto

**No connector C a tool é `t3_escrever_thread_send`, não `t3_thread_send`.** O nome nativo não é alias do wrapper. Lease: **C `src/escrita/ponte-mcp.mjs:57`**; OAuth: gerador `writeToolName` e registro em **C `src/oauth/session-writes.mjs:87,301`**; teste de catálogo em **C `test/escrita-send.test.mjs:17`**.

`thread.send` exige delivery explícito e codifica `message.dispatch`, commandId/messageId, text, attachments=[], dispatchMode (**C `src/escrita/adapters.mjs:45,53,60`**). Dispatcher reserva journal, resolve projeto via shell, prepara WS, envia uma vez e grava ACK (**C `src/escrita/adapters.mjs:124,141,153,165`**). `adapter.projectForThread` é leitura shell, não snapshot de execução (**C `src/escrita/conexao.mjs:149`**). OAuth all também revalida projeto/escopo em shell fresca (**C `src/oauth/session-writes.mjs:156,164,170,179`**).

**Saída normal:** `{state:'completed', operationId, receipt:{sequence}}` do **dispatch do connector**, não run completed. Fonte: recibo WS `orchestration.dispatchCommand`; projeção receipt em **C `src/escrita/conexao.mjs:143`**, validação em **C `src/escrita/transport-staging.mjs:12`**, saída em **C `src/escrita/adapters.mjs:167,169`**. Não inclui runId nem mensagem assistant. Dedupe/reconcile leem o journal de operações; isso não observa o provider (**C `src/escrita/adapters.mjs:137`**, **C `src/escrita/conexao.mjs:157`**, **C `src/escrita/journal.mjs:12,15`**). Transporte incerto fecha o gate e exige reconciliação; não refaz send (**C `src/escrita/adapters.mjs:174`**).

### Sequence/version/updatedAt: existem, mas são diferentes

1. Shell HTTP é uma transação com threads/projetos e **última application sequence global** (**T `apps/server/src/orchestration-v2/http.ts:95`**).
2. Full e janela são transações com projection e **MAX(sequence) dos eventos dessa thread** (**T `apps/server/src/orchestration-v2/ProjectionStore.ts:4492,4697`**). HTTP publica `snapshotSequence` em ambos (**T `apps/server/src/orchestration-v2/http.ts:185,199`**).
3. Projection.updatedAt, message.createdAt/updatedAt, session.createdAt/updatedAt, providerThread.updatedAt e run requestedAt/startedAt/completedAt estão no contrato (**C/T `reference/packages_contracts_src_orchestrationV2.ts:510,676,791,1010,1639`**). Não há revision CAS por thread nesse envelope.
4. SubscribeThread tem afterSequence e marcadores; overlapping events devem ser deduplicados por sequence (**C/T `reference/packages_contracts_src_orchestrationV2.ts:2984`**). O wait atual não guarda snapshotSequence/sequence nem usa synchronized (**C `src/espera.mjs:133`**); `ws.assinar` só entrega os lotes (**C `src/ws.mjs:92,101`**).

**Invariante recomendada:** não comparar igualdade simples entre shellSequence e threadSequence: uma mudança em outra thread aumenta a primeira. Não chamar sequência de ACK do journal de “versão da execução”. Timestamps são evidência temporal de entidade, não atomicidade. Para leituras compostas conservadoras, shell-before == shell-after global (ambas realmente frescas) pode validar uma janela sem mudanças de aplicação; desigualdade pede retry limitado ou coerência inconclusiva, não prova contradição desta thread. Uma assinatura de campos desta thread é alternativa mais barata, mas com garantia menor e risco ABA.

## 2. O que o backend V2 realmente expõe

### (a) Mensagens e runs

**Fato:** ConversationMessage tem `runId:null|RunId`, nodeId, role, text, streaming, createdAt, updatedAt e notification opcional (**C/T `reference/packages_contracts_src_orchestrationV2.ts:1010`**). latestResponse já preserva runId/updatedAt, mas escolhe pelo último elemento assistant com text, sem comparar com latestRun ou activeRun (**C `src/estado.mjs:178`**). Mensagem antiga anunciando um observador não é lifecycle da task. `runId` null deve produzir relação unknown, não stale=false.

Run tem ordinal, providerThreadId, activeAttemptId, requestedAt/startedAt/completedAt e status; **não tem campo `error`** (**C/T `reference/packages_contracts_src_orchestrationV2.ts:510`**). Attempt e ProviderTurn permitem join run → attempt → providerTurn e timestamps/status próprios (**C/T `reference/packages_contracts_src_orchestrationV2.ts:548,900`**).

### (b) ProviderSession

Status V2: **starting, ready, running, waiting, stopped, error**, com id/driver/providerInstanceId/cwd/model/capabilities/createdAt/updatedAt/lastError. **Não há activeTurnId na ProviderSession V2** (**C/T `reference/packages_contracts_src_orchestrationV2.ts:676`**). O repo T3 atual também contém contratos legados com activeTurnId; misturá-los com V2 seria incorreto. Para V2, atividade de turn é `providerTurns` ligada por attempts/nodes; providerThread tem status not_loaded/idle/active/archived/closed/error (**C/T `reference/packages_contracts_src_orchestrationV2.ts:791,900`**).

O wrapper já declara que sessão.ready e modelo antigo podem coexistir com run ativo; status/model dessa sessão são informativos (**C `src/servidor.mjs:314`**, caso de regressão em **C `test/estado-contrato.test.mjs:81`**). Incluir session.updatedAt/lastError ajudaria diagnóstico, mas não a tornaria autoridade de estado ou liveness de task.

### (c) Background tasks, terminais e subagents

**Há fonte estruturada, não apenas proxy.** `providerThreads[].pendingBackgroundTasks` contém taskId, kind (subagent/command/monitor/background_task), description opcional e childThreadId para subagent. É roster de pendentes, não histórico de tasks com status/endAt (**C/T `reference/packages_contracts_src_orchestrationV2.ts:747,812`**). Campo opcional decodificado como [] no backend pode apagar a distinção “antigo não informou” versus “informou vazio”.

**Claude:**

- Roster por native thread, emitido como provider_thread.updated com providerThread.pendingBackgroundTasks e updatedAt (**T `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:3382`**).
- `background_tasks_changed` substitui o roster; fallback `task_started` adiciona somente trabalho não-subagent/background; `task_notification` remove taskId e termina tracking de Monitor (**T `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:5240,5248,5273`**).
- Mudança em idle emite provider thread idle sem ressuscitar atividade (**T `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:5302`**). A normalização produz evento de domínio `provider-thread.updated` associado à app thread (**T `apps/server/src/orchestration-v2/ProviderEventIngestor.ts:359`**).
- Subagents também têm entidade/subagent turn item com status e completedAt; não precisam entrar no roster opaco para serem visíveis (**C/T `reference/packages_contracts_src_orchestrationV2.ts:614`**, **T `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:5250`**).
- Probes `hasPendingBackgroundWork`/`hasPendingBackgroundWorkForThread` existem **internamente no runtime adapter**, não são endpoints HTTP do connector. O probe session-wide também olha buffers de wake, além de tasks/subagents (**T `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:7339,7366`**).

**Codex:**

- Comando em andamento é acompanhado por item commandExecution, inclusive processId, e emite node/turn_item.updated (**T `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:4093`**).
- Conclusão tardia em turn já encerrado projeta item e pode oferecer continuação/notificação de background command (**T `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:4214,4219,4240`**).
- O app-server Codex tem RPC `thread/backgroundTerminals/list`/terminate, utilizado pelo adapter para verificar término após stop; **não é rota pública de leitura do environment** (**T `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:2044,2063`**).
- Probes internos olham comandos, dynamic tools e subagent tasks em running; há lacuna documentada: subagent completed que Codex retoma depois não emite sinal resume-expected entre turns (**T `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:5355,5359,5377`**). Não prometer que [] exclui toda execução futura.

**Shell agregada:** `derivePendingBackgroundWork` combina roster de provider thread + command_execution/dynamic_tool/subagent turn items ativos, deduplica native task ID, filtra activeProviderThreadId, exclui rolled_back e dynamic tool persistent. **Retorna [] enquanto há run preparing/starting/running**, ou latestRun fora do gate de background; admite waiting/completed/failed/interrupted/cancelled (**T `packages/shared/src/orchestrationV2PendingBackgroundWork.ts:10,37,178,197,224,239`**). Portanto **[] na shell durante foreground não significa zero background**. O helper é de UI pós-turn, não probe absoluto do runtime.

ProjectionStore aplica esse helper ao montar shell (**T `apps/server/src/orchestration-v2/ProjectionStore.ts:1292,1330,1392`**). O connector expõe seu resultado somente no ramo completed, ocultando tasks em failed/cancelled/waiting (**C `src/estado.mjs:135`**). Esse é um alvo concreto para a implementação.

**Activity/timeline:** V2 fornece `turnItems`, `visibleTurnItems`, providerTurns, nodes, subagents e messages.notification; não há array genérico `activity` no ThreadProjection (**C/T `reference/packages_contracts_src_orchestrationV2.ts:1621`**). Notificação tem source/outcome/summary/detail; registra evento observado, não confirma entrega ao agente (**C/T `reference/packages_contracts_src_orchestrationV2.ts:999`**). Source de monitor/background_task não traz taskId estruturado universal (**C/T `reference/packages_contracts_src_orchestrationV2.ts:962`**); não fazer join pelo texto de summary.

**Quando terminou:** turn item/subagent pode fornecer completedAt; roster Claude só informa pendentes e updatedAt da entidade. Se uma task sai do roster, pode-se afirmar “não está pendente nesta projeção”; com evento de saída após observação positiva, guardar `clearedObservedAt/sequence`. Não inventar task.completedAt a partir do providerThread.updatedAt. Vazio após restart/Stop pode representar cancelamento/perda, não conclusão bem-sucedida; contrato tem restartCancelledBackgroundWork (**C/T `reference/packages_contracts_src_orchestrationV2.ts:492`**).

**Cobertura bounded:** contrato anuncia control-plane + janela de timeline (**C/T `reference/packages_contracts_src_orchestrationV2.ts:3020`**). O builder mantém controlProjection, reduz messages/turnItems/visibleTurnItems e filtra artifacts históricos (**T `apps/server/src/orchestration-v2/threadHistoryPaging.ts:418,516`**). Não assumir histórico completo por causa desse comentário: faltam items antigos e o teste atual simula latest run ausente (**C `test/estado-contrato.test.mjs:28,63`**). Full é o caminho conservador para queue/turn items antigos/guarda; bounded é válido com cobertura por domínio, não com um booleano global “tudo completo”.

## 3. Falha ao iniciar turn enquanto há background

**Fato verificado específico Claude:** `ClaudeBackgroundWorkBlocksQueryReplacementError`, `_tag` de mesmo nome, message definido em **T `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:343`**. Texto exato: `Claude is still running background agents or commands, and this model or setting change would end them. Wait for them to finish, or press Stop, then send the message again.`

Condição: openQuery reutiliza processo da mesma native thread quando queryPolicyKey e selectionKey coincidem, ou quando é provider continuation; **nesses casos não cai na recusa** (**T `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:6819`**). Se precisaria substituir processo, ele existe, não está stopping e `liveProcessRunsBackgroundWork` é true, recusa (**T `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:6771,6831`**). O probe exclui subagent cujo task_notification já está buffered. Isso sustenta a hipótese “run2 falhou porque exigiu troca de modelo/política”; **não prova a causa do incidente relatado**, cujo erro/run não foi fornecido aqui.

Propagação verificável:

1. ProviderFailure percorre causas e preserva esse message conhecido (**T `apps/server/src/orchestration-v2/ProviderFailure.ts:25,39`**).
2. Falha de startTurn é capturada e gera failed terminal com `class:'provider_error'` (**T `apps/server/src/orchestration-v2/RunExecutionService.ts:1375,1405`**).
3. Persistência em `turn-item.updated` tipo error, status failed, failure; depois `run.updated` failed (**T `apps/server/src/orchestration-v2/RunExecutionService.ts:721,748`**, **T `apps/server/src/orchestration-v2/ProviderFailure.ts:164,191`**).
4. `failure.code` tende a **null**, pois esse tagged error não define code e makeProviderFailure só consulta code explícito/na causa direta (**T `apps/server/src/orchestration-v2/ProviderFailure.ts:137`**). Não confundir `_tag` interno com código público persistido.
5. Shell.lastError/lastErrorClass são derivados do erro do root do latest failed run, com preferência para session.lastError (**T `packages/shared/src/orchestrationV2ThreadError.ts:8,35`**, **T `apps/server/src/orchestration-v2/ProjectionStore.ts:1373`**). C publica os dois quando state failed; latestRun não traz failure (**C `src/estado.mjs:144`**, **C `src/servidor.mjs:348`**).

Essa falha pode ser **posterior ao ACK do dispatch**: o `{state:'completed',receipt.sequence}` do wrapper não certifica início bem-sucedido do provider. Se o RPC em si falha, o wrapper base usa transporte sem nativeErrors e pode devolver reconciliation_required, que é outra categoria (**C `src/escrita/transport-staging.mjs:31,33`**, **C `src/escrita/adapters.mjs:166,174`**). Não há evidência aqui de uma exceção HTTP universal “background pending”, nem de erro Codex equivalente. Teste upstream protege mudança de modelo com subagent running e mantém um único processo (**T `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts:7233,7252`**).

## 4. Wait atual e extensão possível

Terminal = completed/failed/cancelled/interrupted/rolled_back (**C `src/espera.mjs:13`**). A seleção sem runId segue run ativo no começo, senão latest; não acompanha automaticamente runs futuros (**C `src/espera.mjs:105`**). Shell terminal ou pedido retorna imediatamente sem WS quando não se pede resposta (**C `src/espera.mjs:113,117`**).

No stream ele mantém apenas run seguido, pedidos e mensagens; ignora provider-thread.updated, provider-session.updated, provider-turn.updated, turn-item.updated, subagent.updated, thread.updated e sequence/synchronized (**C `src/espera.mjs:133`**). Logo não sabe quando um monitor já lançado termina. A avaliação prioriza terminal como returnReason antes de pendingRequest; estadoDoRun dá precedência ao pedido, podendo sair terminal=true/returnReason=terminal/state=needs_intervention (**C `src/espera.mjs:17,127`**). Uso-limit/plano também não compartilham a derivação de estadoDaThread.

**Proposta:** manter o modo run-terminal atual; acrescentar intenção explícita de aguardar quiescência da execução/thread. Reusar reducer+derivador do snapshot para processar roster/turnItems/subagents/queue/requests, inclusive wake run iniciado enquanto se espera. Nesse modo, ignorar fast path terminal da shell quando background é unknown/nonempty; aguardar synchronized/catch-up antes de declarar condição. Pending intervention continua retorno imediato explícito; não “esperar a pessoa” indefinidamente.

Manter deadline da chamada inteira e teto 5s, cancelamento só da subscription e nenhum send/interrupt de run (**C `src/espera.mjs:41,159,193`**). `terminal` deve continuar nomeando run; campo distinto `executionQuiescent`/returnReason da nova condição evita mudar seu significado. Longa espera deve usar o sistema de eventos externo, sem loop de LLM. ADR atual **C `docs/adr/0002-waiting.md:47`** está desatualizado na seleção default (“latest”); implementação 0.11.2 e CHANGELOG prevalecem (**C `CHANGELOG.md:12`**).

## 5. Fixture/fake backend e regressão proposta

### Infra existente

- **C `test/fixtures.mjs:8,40,55,66`**: factories thread/pedido/projecao/mensagem. Thread aceita override de pendingBackgroundTasks, IDs/status e clocks; mensagem aceita runId/createdAt/updatedAt. `projecao()` aceita runs/requests/messages/turnItems e session.ready default; providerThreads/providerTurns/subagents devem ser adicionados por spread/override (não há factory própria).
- **C `test/apoio.mjs:24,64`**: dadosPadrao por environment; shell pode ser função, bounded por thread; clientes falsos registram chamadas. InMemoryTransport conecta servidor MCP real + Client SDK (**C `test/apoio.mjs:95`**). Não é servidor T3 real nem runtime de provider.
- **F `test/apoio.mjs:81`**: adiciona threadCompleto com `d.completo[id]` objeto ou função; serve para mutações controladas entre leituras. **F `test/settlement.test.mjs`** e **F `test/escrita-settle-guard.test.mjs`** testam observação/recusas de guard.
- **C `test/espera.test.mjs:10,15,18`**: snapshot com sequence, evento com sequence, assinaturaFalsa emite lotes por timers e registra close. Permite evento de roster clear sem mensagem, failed run sem resposta, novo wake run e deadline. Teste existente já cobre filtrar resposta de outro run (**C `test/espera.test.mjs:122`**).
- **C `test/estado-contrato.test.mjs:15,52,81`**: exemplo MCP de latestRun ausente no bounded e sessão.ready/model antigo enquanto run ativo. Estender preservando ambos os casos.
- **C `test/escrita-fixtures.mjs:10,11`**, **C `test/escrita-send.test.mjs:38`**: Gate fake, memoryJournal e adapter injetado. Fake invoke pode confirmar sequence e só depois mudar run para failed; isso testa separar ACK de execução, sem provider real. `test/escrita-send-fixtures.mjs` modela delivery, não lifecycle do backend (**C `test/escrita-send-fixtures.mjs:1`**).

### Sequência de regressão (proposta, sem implementação)

| Etapa | Dados simulados | Aceite esperado |
|---|---|---|
| A | run1 running; monitor M registrado no provider thread/turn item; shell roster vazio pelo gate de foreground | execution foreground active; background não vira “acabou” por shell [] |
| B | run1 completed; assistant R1(runId=run1) anuncia observador; roster M pendente | runTerminal=true, background pending, executionQuiescent=false |
| C | ACK de send2; run2 failed por provider_error, error turn item do root; nenhuma mensagem assistant de run2; roster M ainda pendente | dispatch acknowledged separado; latestResponse R1 staleByRun; failure de run2 visível; não inferir thread travada |
| D | evento provider-thread.updated com roster []; ou item M completed; nenhum message.updated | background knownPending=0; R1 continua stale; estado do último run não muda por falta de texto novo |
| E | snapshot final com latest run3 completed sem resposta útil, activeRun=null, queue=[], requests=[], roster=[]; conservar R1 | response stale para latest run3; continuar na thread original é mecanicamente possível; não fabricar completedAt de M se só há roster |
| F | shell-before M pendente e shell-after [] com demais campos iguais; repetir com shell cacheada OAuth all | não retornar coherent=true usando comparação que ignora background; cache não conta como leitura fresca |
| G | oldest active command/subagent fora da janela; full contém, bounded omite timeline | cobertura incompleta explícita; zero de janela não libera settle/quiescência |

Variantes necessárias: runId da mensagem null; erro no run2 e sessão.ready; shell.failed ainda com background (atualmente oculto); runtime request resolvido entre shell/bounded; run ativo antigo + latest cancelado (regressão existente); completion tardia seguida de wake/queue; providerThread de outra thread não contamina; roster ausente não se transforma em known-empty; subscription replay/duplicate sequence; cancelamento/deadline fecha só subscription; journal uncertain permanece bloqueio de reenvio mesmo com thread quiescente.

Teste de leitura final pode afirmar elegibilidade mecânica para `start_immediately` na thread original, sem enviar nada. Teste de adapter deve afirmar ausência de criação/fork e dedupe do operationId. Nenhum teste do connector, sozinho, prova liveness real do processo ou que uma nova configuração será aceita pelo provider.

## 6. Composição com BFS, settleGuard e batch

### O que já existe em F

`SETTLEMENT_CONTRACT_VERSION=1`, guard versions [1], tentativas=3 (**F `src/settlement.mjs:22`**). `observarSettlement` é puro, usa estadoDaThread e bloqueia pedidos, active runs, queued work, limites/plano/background da shell (**F `src/settlement.mjs:83,98,104,112,117`**). `observationId` é digest dos campos que invalidam aceite; deliberadamente não usa sequence global/updatedAt de visita (**F `src/settlement.mjs:141`**).

`lerObservacao` faz shell → full → shell e compara marcaDaShell/lifecycle (**F `src/settlement.mjs:186`**). **Lacuna verificada:** marcaDaShell omite pendingBackgroundTasks, limitRecovery, activityRunStartedAt, message.updatedAt, session/turn item status e shell.updatedAt (**F `src/settlement.mjs:45`**). A saída usa background **da shell**, embora full tenha providerThreads/turnItems. Roster pode mudar com shell status/latestRun/lifecycle constantes e passar a checagem.

`t3_thread` F primeiro monta corpo shell+bounded e depois chama lerObservacao para `settlement` (**F `src/servidor.mjs:358,377,386`**). Portanto ler `settlement.complete=true` não certifica coerência com latestResponse/state publicados antes. OAuth all ainda fixa shell por invocação com Proxy (**C `src/oauth/project-policy.mjs:65,70`**); chamadas repetidas ao getter ali não fazem novo HTTP. LIFECYCLE tenta cobrir esse cache, mas não liga roster/state/mensagens a um instante único (**F `src/settlement.mjs:54`**).

O guard pede nova observação imediatamente antes de enviar e verifica run/observation esperados; não é CAS no backend (**F `src/escrita/adapters.mjs:171,217`**, **F `src/escrita/conexao.mjs:150`**, **F `src/settlement.mjs:220`**). Conservar aceite separado de elegibilidade; preservar `settleGuard` e suas versões. Não incluir staleResponse como blocker automático de settle: é sinal para avaliar entrega, não trabalho objetivamente pendente.

Workset F faz uma shell por environment, injeta resumo canônico, expõe snapshotSequence por environment e backgroundTaskCount quando não vazio (**F `src/workset.mjs:39,66,74,95,105`**). Seus grupos classificam state e settled; completed_unsettled não significa aceite nem quiescência (**F `src/workset.mjs:27`**). Mantê-lo leve: sem buscar full de toda thread para enriquecer lista, e declarar response/queue/background runtime como unavailable quando só houver shell.

### Batch B versus design D

B implementa apenas find e inbox update snooze/unsnooze; não implementa thread_read_batch nem uma nova definição de snapshot (**B `CHANGELOG.md:5`**, **B `src/escrita/lote-inbox.mjs:39`**). Find lê shell por environment e reusa resumir para candidatos (**B `src/busca-threads.mjs:85,187,210,217`**); deve receber o mesmo resumo compacto do snapshot. Inbox batch chama dispatch por item e registra manifesto/results; seus complete/allSucceeded são **resultado das operações**, não estado da thread (**B `src/oauth/session-writes.mjs:291`**, **B `src/escrita/lote-inbox.mjs:121,150`**).

D propõe thread_read_batch e precondições observadas, sem CAS (**D `docs/design/batch-api-v1.md:146,177,215`**). Não atribuir essa proposta à implementação B. Snapshot deve ser `data` de cada item de eventual read batch; batch envelope continua responsável por key/cobertura/budget/erros, sem recriar lifecycle. Não ligar journal.completed a executionQuiescent.

### Ponto único recomendado (proposta)

Novo módulo de domínio, por exemplo **`src/snapshot.mjs`**, com duas camadas:

1. `lerSnapshotThread({cliente,scope,threadId,coverage,signal})`: aquisição/autorização e validação de coerência; guarda fontes/sequences. Usa full quando settlement/queue/histórico de background exige, bounded para detalhe limitado, shell para lista. Oferece caminho de shell fresca que não passa pelo cache de inventário OAuth; revalida ACL/consentimento após read. No pedido com settlement, obter uma observação só e derivar também latestResponse/activeRun do mesmo conjunto, evitando bounded antigo + settlement novo.
2. `derivarSnapshotThread({shellThread,projection,sourceMetadata,coverage})`: função pura e total; normaliza seleção efetiva de run, pedidos, background/fila, resposta e sinais derivados. Não faz I/O, não lê journal, não envia continuação. Compartilhar helpers estadoDaThread/ultimaResposta e substituir duplicação estadoDoRun em espera; preservar seleção específica quando o wait foi chamado com runId.

`observarSettlement(snapshot)` passa a **projetar blockers/lifecycle/observationId** desse domínio comum; `avaliarGuard` continua política de guard/aceite. Workset/find usam versão compacta com mesma semântica, cobertura diferente. Wait alimenta o mesmo domínio por reducer de eventos. Adapter de escrita pode anexar receipt + snapshot posterior como fatos separados, sem prometer snapshot atômico com ACK.

Se derivar shell-equivalente exclusivamente do full, portar/testar as regras upstream (latest unheld, exceção usage-limit, active/waiting, planos, background), não simplesmente escolher máximo ordinal (**T `apps/server/src/orchestration-v2/ProjectionStore.ts:1292`**, **T `packages/shared/src/orchestrationV2ThreadError.ts:84,98`**). Alternativa mínima para preservar autoridade da shell: aquisição composta validada e recusa explícita de incoerência, com retry limitado. Não vender essa alternativa como um único snapshot transacional.

## 7. Convenções do repo e versões

- **Campos, parâmetros, enums, códigos e descrições em inglês; schemas estritos.** Migração breaking 0.6.0, sem aliases de parâmetros (**C `docs/adr/0004-english-contract.md:26`**, **C `CHANGELOG.md:143`**). Nomes de tools portugueses foram mantidos por decisão explícita (**C `docs/adr/0004-english-contract.md:47`**, **C `test/idioma.test.mjs:8`**). Novas tools BFS/batch têm nomes ingleses. Não existe migração de nomes English-only 0.12 implementada nas bases inspecionadas; F/B continuam seção Unreleased e package 0.11.2. Mudança 0.12 é hipótese/plano externo, não fato deste repo.
- Documentação de contrato: README tabela/tools e seções state/pending/send (**C `README.md:159,200,276,432`**), ADRs, docs/oauth-session.md. F acrescenta `docs/orchestration-bfs.md`; B `docs/batch-operations.md`; D usa `docs/design/`. A proposta de snapshot merece documento próprio + descrições MCP/README + CHANGELOG Unreleased. Arquivos internos/funções ainda têm nomes portugueses.
- Runner: node:test + node:assert/strict, `.test.mjs`, MCP in-memory e fake adapters. `npm test` = `node --test test/*.test.mjs packages/*/test/*.test.mjs`; `npm run test:package` = scripts/check-package.mjs (**C `package.json:27`**). Na implementação, executar targeted tests de snapshot/estado/wait/guard e a suíte exigida pelo fluxo. Esta investigação não cria testes nem executa smoke real.
- Versão de pacote/MCP deve concordar (**C `test/versao.test.mjs:7`**, **C `src/servidor.mjs:23`**). `ContractVersion` não deve ser confundido com versão npm, protocol 2 ou sequence.
- Exemplo disponível de contrato versionado é F `settlementContractVersion: z.literal(1).optional()` e `settleGuard.version`, com rejeição de versão não suportada (**F `src/servidor.mjs:353`**, **F `src/settlement.mjs:22,220`**). Observação opt-in não muda clientes que omitem o parâmetro. Um `snapshotContractVersion:1` pode seguir esse padrão, mantendo settlementContractVersion/guard v1 independentes. Não aceitar qualquer inteiro e devolver formato diferente silenciosamente.
- Packaging atual inclui docs/adr, não todo docs; F/B alteram o package-check ao introduzir ferramentas (**C `package.json:14`**, **F/B `scripts/check-package.mjs`**). Conferir o que deve ir no tarball ao adicionar documentação, sem copiar fontes backend nem importar seu código de reference no runtime (**C `reference/README.md:3`**).

## Proposta de contrato mínimo v1

Desenho recomendado, ainda não implementado. Pode ser bloco `execution`/`snapshot` em `t3_thread` para preservar o contrato atual; o nome final cabe à dona da implementação. Campos abaixo são semântica, não schema aprovado.

| Grupo/campos | Fonte | Certeza e invariantes |
|---|---|---|
| `contractVersion:1`, identity environmentId/threadId/projectId | Connector + autorização/projection.thread | **Observável**; nunca misturar environments, provider siblings ou outra thread |
| `observedAt`, `sources:{shellSequence,threadSequence,projectionUpdatedAt,mode}`, `coherence:{status,reasons}` | Watermarks/relógio/aquisição | **Observável** origem e ordem; coherent/inconclusive é **derivado** pela validação; não prometer CAS |
| `coverage:{runs,requests,queue,background,timeline,response}` | full/bounded/shell, campos presentes e flags | **Derivado**; domínio incomplete/unavailable não se transforma em []/false conhecido |
| `state`, `stateSource`, `effectiveRun`, `latestRun`, `activeRun` | Seleção canônica validada, run rows e shell | **Derivado de fatos**; state/runId/statusRun sempre descrevem mesmo run; latest != effective é informação explícita |
| Run `id,ordinal,status,requestedAt,startedAt,completedAt`; `failure` separado com source item/runId | runs/attempts/error turnItems | **Observável**; ausência de mensagem não apaga falha; manter identificação do erro histórico |
| `pendingRequests` e `queue:{known,items,count,heldCount}` | runtimeRequests/runs full ou domínio com cobertura demonstrada | **Observável** para coleção lida; pedido vencido não reaparece por merge de shell antiga |
| `providerSession:{id,status,model,updatedAt,lastError,informational:true}` e activeProviderThreadId | providerSessions/thread | **Observável** status reportado; não decide liveness/model efetivo |
| `background:{knowledge,items,knownPendingCount,source,asOfSequence}` | provider-thread roster + items/subagent lifecycle; shell apenas como fonte derivada de UI | **Observável no modelo do backend**, não inspeção de OS; unknown quando gates/cobertura/versão impedem concluir |
| Background item `taskId,kind,description,providerThreadId,sourceItemId?,runId?,childThreadId?,status?,completedAt?` | Campos existentes nos domínios correspondentes | Não fabricar runId/status/completedAt para roster opaco; IDs deduplicados por destino provider + native identity |
| `latestResponse:{messageId,runId,createdAt,updatedAt,streaming,text,truncated}` | messages da mesma observação | **Observável**; indicar “última da janela” quando histórico limitado |
| `responseRelation:{toLatestRun,toEffectiveRun,staleByRun,reason}`; opcional response do effectiveRun | Comparação de IDs | **Derivado certo para identidade conhecida**; older_run/null/missing_from_window/streaming distintos; “útil” não é fato determinístico |
| `signals:{runTerminal,foregroundActive,knownBackgroundPending,executionQuiescent}` | Snapshot normalizado | **Derivado**; executionQuiescent=null se cobertura incoerente/unknown; runTerminal nunca equivale a quiescência/aceite |
| `continuation:{mechanicalEligibility,blockers,warnings}` | Ativo/pedidos/fila/background/limite/plano/coerência | **Inferência mecânica**, não autorização nem garantia de sucesso do próximo turn; indicar historical provider failure como warning quando deixou de bloquear |

### Invariantes para o cenário real

1. Uma mensagem que diz “observador ativo” nunca alimenta knownBackgroundPending; seu texto é conteúdo histórico.
2. run2/3 terminal sem resposta mantém R1, mas declara que R1 é de outro run. Nunca promover streaming/status de R1 a lifecycle atual.
3. failed run2 com roster M pendente mostra ambos, sem colapsar em “travada”. Depois do clear de M, o erro de run2 permanece histórico enquanto background indica ausência de pendentes **conhecidos** na observação atual.
4. Background é publicado em todos os estados, não só completed. Uma lista vazia por gate de foreground ou campo ausente é desconhecimento, não conclusão.
5. Queue/requests/wake foreground presentes impedem quiescência; staleResponse sozinho não impede continuação. No final, com cobertura válida e nenhum blocker, a indicação é continuar na thread original, sem criar/forkar/fazer send automaticamente.
6. Registro da saída de uma task e sua hora de término são coisas distintas; evento de clear autoriza `clearedObservedAt`, não `completedAt` inventado.
7. Coerência e cobertura são por domínio. history.complete=false não invalida roster presente inteiro, mas invalida conclusões baseadas em ausência de item antigo.
8. `settlement.eligibleMechanically` reusa blockers objetivos; acceptance permanece declaração de quem aceita o escopo. Snapshot não resolve aceite por NLP.
9. Um ACK de dispatch e um journal uncertain são mantidos fora do estado da thread. Nem quiescência nem resposta fresca autorizam repetir uma operação incerta.
10. Convergência de fontes é verificada; repetir getters cacheados não cumpre essa verificação. Retry só de leitura, limitado, sem executar ações ou criar continuação.

### Aquisição mínima recomendada

Para começar com segurança de contrato: preservar shell para descoberta/ACL; obter full quando se precisa afirmar zero de fila/background histórico/settlement; montar resposta de uma única observação validada. Full fornece transação de domínio, shell usa derivação backend distinta. Enquanto não houver endpoint snapshot canônico do próprio backend, usar (a) derivação explicitamente compatível sobre full, ou (b) shell/full/shell realmente frescos com validation conservadora e inconclusive em corridas. Um bounded pode alimentar latestResponse, mas ler bounded separado do full reintroduz o problema: preferir truncar texto de messages do full já adquirido no modo completo.

Para listagens/batch find/workset: normalizar só shell e marcar limitações, sem N full reads. Para wait: snapshot inicial e reducer de eventos com sequence, synchronized e domínios necessários; resnapshot se reducer não puder representar evento/version desconhecidos. Não alterar send para inferir intenção, delivery ou criar nova thread.

## Riscos, lacunas e bloqueios

- **Backend que serviu o incidente não foi identificado.** Há fonte T3 V2 completa em Git no commit T, mas isso não certifica instalação/commit runtime atual. Verificar capabilities/payload de snapshot real é trabalho posterior; não instalar/reiniciar para fazê-lo nesta tarefa.
- **Erro exato do run2 não foi observado.** A recusa Claude acima é candidata sustentada pelo código; não atribuí-la ao incidente como fato. Se não houve mudança de seleção/política, outra causa precisa ser investigada.
- **Não existe endpoint público universal “todos os processos de background” nem probe HTTP com resultado de hasPendingBackgroundWork.** Roster e timeline são o melhor estado estrutural observável; session.status e ausência de texto novo são proxies mais fracos.
- **Task opaca sem endAt/histórico por ID:** uma leitura final vazia não prova sucesso, nem permite reconstruir hora exata de término. Notification/outcome ou turn item terminal aumentam a evidência; sem join estruturado, não usar texto para criar fato.
- **Shell roster foi projetado para UI pós-turn.** Gates/suppression/rolled_back/persistent tools significam que sua cardinalidade não é um censo de processos. A implementação precisa expor a proveniência/cobertura ou usar domínio providerThreads/turnItems completo.
- **Codex resume futuro desconhecido:** gap explícito de resume-expected no adapter; background vazio hoje não impede evento futuro ou continuação automática.
- **Coerência cross-source e CAS:** global shell sequence e per-thread snapshotSequence não são iguais por definição; estabilidade por fingerprint não exclui ABA. Guard/read depois do ACK não impede concorrência de UI/outro client.
- **BFS/OAuth cache:** precisa de aquisição fresca explícita; não há prova de coerência runtime pela marca atual. Mudança só de roster pode escapar e settlement pode contradizer o corpo de t3_thread.
- **ADR de wait e docs de migração:** atualizar a seleção default descrita; não antecipar “0.12 English-only tools” sem decisão/implementação disponível.
- **Nenhum bloqueio para iniciar a implementação local do contrato observacional.** Bloqueios para prometer “background realmente acabou e próximo turn certamente inicia”: prova da versão runtime, erro/eventos do caso e suporte do backend para liveness/CAS. A entrega deve usar `knownPending`/`mechanicalEligibility` e preservar unknown, em vez de prometer esses fatos ausentes.
