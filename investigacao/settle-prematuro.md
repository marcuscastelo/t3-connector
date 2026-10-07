# Investigação: proteção versionada contra settle prematuro

Data: 05/10/2026, Brasília. Branch `investigate/settle-safety`; HEAD/base `34cc095bf9ed2b5452b87729da51e6d878404af3`, release 0.11.2. O tag local `v0.11.2^{}` aponta para esse HEAD. Esta investigação não implementa a proposta.

## Resultado e fronteira de evidência

É possível acrescentar um **guard opt-in por chamada, com versão própria**, sem mudar o comando enviado aos backends atuais nem o comportamento dos clientes que omitem o guard. O guard deve exigir aceite explícito vinculado à observação atual, recusar trabalho ativo/pendente, reler antes do envio e verificar o estado depois. O connector atual não faz essas verificações para settle.

Isso reduz erros do consumidor e do wrapper, mas **não impede o settle automático do backend no merge de PR**, não controla a UI/outros clientes e não constitui compare-and-set atômico no T3. Impedir essas transições exige suporte do backend. Não é correto vender a checagem local como garantia de permanência de `settled=true`.

Fontes usadas:

- Código e testes desta worktree, somente leitura. As referências `arquivo:linha` abaixo são desta base, salvo indicação explícita.
- `reference/README.md:3` e `reference/README.md:10`: o único arquivo upstream incorporado é o contrato de `pingdotgg/t3code` no SHA `8ed276c246b624631e7d39241ebfd22d8314cb68`, de 02/10/2026; é material de testes, não implementação do backend nem código carregado no runtime.
- Os casos 1–5 são relatos operacionais fornecidos no pedido. Precedentes recuperados corroboram o pin/unpin, a dona CD e a reabertura OAuth, mas não foram reproduzidos aqui. Não foram lidas sessões/transcripts nem executadas mutações em threads reais.
- O catálogo MCP nativo disponibilizado nesta sessão descreve `link_pull_request` como vínculo que acompanha o PR e liquida a thread no merge; descreve `t3_thread_organize` como operação sujeita às regras de lifecycle existentes. A descrição confirma o comportamento anunciado, não substitui inspeção da implementação upstream.

## 1. Mapa de caminhos no connector

### 1.1 Ferramentas expostas e comandos

Os nomes de escrita são gerados trocando ponto/hífen por underscore. O bridge com lease registra o catálogo em `src/escrita/ponte-mcp.mjs:57`; OAuth usa `writeToolName` em `src/oauth/session-writes.mjs:87` e registra em `src/oauth/session-writes.mjs:301`.

| Ferramenta MCP do connector | Action/entrada atual | Backend/encoding | Evidência |
|---|---|---|---|
| `t3_escrever_thread_settle` | `thread.settle`, `input:{threadId}` | `orchestration.dispatchCommand`, `{type:'thread.settle',commandId,threadId}` | `src/escrita/adapters.mjs:13`, `src/escrita/adapters.mjs:16` |
| `t3_escrever_thread_unsettle` | `thread.unsettle`, `{threadId}` | mesmo RPC, acrescenta `reason:'user'` | `src/escrita/adapters.mjs:17` |
| `t3_escrever_thread_pin` / `t3_escrever_thread_unpin` | `thread.pin` / `thread.unpin`, `{threadId}` | mesmo RPC, comandos de mesmo nome | `src/escrita/adapters.mjs:16` |
| `t3_escrever_thread_auto_settle_set` | `thread.auto-settle.set`, `{threadId,enabled}` | mesmo RPC | `src/escrita/adapters.mjs:19` |
| `t3_escrever_thread_pin_reorder` / `t3_escrever_thread_active_reorder` | `{threadId,orderKey}` | `thread.pin.reorder` / `thread.active.reorder` | `src/escrita/adapters.mjs:20` |
| `t3_escrever_thread_snooze` / `t3_escrever_thread_unsnooze` | `{threadId,snoozedUntil}` / `{threadId}` | `thread.snooze` / `thread.unsnooze`, esta última com `reason:'user'` | `src/escrita/adapters.mjs:18`, `src/escrita/adapters.mjs:16` |
| `t3_escrever_thread_archive` / `t3_escrever_thread_unarchive` / `t3_escrever_thread_mark_unread` | `{threadId}` | `thread.archive` / `thread.unarchive` / `thread.mark-unread` | `src/escrita/adapters.mjs:16` |
| `t3_escrever_thread_pull_request_link` | `{threadId,host,repository,number,url,source}` | `thread.pull-request.link` | `src/escrita/adapters.mjs:63` |
| `t3_escrever_thread_pull_request_unlink` | `{threadId,host,repository,number}` | `thread.pull-request.unlink` | `src/escrita/adapters.mjs:64` |

**`t3_thread_organize` não é uma ferramenta exposta por este connector.** Existe no MCP nativo T3 da sessão; os efeitos correspondentes são cobertos pelas actions acima. Não há handler genérico de organize em `src/`. Também não há alias remoto `link_pull_request`: aqui o vínculo usa `t3_escrever_thread_pull_request_link`. `list_thread_pull_requests` foi conscientemente omitida: cadeias/entradas são computadas por helper do servidor (`src/escrita/native.mjs:253`, `src/escrita/native.mjs:259`). Não confundir o catálogo nativo da sessão com o catálogo do pacote.

### 1.2 Fluxo com lease

1. `criarPonteEscrita` cria o MCP `t3-connector-write`, exige envelope estrito `{leaseId,environment,operationId,input}` e repassa ao relay privado (`src/escrita/ponte-mcp.mjs:35`, `src/escrita/ponte-mcp.mjs:40`, `src/escrita/ponte-mcp.mjs:43`, `src/escrita/ponte-mcp.mjs:57`).
2. `controller` escolhe o Dispatcher do environment, sem fallback, e chama `dispatch` (`src/escrita/controller.mjs:19`, `src/escrita/controller.mjs:54`). A identidade do relay é de canal; não é aceite da entrega por pessoa.
3. `Dispatcher.dispatch` parseia o schema da action, verifica autorização e reserva a operação no journal (`src/escrita/adapters.mjs:124`). Resolve o projeto via `adapter.projectForThread`, prepara conexão e envia uma vez pelo gate (`src/escrita/adapters.mjs:143`, `src/escrita/adapters.mjs:153`, `src/escrita/adapters.mjs:166`).
4. `projectForThread` consulta a shell para existência/projeto; não checa lifecycle (`src/escrita/conexao.mjs:149`). `prepare` abre WS V2 com ticket, e `invoke` usa o socket preparado (`src/escrita/conexao.mjs:87`, `src/escrita/conexao.mjs:99`, `src/escrita/conexao.mjs:130`).
5. `StagingRpcTransport.invoke` envia um frame Effect RPC; `orchestration.dispatchCommand` aceita recibo `{sequence}` (`src/escrita/transport-staging.mjs:12`, `src/escrita/transport-staging.mjs:33`, `src/escrita/transport-staging.mjs:42`). Sucesso marca a **operação do connector** `completed`; não é prova de aceite nem leitura de `settledAt` (`src/escrita/adapters.mjs:167`).

### 1.3 Fluxo OAuth

`t3Tools` cria `sessionWrites`, que reutiliza o Dispatcher com `SessionWriteGate`, autorizado pela sessão OAuth (`src/oauth/t3-tools.mjs:25`, `src/oauth/session-writes.mjs:12`). O envelope público é `{environment,operationId,input}`, sem leaseId (`src/oauth/session-writes.mjs:303`).

- `restricted`: Dispatcher por conexão e precheck do projeto autorizado (`src/oauth/session-writes.mjs:100`, `src/oauth/session-writes.mjs:125`, `src/oauth/session-writes.mjs:151`).
- `all`: contexto e inventário isolados por operação; releituras verificam projeto/ownership/workspace antes de enviar (`src/oauth/session-writes.mjs:155`, `src/oauth/session-writes.mjs:165`, `src/oauth/session-writes.mjs:176`). **Essas releituras não verificam run/pedidos/aceite para settle.**
- Ambos terminam no mesmo backend WS. Não há uma segunda implementação de settle que já forneça guard.

### 1.4 Leitura e reconciliação

`t3_thread` lê shell, depois `/bounded`, projeta estado/pedidos/run e retorna `settled:Boolean(thread.settledAt)` da shell (`src/servidor.mjs:41`, `src/servidor.mjs:52`, `src/servidor.mjs:323`). Não expõe `pinnedAt`, `settledAt`, `settledOverride`, `unsettledAt`, `autoSettleDisabledAt` ou PRs nessa resposta. O contrato upstream contém esses campos, muitos opcionais (`reference/packages_contracts_src_orchestrationV2.ts:367`, `reference/packages_contracts_src_orchestrationV2.ts:390`, `reference/packages_contracts_src_orchestrationV2.ts:1720`).

`t3_reconciliar_escrita` não reenvia comandos (`src/escrita/ponte-mcp.mjs:68`, `src/oauth/session-writes.mjs:306`). O adapter real, com recibo completed, responde `found:true` e normalmente `state:'unknown'`; sem recibo conhecido, `found:false` (`src/escrita/conexao.mjs:157`). Portanto não verifica se uma thread continua settled e não reconstrói efeito de um settle incerto lendo seu estado. OAuth diferencia recusa antes do envio (`sent:false`) em caminhos específicos (`src/oauth/session-writes.mjs:192`, `src/oauth/session-writes.mjs:220`).

## 2. Guardas atuais e lacunas dos seis casos

### 2.1 O que já protege

- Schema estrito, action fixa e nenhum RPC arbitrário (`src/escrita/adapters.mjs:13`, `src/escrita/adapters.mjs:84`). Um campo desconhecido não é ignorado.
- Environment/projeto/action autorizados e lease/sessão rechecados imediatamente antes do outbound. O gate não tem await entre sua última checagem e invoke (`src/escrita/gate.mjs:89`, `src/escrita/gate.mjs:97`, `src/oauth/session-writes.mjs:43`).
- Journal com reserva atômica, hash da action/entrada, conflito de operação e proibição de reenvio após resultado incerto (`src/escrita/adapters.mjs:125`, `src/escrita/adapters.mjs:134`, `src/escrita/adapters.mjs:174`).
- Guard de deleção de projeto com confirmação/count/trabalho ocupado; é **específico de project.delete**, não de settle (`src/escrita/project-admin.mjs:26`, `src/escrita/project-admin.mjs:84`, `src/escrita/adapters.mjs:158`). É precedente arquitetural útil. Não copiar seu predicado `busy` literalmente: ele ainda olha `status`/pedido da shell (`src/escrita/project-admin.mjs:69`), e o caso 6 exige considerar o run ativo separadamente.
- Leitura 0.11.2 dá prioridade ao run ativo; isso protege a interpretação do estado, não bloqueia escrita (`src/estado.mjs:62`, `src/estado.mjs:79`).

Não há guard de settle que exija estado terminal, ausência de run/pedido/fila, expectedRunId, aceite, dry-run ou pós-leitura. Não há sweep de settle ou observador de merge implementado no connector. `thread.auto-settle` (sem `.set`) não está no catálogo de actions.

### 2.2 Análise por caso

| Caso | Confirmado nesta base | Atribuição e lacuna | Proteção possível |
|---|---|---|---|
| **1. Merge do PR liquida dona antes da ativação** | O link é só comando repassado, sem aceite/flag de lifecycle (`src/escrita/adapters.mjs:63`). O contrato também separa link de sync (`reference/packages_contracts_src_orchestrationV2.ts:2560`, `reference/packages_contracts_src_orchestrationV2.ts:2574`). | Relatos OAuth ba36…/PR #5, CD cf5fecd6/PR #2 e decisão de evitar vínculo no PR #1. O catálogo nativo anuncia auto-settle no merge. O efeito posterior é **backend T3**, não uma chamada connector `thread.settle`. Implementação precisa não está neste repo. | Avisar que vínculo permite auto-settle upstream e expor vínculos na leitura versionada. Guard local de settle não intercepta merge/sync/UI. Não remover vínculos nem fazer unsettle automático. |
| **2. Pin limpa settledAt; unpin não restaura** | Comandos de pin/unpin não leem nem salvam estado anterior (`src/escrita/adapters.mjs:16`); resumo omite pinnedAt (`src/servidor.mjs:41`). Contrato tem pinnedAt opcional (`reference/packages_contracts_src_orchestrationV2.ts:1726`). | Limpeza/restauração são comportamento relatado do **backend**, corroborado pelo precedente da prova CD; não demonstrável apenas pelo schema. | Leitura versionada deve expor campo e disponibilidade, avisar sobre pin; não prometer reversibilidade semântica pin/unpin. Uma restauração exige novo aceite/observação, nunca compensação cega. |
| **3. Settle nativo recusado com run ativo ordinal 5, pending 0** | Settle connector não verifica atividade. Ausência de pedido não significa idle (`src/estado.mjs:100`). Erro nativo `orchestration_error` não é código de guard criado neste connector. | A recusa nativa é **backend/handler nativo**; falta fonte de sua regra exata. No caminho genérico connector uma Failure RPC vira incerteza, fecha transporte e exige reconciliação (`src/escrita/transport-staging.mjs:31`, `src/escrita/transport-staging.mjs:54`, `src/escrita/adapters.mjs:182`). | Guard versionado recusa antes do envio se houver run ativo, mesmo com pending 0. Pós-leitura de settled=false não deve ser convertida em sucesso nem em autorização de retry. |
| **4. Tentativa nova falha por pasta ausente e reabre thread settled, sem entrega** | `thread.send` só codifica message.dispatch; não grava unsettled localmente (`src/escrita/adapters.mjs:60`). Journal e settled são dimensões distintas (`src/escrita/adapters.mjs:167`, `src/servidor.mjs:52`). | Transição de lifecycle durante atividade nova é **backend**. Não está confirmado em que ponto relativo à validação da pasta ela acontece. Mesmo se o run não chegar a existir, pode haver mudança de updatedAt/unsettledAt. | Vincular aceite a uma observação, não só à última resposta; invalidar aceite anterior após mudança observável. Pós-verificação deve detectar desliquidação posterior ao comando. Não reenviar settle antigo para absorver atividade nova. |
| **5. Run completed inferido como aceite; GALM fechada sem escopo entregue** | `estadoDaThread` retorna completed a partir do status (`src/estado.mjs:135`); não há código que compare escopo/entrega ou chame settle automaticamente daí. `aguardarThread` retorna terminal sem executar settle (`src/espera.mjs:105`, `src/espera.mjs:127`). | **Erro de decisão do consumidor/agente**, não demonstra bug de encoding. `completed` do run e `completed` da operação não são aceite da entrega. | Declaração de aceite obrigatória apenas no modo novo; referência de evidência e observação/run esperados. O wrapper não consegue provar que escopo foi entregue nem impedir que o cliente fabrique a declaração. |
| **6. 47db656 e estado do guard** | Commit `47db656c4ab2470ca9964625f846c928eae13110`, integrado na base 0.11.2. Prioridade: pedido > ativo > limite/plano > resultado mais recente (`src/estado.mjs:24`, `src/estado.mjs:92`, `src/estado.mjs:100`). Teste reproduz newest cancelled e older running (`test/estado-contrato.test.mjs:15`, `test/estado-contrato.test.mjs:52`). | Um guard baseado somente em shell.status, latestRun.status, providerSession.ready ou streaming repetiría o erro anterior. A bounded pode omitir o run mais novo (`src/servidor.mjs:347`). | Reutilizar a precedência canônica, complementada por snapshot completo/fila. Recusar também waiting sem pedido visível; não tratar activeRunId ausente como ausência de atividade (`src/estado.mjs:68`, `test/estado.test.mjs:153`). |

O contrato tem `thread.auto-settle` interno com snapshotAt e proteção contra override explícito (`reference/packages_contracts_src_orchestrationV2.ts:2460`). Isso documenta uma guarda upstream para **settlement sweep**. Não prova que o fluxo de merge de PR a usa nem que `thread.auto-settle.set(enabled:false)` o desabilita. Não usar essa flag como solução comprovada do caso 1.

## 3. Versionamento e encaixe compatível

### 3.1 O que existe

| Dimensão | Mecanismo real | Consequência |
|---|---|---|
| Release do connector | `package.json:3`, `VERSAO` em `src/servidor.mjs:23`, `VERSAO_ESCRITA` em `src/escrita/ponte-mcp.mjs:8`; teste `test/versao.test.mjs:7` | Identifica artefato. Não negocia guard por chamada. Bump deve manter package/lock/constantes/changelog alinhados (`docs/releasing.md:10`). |
| Protocolo upstream | HTTP header `x-t3-orchestration-protocol:2`; descriptor exige orchestrationProtocolVersion=2; WS query orchestrationProtocol=2 (`src/t3.mjs:15`, `src/t3.mjs:61`, `src/t3.mjs:100`, `src/escrita/conexao.mjs:99`) | Versão do Orchestrator T3, não da política de settle do connector. Não subir para 3 para implementar uma checagem local. |
| Schemas de tools | Zod estrito por action, compartilhado entre lease e OAuth (`src/escrita/adapters.mjs:83`, `src/escrita/ponte-mcp.mjs:57`, `src/oauth/session-writes.mjs:303`) | Campo opcional versionado é uma extensão compatível. Cliente novo deve descobrir suporte via tools/list. Connector antigo rejeita campo desconhecido, sem mutation. |
| Capabilities | `t3Tools` oferece `{read:true,write:Boolean(writes)}` ao perfil OAuth (`src/oauth/t3-tools.mjs:30`); fachada MCP anuncia `{tools:{}}` (`packages/mcp-connector-kit/oauth/resource-server.mjs:91`) | Não há handshake de capability `safeSettle`, contractVersion global de tools ou negociação de política pelo clientInfo.version. Capabilities de modelos/providers são outro domínio. |
| Formatos internos | Cursor versão 2 (`src/paginacao.mjs:8`, `src/paginacao.mjs:44`); chave de journal `v2` (`src/escrita/adapters.mjs:100`); grants scopeVersion 2 (`src/oauth/session-writes.mjs:118`) | Precedentes de formatos versionados; não reutilizar esses números para significado diferente. |
| Opt-in de catálogo | PROJECT_ADMIN e NATIVE_TOOLS, desligados por padrão e restritos a OAuth/all (`src/oauth/config.mjs:6`, `src/oauth/config.mjs:14`); novas actions fora de ACTIONS (`src/escrita/adapters.mjs:77`) | Consents antigos não recebem novas actions. Registro verifica actions concedidas (`src/oauth/session-writes.mjs:285`). Útil se se optar por nova ferramenta, mas não obrigatório para o guard da action já concedida. |

### 3.2 Releases 0.9–0.11

- **0.9.0:** perfil OAuth/all acrescentado mantendo restricted, stdio ACL e lease snapshot (`CHANGELOG.md:117`); fixes de isolamento/consent e não reenvio (`CHANGELOG.md:98`). Não houve nova versão negociada do contrato de settle.
- **0.9.1:** captura diagnóstica expressamente opt-in, default off (`CHANGELOG.md:80`). **0.9.2:** nova configuração de advertised resource sem substituir a autoridade do recurso aceito (`CHANGELOG.md:73`).
- **0.10.0:** ferramenta adicional `t3_providers`, filtros opcionais e default includeModels=false (`CHANGELOG.md:58`). Exemplo de descoberta por tools/list e extensão sem remover ferramentas.
- **0.11.0:** wrappers nativos e project admin opt-in, catálogos/consents existentes preservados (`CHANGELOG.md:44`, `CHANGELOG.md:51`). A proteção local de delete vem acompanhada de pós-checagem e declaração do limite upstream.
- **0.11.1:** mudança de resiliência de cache OAuth (`CHANGELOG.md:30`), não contrato de lifecycle.
- **0.11.2:** campos adicionais stateSource/activeRun/latestRun informativo e correção de precedência (`CHANGELOG.md:5`); runtimeMode opcional mantém full-access por omissão (`CHANGELOG.md:26`). São precedentes diretos para preservar defaults e acrescentar informação.
- Contraste histórico relevante: **0.6.0** foi ruptura explícita, sem aliases, e schemas passaram a recusar nomes antigos (`CHANGELOG.md:143`, `docs/adr/0004-english-contract.md:26`). Não usar esse modelo de ruptura para este pedido.

**Encaixe recomendado:** extensão opcional da entrada de `thread.settle`, com `settleGuard.version=1`, mais leitura opt-in versionada em `t3_thread`. Uma release aditiva futura (por exemplo 0.12.0, sujeito à dona de release) anuncia suporte. A release e a versão 1 da política são números independentes. Não inferir ativação pelo semver do cliente/backend; não mudar o default de clientes existentes. Os tags/changelog locais foram examinados; esta investigação não verifica publicação remota dos artefatos 0.9–0.11.

## 4. Proposta concreta de contrato v1

### 4.1 Descoberta e modo de verificação sem mutação

Adicionar parâmetro **opcional** `settlementContractVersion:1` a `t3_thread` nos três perfis (leitura stdio, leitura sob lease, OAuth). Sem o parâmetro, preservar formato/caminho de leitura atuais. Com ele, acrescentar `settlement`:

```json
{
  "contractVersion": 1,
  "guardVersions": [1],
  "guarantee": "connector_preflight_and_observation",
  "observationId": "opaque-versioned-digest",
  "snapshotSequence": 123,
  "complete": true,
  "eligibleMechanically": true,
  "acceptanceRequired": true,
  "settledAt": null,
  "unsettledAt": null,
  "settledOverride": null,
  "pinnedAt": null,
  "autoSettleDisabledAt": null,
  "linkedPullRequests": [],
  "fieldAvailability": {"pinnedAt": true, "pullRequests": true},
  "blockers": [],
  "warnings": []
}
```

Esse é o **dry-run**: somente observação, nenhuma reserva de operação/commandId e nenhum `dispatchCommand`. `eligibleMechanically` não significa entregue/aceito e não autoriza settle. Ausência de campo opcional upstream deve produzir disponibilidade falsa/valor desconhecido, não `pinned=false` ou “não há PR”. Se identidade/atividade/pedidos/fila não puderem ser determinados com completude, retornar complete=false e blockers; o guard não faz fallback para legacy.

A capacidade é descoberta pelo schema e pela resposta versionada, sem depender de extensão MCP customizada em initialize. Backend antigo que suporte os GETs necessários pode ser usado; backend que não suporte a observação completa é recusado **somente no opt-in**. O prefixo do digest inclui versão, environmentId e threadId; não é credencial, assinatura de aceite ou autorização.

A leitura opt-in deve usar snapshot completo, não só bounded. O cliente real já tem `threadCompleto` (`src/t3.mjs:87`, `src/escrita/conexao.mjs:139`). A bounded atual é apropriada para conversa, mas ausência de run/pedido numa janela truncada não prova ausência de atividade (`src/servidor.mjs:327`, `src/servidor.mjs:350`, `src/pedidos-runtime.mjs:76`).

### 4.2 Entrada opt-in de settle

Manter ferramentas/envelopes/action atuais. Acrescentar `input.settleGuard` opcional, objeto estrito, sem default que o injete em chamadas antigas:

```json
{
  "threadId": "thread-id",
  "settleGuard": {
    "version": 1,
    "expectedRunId": "latest-observed-terminal-run",
    "expectedObservationId": "opaque-versioned-digest",
    "acceptance": {
      "accepted": true,
      "evidenceRef": "review-result-or-delivery-reference"
    }
  }
}
```

- Omissão do objeto inteiro = **legacy**, encoding, hashes, autorização e resultado atuais. Não tornar aceite obrigatório globalmente nem proteger clientes antigos sem que optem.
- Dentro do modo v1, todos os campos acima são obrigatórios; `expectedRunId` aceita null **apenas quando a observação confirma nenhum run**. O guard exige `acceptance.accepted===true`; não preenche isso a partir de completed, merge, resposta “Pronto” ou fim da espera.
- `evidenceRef` é referência curta e limitada de aceite do escopo, não transcript, texto da tarefa ou material clínico. Não inventar a referência nem prometer que o connector verificou seu conteúdo. É declaração do consumidor que deve ter autoridade para aceitar a entrega; não exige novo fluxo humano de passkey por ação.
- `expectedRunId` significa o run mais recente observado/absorvido; o guard exige ausência de qualquer atividade. `expectedObservationId` também muda com atividade nova que não produziu resposta/run. Só expectedRunId seria insuficiente para o caso 4.
- Não permitir `requireNoActiveRun:false`/`requireNoPendingRequests:false` nesta versão: ausência de atividade/pedidos/fila é parte fixa da política v1. Outra política futura exige versão/capacidade diferente.
- `settleGuard` e aceite ficam no connector/journal. **Nunca espalhar esses campos no payload WS**. Enviar somente o comando upstream atual `{type:'thread.settle',commandId,threadId}`. O encode genérico atual espalha `...p` (`src/escrita/adapters.mjs:14`); implementar encode específico é indispensável.

### 4.3 Observação e precondições

Implementar helper próprio compartilhado, por exemplo `src/escrita/settle-guard.mjs`, com parsing/validação estritos e avaliação pura. Acrescentar ao adapter leitura `settlementObservation(threadId)` baseada em shell + full snapshot. Não vincular sua disponibilidade à flag OAuth NATIVE_TOOLS: o guard também serve o bridge com lease.

1. Exigir authorization/environment/projeto antes de expor estado/evidência. Em OAuth/all, manter contexto por operação; não compartilhar observação/fingerprint entre chamadas.
2. Obter shell e snapshot completo coerentes por snapshotSequence; validar IDs, projeto, arrays, status e timestamps. Tentativas programáticas limitadas, por exemplo três, com deadline total; depois `settle_observation_incomplete`. O precedente de coerência por sequence está em `src/escrita/project-admin.mjs:47` e `src/escrita/project-admin.mjs:74`. Verificar com backend suportado a equivalência das sequences de shell/full; não presumir só pelo nome.
3. Avaliar estado com a precedência de `estadoDaThread`/`runAtivoDaShell`, **e** examinar todos os runs/pedidos do snapshot completo. Bloquear preparing, starting, running, waiting e queued (incluindo fila retida, que pode não ser latestRun); bloquear pendingRuntimeRequest da shell e qualquer runtimeRequest.status=pending. Inconsistência entre sinais ou status desconhecido falha fechado apenas no opt-in.
4. Bloquear também `needs_intervention` por plano/limite de uso e trabalho de fundo pendente conhecido. Estado terminal não é critério suficiente. No v1 uma thread sem run ou com run completed/failed/cancelled pode ser aceita explicitamente após absorção do resultado; não exigir completed como substituto de aceite.
5. Comparar run e digest esperados. Construir digest determinístico com versão/environment/thread/projeto, updatedAt, latest run e seu status, atividade/fila, IDs/status de pedidos, mensagens mais recentes por ID/timestamp (sem textos), settledAt/unsettledAt/override, pin e links/estado de PR conhecidos, e trabalho de fundo. Incluir disponibilidade de campos opcionais. Não incluir sequence global no digest, para evitar invalidar aceite por evento em outra thread; usá-la apenas para coerência/freshness.
6. Rodar o guard após `adapter.prepare` e `validateTarget`, no ponto do preflight final, antes de journal uncertain/outbound (`src/escrita/adapters.mjs:153` a `src/escrita/adapters.mjs:166`). Fazer checagem de autoridade antes e depois das leituras. Uma revogação durante o GET deve impedir o envio e a divulgação do resultado.
7. Opcionalmente serializar no processo as próprias operações de lifecycle/send por environment/thread até concluir o pós-check. O lock não cobre outro processo, UI ou backend; não é exigência para anunciar atomicidade. Mesmo sem await local entre decisão final e invoke, existe janela HTTP-read → WS-command no servidor.

O guard deve consultar estado canônico e sinais completos, nunca providerSession.ready, streaming=false, apenas latestRun.status ou apenas pendingRequests.length. A regra da 0.11.2 é condição necessária, mas a leitura conversacional de duas fontes sem checar suas sequences não é uma precondição atômica.

### 4.4 Depois do envio: operação, efeito e permanência

Após receber `{sequence}`, persistir imediatamente o recibo/estado completed da **operação**. Depois fazer leitura limitada coerente, com sequence observada >= sequence do recibo, para reportar efeito. Uma leitura atrasada não é mismatch confirmado. Não reaproveitar o mesmo catch de falha de envio para uma falha da leitura posterior.

No resultado **guarded apenas**, acrescentar:

```json
{
  "settlement": {
    "contractVersion": 1,
    "postCheck": "verified",
    "settled": true,
    "code": null,
    "observationSequence": 124,
    "guarantee": "observed_at_sequence"
  }
}
```

Estados postCheck: `verified`, `mismatch`, `unavailable`. `verified` requer observação settled=true, freshness e ausência de nova atividade incompatível. `mismatch` significa efeito incompatível observado, não certeza de que o comando nunca teve efeito; pode ter sido desfeito pelo backend/outro cliente. `unavailable` inclui leitura incoerente/atrasada dentro do deadline. Preservar recibo, não enviar unsettle/settle/pin adicional, não fechar todas as sessões apenas porque essa leitura falhou, não dizer “aceito operacionalmente” a partir do recibo.

Persistir esse pós-check com a operação. Repetição do mesmo operationId devolve **o mesmo recibo/diagnóstico, sem rerodar o settle**; leitura nova é invocação explícita de t3_thread versionada. Hoje o replay genérico de actions retorna status sem receipt, enquanto project/native incluem receipt/postCheck (`src/escrita/adapters.mjs:137`): guarded precisa entrar no ramo que preserva evidência sem alterar o replay legacy. Não sobrescrever resultado incerto com uma simples leitura settled=true: ela não atribui o efeito ao nosso commandId.

Para guarded pode-se derivar commandId estável da operação como send/project/native já fazem (`src/escrita/adapters.mjs:148`, `src/escrita/adapters.mjs:150`, `src/escrita/adapters.mjs:162`). Settle legacy hoje usa randomUUID do encode. Não mudar chaves/hashes legacy nem instituir retry após incerteza. O hash guarded inclui versão, expectedObservationId e aceite; mudar qualquer um com o mesmo operationId resulta em operation_conflict. Reavaliar com nova observação/intenção pode originar **nova** operação, não repetir a antiga silenciosamente.

### 4.5 Códigos de erro e transporte

Novos códigos somente quando o opt-in está presente:

| Código | Condição / resultado |
|---|---|
| `settle_guard_version_unsupported` | Versão inteira de guard não suportada; nada enviado. Para versão 1 anunciar os campos obrigatórios no schema; shape inválido continua erro SDK `-32602`. |
| `settle_acceptance_required` | accepted=false ou declaração semanticamente inválida; nada enviado. Ausência de campo obrigatório pode ser recusada pelo schema antes do handler. |
| `settle_run_changed` | expectedRunId difere da observação coerente; nada enviado. |
| `settle_observation_changed` | Digest não corresponde ao estado atual; nada enviado. |
| `settle_active_run` | Trabalho preparing/starting/running/waiting ativo; nada enviado, mesmo com pending 0. |
| `settle_pending_request` | Pedido pendente por qualquer fonte coerente; nada enviado. |
| `settle_queued_work` | Run queued, inclusive retido; nada enviado. |
| `settle_unresolved_work` | Plano/limite com intervenção ou background conhecido pendente; nada enviado. |
| `settle_observation_incomplete` | GET indisponível/não suportado, snapshot inconsistente, campos essenciais ausentes ou status desconhecido; nada enviado. |
| `settle_postcondition_mismatch` | Diagnóstico pós-envio, junto ao recibo, postCheck=mismatch. Não representar como recusa sent=false. |
| `settle_verification_unavailable` | Diagnóstico pós-envio, junto ao recibo, postCheck=unavailable. Não representar como efeito incerto do transporte. |

Preservar distinção entre SDK invalid input, recusa preflight e falha outbound. Estabelecer ordem determinística: validar versão/aceite, completude, blockers de atividade/pedidos/fila, depois run/digest esperados; assim o caso ativo não depende de um runId stale para ser recusado.

Hoje `RECUSAS` não aceita settle_* e uma Error genérica preflight vira dispatch_rejected (`src/escrita/adapters.mjs:97`, `src/escrita/adapters.mjs:186`). A implementação deve acrescentar códigos seguros ou classe de recusa do connector, persistindo `state:'rejected'`, código e `sent:false`, sem atribuir esses erros ao backend. A lease bridge e OAuth precisam ambos explicar os novos códigos (`src/escrita/ponte-mcp.mjs:10`, `src/oauth/session-writes.mjs:60`). O relay HTTP precisa preservar o código, evitando perder a distinção no percurso (`src/escrita/ponte-mcp.mjs:74`). Não serializar entrada rejeitada/evidenceRef como mensagem de erro.

Manter `reconciliation_required` e estado uncertain para falha após tentativa de envio. O modo nativeErrors atual é acionado só para specs native (`src/escrita/adapters.mjs:166`); não alterá-lo globalmente para “resolver” o caso 3. Qualquer adaptação de typed refusal do settle exige evidência da semântica upstream de não commit antes da Failure. O erro nativo relatado não prova isso para o WS genérico.

### 4.6 Avisos de lifecycle e limite upstream

Na leitura versionada, retornar `linked_pr_merge_can_auto_settle` quando houver PR vinculado, inclusive merged ou estado desconhecido; afirmar que a permanência da thread depende do backend. Se os vínculos não estão disponíveis, retornar `linked_pr_state_unavailable`, não garantir ausência de auto-settle. A leitura também expõe pinnedAt/disponibilidade e aviso `pin_can_clear_settlement` para estado settled.

Uma extensão opcional futura da entrada de pin/link pode exigir acknowledgement explícito desses efeitos, removido do payload antes de enviá-lo; não é necessária para a primeira entrega do guard de settle. Os clientes v1 podem consultar a leitura antes de pin/link. O link legacy deve continuar repassado como hoje; não acrescentar automaticamente auto-settle.set(false), unlink ou compensação.

Uma versão futura **negociada com backend** poderia anunciar capability, por exemplo `settlePreconditions.version=1`, com aceitação de expectedRunId/revision e teste/commit sob a mesma transação. Só então encaminhar precondições upstream. Exige também política específica para settle por merge e por nova atividade/pin. Essa capability não existe nesta base; não inferi-la de serverVersion ou do protocolo V2.

## 5. Plano de testes

Os testes abaixo são proposta, não arquivos criados. Devem usar dados sintéticos e doubles locais. Nenhum caso precisa de thread real, GitHub real, pasta real ausente ou instalação de backend. Os doubles de lifecycle simulam os relatos para testar reação do wrapper; **não certificam a implementação T3**.

### 5.1 Regressão específica por caso

| Caso / nome do teste | Arquivo onde entraria | Double/fixture existente e adaptação | Asserções |
|---|---|---|---|
| **1 — `linked_pr_merge_is_backend_settlement_not_connector_acceptance`** | Novo `test/escrita-settle-guard.test.mjs`; aviso via MCP em `test/estado-contrato.test.mjs` | `setup`/`memoryJournal` de `test/escrita-fixtures.mjs:10`; inputs link/settle independentes de `test/escrita-acoes-fixtures.mjs:6`, `test/escrita-acoes-fixtures.mjs:30`; fixture thread de `test/fixtures.mjs:8`. Novo double stateful simula evento upstream merge alterando settledAt fora de invoke. | Link produz exatamente um thread.pull-request.link, sem thread.settle nem auto-settle.set. Merge simulado pode produzir settled=true sem aceite registrado. Leitura v1 inclui aviso/PR, mantém acceptanceRequired=true. Guard com accepted=false nunca envia settle, mesmo após merge. Vínculo/estado ausentes em backend antigo geram disponibilidade desconhecida. |
| **2 — `pin_unpin_does_not_restore_prior_settlement`** | `test/estado-contrato.test.mjs` e novo `test/escrita-settle-guard.test.mjs` | `ambientesFalsos`, `conectarMcp`, `dados` (`test/apoio.mjs:64`, `test/apoio.mjs:95`) e thread com pinnedAt/settledAt; fixtures pin/unpin. Stateful double: antes settled; pin altera pinnedAt e limpa settledAt; unpin só limpa pinnedAt. | Leitura antiga continua com formato anterior; leitura v1 mostra pinnedAt/disponibilidade e settledAt em três estados. Exatamente dois comandos para pin/unpin; nenhum settle de restauração automático. Digest anterior deixa de valer. Novo aceite/observação permite settle explícito e pós-check verified. |
| **3 — `guard_v1_refuses_active_ordinal_5_with_zero_pending`** | Novo `test/escrita-settle-guard.test.mjs`; transporte em `test/escrita-ponte.test.mjs` | `dispatcher`/adapter de `test/escrita-adapters.test.mjs:10` e `test/escrita-adapters.test.mjs:12`, setup com thread.settle incluída no grant; shell status running, activeRunId r5, projection run ordinal5, runtimeRequests []. `SocketFalso` de `test/escrita-ponte.test.mjs:48` para controle legacy Failure. | Guard retorna settle_active_run, journal rejected/sent=false, invokes=0, autorização continua válida. Legacy manda uma vez; frame Failure não interpretado vira uncertain/reconciliation_required, sem retry; leitura posterior false não elimina incerteza. Não exigir que o connector produza o código nativo orchestration_error. |
| **4 — `failed_new_activity_invalidates_previous_settle_acceptance_without_new_delivery`** | Novo `test/escrita-settle-guard.test.mjs`; integração em `test/oauth-t3.test.mjs` | `memoryJournal`, thread/mensagem fixtures; conexão falsa com prepare injetável (`test/oauth-t3.test.mjs:15`). Double inicia settled, conserva a resposta velha, simula tentativa de send/pasta ausente: unsettledAt/updatedAt mudam; variantes com run failed e sem run novo. | expectedObservationId antigo é recusado, mesmo que latestResponse/run anterior sejam iguais. Nenhum settle automático nem replay do send. Após absorção e nova referência/observação, nova operação pode passar. Variante em que nova atividade ocorre após settle ACK retorna completed+receipt+postCheck mismatch; exatamente um settle enviado. |
| **5 — `completed_run_and_completed_receipt_are_not_delivery_acceptance`** | Novo `test/escrita-settle-guard.test.mjs`; schema em `test/parametros.test.mjs` | thread(status completed) e projecao com mensagem sintética “falta ativação”; adapter de `test/escrita-adapters.test.mjs:12`; MCP InMemoryTransport/helper ponte (`test/parametros.test.mjs:19`). | Falta de aceite é invalid input ou settle_acceptance_required conforme shape; accepted=false é recusa nominal; completed nunca preenche aceite. Com aceite explícito e mesma observação envia exatamente um comando. Scope não entregue não é magicamente descoberto pelo guard: teste documenta essa fronteira. Legacy `{threadId}` mantém envio e recibo anteriores. |
| **6 — `settle_guard_uses_active_run_precedence_over_newer_cancelled_or_completed_run`** | Novo `test/escrita-settle-guard.test.mjs`, mantendo `test/estado-contrato.test.mjs`/`test/espera.test.mjs` | Reutilizar dados do cenário steer em `test/estado-contrato.test.mjs:15` (helper local hoje, extrair ou reproduzir valores), thread/projecao exports; fixture latest r4 cancelled e older r1 running, bounded só r1; variante latest completed, waiting com activeRunId null (`test/estado.test.mjs:153`). | Estado running/source active_run; runId r1; latestRun informativo. Guard recusa, invokes=0 mesmo com providerSession ready/streaming false. Snapshot completo recupera queued retido que bounded não trouxe. Variante sem ativo, run terminal coerente e aceite explícito passa. |

### 5.2 Contrato, compatibilidade e concorrência obrigatórios

1. **`settle_legacy_wire_hash_and_replay_are_unchanged`**, em `test/escrita-actions.test.mjs`/`test/escrita-adapters.test.mjs`: manter fixture atual de settle e pin/unpin; comparar action/input hash e conteúdo outbound com baseline, normalizando só UUID aleatório. Guard ausente não faz leitura extra nem acrescenta defaults/resultado settlement. Fixtures atuais cobrem mapping/autorização (`test/escrita-actions.test.mjs:17`, `test/escrita-actions.test.mjs:19`).
2. **`settle_guard_schema_is_discoverable_strict_and_never_forwarded_to_v2`**, em `test/parametros.test.mjs`: fields opcionais na entrada legacy, fields necessários no ramo v1; versão desconhecida/typo não envia. Spy do relay confirma entrada, spy do socket confirma **somente** type/commandId/threadId. Reutilizar InMemoryTransport e padrão de parâmetros desconhecidos (`test/parametros.test.mjs:28`, `test/parametros.test.mjs:91`). Não aceitar guardVersion do envelope se só input o define.
3. **`settle_guard_old_backend_fails_only_opt_in`**, novo teste: faltam full route, sequences ou campos essenciais; opt-in recusa/complete=false, legacy continua. pinnedAt/PR opcionais ausentes não são false. Snapshots com sequences distintas tentam no máximo o limite, sem laço infinito. Listar deadline e contagem de GETs.
4. **`settle_guard_checks_pending_queue_and_unknown_states`**, novo teste parametrizado: pedido só na shell, só no full, waiting sem pedido, fila retida, proposed plan, usage limit, background, status desconhecido. Ausência/erro de arrays não vira lista vazia. Cada variante retorna blocker nominal e zero outbound.
5. **`settle_guard_rechecks_after_prepare_and_revocation`**, novo teste e `test/oauth-t3.test.mjs`: promise/barrier em prepare/full GET permite run/pedido surgir ou sessão expirar entre leitura e dispatch. Última observação recusa; autorização revogada não devolve dados nem envia. Os precedentes são `test/escrita-adapters.test.mjs:35`, `test/escrita-adapters.test.mjs:36`, `test/oauth-t3.test.mjs:102`.
6. **`settle_guard_receipt_survives_post_read_failure_and_restart`**, novo teste com FileJournal: ACK sequence persistido, pós-read timeout/malformed/stale é unavailable, nunca uncertain/retry nem revogação global por si só. Reiniciar Dispatcher/handle e repetir operationId devolve evidência persistida, invokes=1. Resultado de envio perdido conserva uncertain e no-resend, seguindo `test/escrita-adapters.test.mjs:38` e `test/escrita-adapters.test.mjs:41`.
7. **`settle_guard_post_check_requires_ack_sequence_and_reports_later_activity`**, novo teste: leitura settled=false anterior ao ACK não é mismatch; releitura coerente >= ACK decide. settled=true com atividade nova é mismatch. Novo run entre último preflight e commit demonstra limite do preflight; não afirmar bloqueio atômico. Spy exige zero comandos compensatórios.
8. **`settle_guard_isolated_across_environments_and_oauth_invocations`**, em `test/escrita-controller.test.mjs`, `test/oauth-t3.test.mjs` e `test/oauth-all-projects.test.mjs`: mesmos threadId/projectId em local/remoto; digest local não vale no remoto; duas chamadas concorrentes com snapshots distintos não se misturam. Helpers conexaoFalsa/montar são locais nesses arquivos; estendê-los com leitura stateful ou criar fixture dedicada, não assumir export inexistente (`test/escrita-controller.test.mjs:9`, `test/escrita-controller.test.mjs:19`, `test/oauth-t3.test.mjs:15`, `test/oauth-t3.test.mjs:27`).
9. **`settle_guard_preflight_codes_survive_both_mcp_profiles_and_reconcile`**, bridge/OAuth: isError com código seguro, rejected/sent=false, nenhuma reconexão forçada. Reconcile reautoriza environment/action/projeto/caller antes de mostrar diagnóstico. Replay de recusa conserva código; mesma operationId com aceite/digest diferente é operation_conflict. Lease também precisa retorno adequado para rejected sem target; hoje o tratamento especial é OAuth (`src/oauth/session-writes.mjs:192`).
10. **`settlement_read_version_is_opt_in_in_all_profiles`**, `test/estado-contrato.test.mjs`, `test/escrita-read-guarded.test.mjs`, `test/oauth-t3.test.mjs`: resultados atuais sem extras por omissão; mesmo contractVersion/schema em leitura stdio, leased-read e OAuth. Sem privilégio de leitura ou consent inválido, nada é exposto. Não aumentar ACTIONS/consents quando o guard usa a action settle existente.

Os doubles atuais que só retornam sequence (por exemplo `test/escrita-adapters.test.mjs:12`) não simulam efeito de settle; precisam receber estado observável separado. Em `test/escrita-fixtures.mjs:15`, setup não concede settle por padrão: o teste deve adicioná-la explicitamente antes de obter a lease. O fixture `projecao` devolve thread vazio (`test/fixtures.mjs:55`); para guard é necessário preencher identidade/thread e snapshotSequence. Testar só encoding ou receipt seria insuficiente.

### 5.3 Baseline executável

**Suíte não executada:** `node_modules` não existe nesta worktree. Não foi feito npm install/ci nem reaproveitada instalação externa. Portanto este relatório não afirma testes verdes ou número de passes nesta base.

Quando houver dependências previamente disponíveis no ambiente de implementação, baseline relevante:

```sh
node --test test/estado.test.mjs test/estado-contrato.test.mjs test/espera.test.mjs test/pedidos-runtime.test.mjs test/parametros.test.mjs test/escrita-actions.test.mjs test/escrita-adapters.test.mjs test/escrita-controller.test.mjs test/escrita-ponte.test.mjs test/escrita-read-guarded.test.mjs test/oauth-t3.test.mjs test/oauth-all-projects.test.mjs test/oauth-native-tools.test.mjs
```

Após implementação, incluir `test/escrita-settle-guard.test.mjs` e rodar `npm test` conforme `package.json:28`. Não executar `npm run smoke`: o script live não é necessário nem autorizado nesta investigação. Teste de artefato/release fica para a implementação/release; não foi executado aqui porque não há dependências e scripts de pacote não são tarefa apenas de leitura.

## 6. Riscos e perguntas abertas

| Risco/pergunta | Evidência | Decisão proposta / verificação pendente |
|---|---|---|
| Cliente antigo mantém possibilidade de settle prematuro | settle só exige threadId (`src/escrita/adapters.mjs:16`) | É consequência deliberada da compatibilidade. Anunciar alcance opt-in; não dizer proteção universal. |
| Cliente novo conectado a connector antigo ou gate antigo | Schemas estritos e bridge/gate devem subir juntos (`src/escrita/ponte-mcp.mjs:25`, `docs/adr/0004-english-contract.md:39`) | Descobrir suporte por schema; recusa nunca autoriza downgrade automático. Atualizar bridge/gate juntos. |
| Defaults no parsing alteram hash de operações legacy | hash é digest de action/parsed.input (`src/escrita/adapters.mjs:126`) | Não injetar settleGuard default; testar journal existente/replay. Não bump scopeVersion/chave v2 por esta extensão. |
| Preflight não atômico e pós-leitura não permanente | settle upstream não tem expectedRunId/revision (`reference/packages_contracts_src_orchestrationV2.ts:2455`) | Garantia anunciada é observação. CAS e regras de merge exigem capability upstream real. |
| Snapshot completo tem custo/payload; sequence global muito movimentada pode impedir coerência | leitura atual usa bounded; full disponível (`src/servidor.mjs:327`, `src/t3.mjs:87`) | Full só opt-in, deadlines/limite de tentativas. Medir tamanho/latência; se a API full não der completude/coerência garantida, bloquear modo v1 nesse backend. Não simular atomicidade concatenando leituras. |
| Older backend omite campos de lifecycle | pinnedAt/pullRequests opcionais (`reference/packages_contracts_src_orchestrationV2.ts:369`, `reference/packages_contracts_src_orchestrationV2.ts:1726`) | Ausência é desconhecido. Decidir quais extras são apenas warning e quais são essenciais; atividade/pedido/fila nunca assumidos vazios sem prova. |
| Aceite booleano não verifica escopo | código só sabe estado, sem modelo de entregáveis (`src/estado.mjs:135`) | Aceite deve vir do dono/consumidor com autoridade e evidência. Pode ser inferido incorretamente mesmo no modo v1; proteção é contra inferência implícita, não certificação semântica. |
| Auto-settle.set(false) talvez não afete merge de PR | comando enabled e sweep interno são separados do PR sync (`reference/packages_contracts_src_orchestrationV2.ts:2460`, `reference/packages_contracts_src_orchestrationV2.ts:2492`, `reference/packages_contracts_src_orchestrationV2.ts:2574`) | Não recomendar workaround como fato. Inspecionar handlers/serviço de PR upstream em trabalho separado; sem mutação real nesta investigação. |
| Pin/unpin e nova atividade têm semântica upstream não contida no schema | contrato declara campos/comandos, não seu reducer | Relatos estão atribuídos ao backend; testes serão simuladores. Precisamos de fonte do reducer/handlers da versão alvo para confirmar ordem exata das transições. |
| `orchestration_error` nativo versus WS Failure | generic transport trata falha como uncertain; typed errors só opt-in native (`src/escrita/transport-staging.mjs:31`, `src/escrita/adapters.mjs:166`) | Não mapear recusa nativa para “nada enviado” no WS sem evidência. Guard local evita caso observado antes do envio; corrida continua possível. |
| Pós-read gera novo erro depois de ACK e acaba revogando tudo | catch atual fecha gate se já saiu de preparing (`src/escrita/adapters.mjs:182`) | Separar pós-check do catch outbound, persistir recibo primeiro e retornar diagnóstico. Falha do journal mantém tratamento fail-closed existente. |
| Replay retorna sucesso histórico embora a thread tenha reaberto | replay genérico retorna status; reconcile real não observa settled (`src/escrita/adapters.mjs:137`, `src/escrita/conexao.mjs:157`) | Guarded retorna observação histórica com sequence, sem claim de estado atual. Nova leitura explícita para estado atual; nunca reaplicar operação concluída. |
| Estado `settled=true` preexistente, talvez por merge prematuro | resumo é Boolean(settledAt), separado de state (`src/servidor.mjs:52`) | Não concluir que foi aceito. Guard v1 ainda exige declaração e ausência de blockers, mesmo se já settled. Não fazer unsettle para “corrigir” automaticamente. |

Perguntas práticas para a implementação: (a) quais versões de backend dão shell/full com sequence comparável e snapshots completos de pedidos/fila? (b) quais trabalhos de fundo representam entrega pendente e precisam impedir v1? (c) a política de PR merge possui opt-out upstream separado do sweep? (d) um snapshot/revision próprio da thread pode permitir futura precondição atômica sem invalidar por eventos alheios? Nenhuma dessas respostas está comprovada pelo arquivo de contrato copiado.

## 7. Entrega e limites cumpridos

Arquivo único produzido em `investigacao/settle-prematuro.md`, sem commit. Código `src/`, testes, package/lock e documentação versionada não foram alterados. Não houve push, PR, instalação nem escrita em threads T3. O impedimento de execução do baseline é a ausência de node_modules; a confirmação das transições internas dos casos 1–4 permanece limitada à fronteira upstream documentada acima.

<!-- FIM-INVESTIGACAO -->
