# Proposta de API batch mínima v1

Baseline e inventário completo: [análise das 74 tools de produção](batch-tools-analysis.md). Nomes abaixo são **novas propostas em inglês**, não tools existentes nem decisão de renomear o catálogo 0.11.2. Não há implementação nesta entrega.

## Decisão recomendada

Entrar com **cinco tools**, em duas etapas de validação da mesma v1:

| Prioridade | Tool proposta | Ganho principal | Recorte |
|---|---|---|---|
| P0.1 | `t3_thread_find_batch` | Resolver referências de várias donas com uma leitura por ambiente | Busca atual por título/ID; não inclui busca nativa de conteúdo |
| P0.2 | `t3_inbox_read_batch` | Painel de múltiplos projetos/ambientes sem repetir shell | Views tipadas `projects`, `threads`, `attention`, uma view por chamada |
| P0.3 | `t3_thread_read_batch` | Aceite de várias donas com estado, pedidos e retornos | Views `state`, `detail`, `messages`, uma view por chamada |
| P0.4 | `t3_write_reconcile_batch` | Inspecionar efeitos conhecidos/incertos com segurança | Recibos por operationId ou recuperação de manifesto por batchId |
| P1 | `t3_thread_inbox_update_batch` | Inbox-zero após triagem/aceite explícitos | Uma ação por chamada; dez ações de organização permitidas |

P1 só entra depois dos gates de journal, isolamento e revogação. As cinco tools cobrem **17 nomes atuais** diretamente: projetos, threads, atenção, thread e mensagens (5), busca (1), reconcile (1) e mutações de inbox (10). A view `state` é uma projeção compacta nova, não a inclusão automática de todos os wrappers nativos.

Ações permitidas em `inbox_update`: **snooze, unsnooze, settle, unsettle, auto_settle_set, archive, unarchive, pin, unpin, mark_unread**. Cada uma mapeia para a ação interna atual `thread.*`, sem trocar identificadores de grant/journal. `auto_settle_set` apenas liga/desliga a configuração; não expõe `thread.auto-settle`, que é comando interno do sweep nativo.

Não incluir na v1: send, runtime/model/provider, run/queue, scheduler, launch/fork/delegação, PR links, project admin, busca de conteúdo e waits. São oportunidades reais, classificadas A/B na matriz, que precisam de contratos próprios. `visit` fica para depois porque marcar como visto exige o watermark exato do conteúdo revisado, ainda não exposto de forma suficiente no resultado atual.

## Contrato comum

### Identidade, seleção e schema

- Todos os alvos de leitura/mutação carregam **environment explícito**; no manifesto ele vira a identidade canônica `environmentId` com o destino configurado. Alias é conveniência de entrada, não identidade persistente. Não mudar destino/ambiente ao repetir um batch.
- Thread é `(environmentId, threadId)`, projeto é `(environmentId, projectId)`, recibo é `(principal estável, environmentId, destination, operationId)`. IDs podem repetir entre hosts. `key` é correlação escolhida pelo cliente, não autorização.
- `items/scopes/queries` têm `key` única na chamada. Nunca resolver título em mutation; usar os IDs revisados. Não oferecer `allMatching`, wildcard de mutação, ação por projeto inteiro ou “busque e aplique” no mesmo comando.
- Schemas estritos e tipados. O envelope malformado, chave repetida, item estruturalmente inválido, alvo mutável duplicado ou action fora da allowlist rejeitam **a chamada inteira antes de qualquer envio**. Escopo negado, alvo ausente, precondição mudada ou falha de backend após admissão são resultados por item, com códigos seguros.
- Uma action/view por chamada evita misturar settle e send ou configurar e iniciar execução. Itens podem ter valores diferentes para a mesma ação, como datas de snooze distintas. Não aceitar `{toolName,args}` nem scripts/RPCs arbitrários.
- Não expandir relações de transfer/delegação/PR automaticamente. Para inspecionar uma thread relacionada, exigir um novo target autorizado.
- Manter permissões por ação e resource, incluindo flags/grants opcionais. Ter `connector:write` não autoriza toda a allowlist. Uma tool batch anunciada não transforma uma ação não consentida em consentida. No profile de lease, `leaseId` é comum à chamada e verificado por item; no OAuth o principal vem exclusivamente do servidor. Não misturar perfis na mesma chamada.

### Envelope de resposta e erro parcial

Todos os resultados preservam a ordem de entrada e contêm uma linha para cada `key`, mesmo em timeout, skip ou orçamento insuficiente. `items` não vira uma lista só de sucessos. Identidade canônica de alvos só é retornada quando sua divulgação é autorizada.

Leitura por item: `status: ok | error | not_read_budget | cancelled`, `data?`, `error?: {code,message}`, `observedAt?`, `sourceSequence?`, `truncated`. Código não inclui token, stack, caminho de credencial, conteúdo de prompt ou saída SSH. Falha do host não é coleção vazia. Conteúdo ausente é unknown, nunca false/zero.

Mutação por item: `status: applied | noop | rejected | failed | uncertain | not_started | replayed`, `operationId`, `journalState?`, `receipt?`, `error?`, `preconditionStrength?`, `postCheck?`. `replayed` inclui o `originalStatus` e **não prova aplicação**: pode reproduzir rejected/failed/uncertain. `noop` só é permitido se o efeito semântico já existir e puder ser conferido, não por ausência de campo. Sem prova, dispatch protegido ou rejeição; nunca inventar sucesso.

`journalState` mantém os estados atuais (`preparing`, `rejected`, `completed`, `failed`, `uncertain`). `applied` significa dispatch T3 confirmado, não que um provider acabou um turno; `postCheck: changed | unavailable` informa a observação posterior sem tornar uma mutação confirmada em “não enviada”. Um resultado incerto não é um failed retryable.

Campos do envelope: `returned`, `summary` por status, `complete` (nenhum trabalho do batch ficou sem conclusão conhecida), `allSucceeded` (todos os efeitos/leituras pedidos tiveram sucesso), `coverageComplete` nas buscas/agregações e `elapsedMs`. `complete=true` pode acompanhar rejeições/erros conhecidos; não significa allSucceeded. `complete=false` em leitura de cobertura incompleta ou mutação uncertain/not_started não autoriza reenvio. A documentação de cada tool define sua cobertura. Totais contam apenas a população observada e autorizada.

Erro global MCP (`isError`) fica para schema/admissão, autenticação inválida, batch conflitante ou impossibilidade segura de ler/persistir. Erros locais aparecem no JSON com o envelope intacto; `isError=false` não implica sucesso de todos os itens. Cancelamento pode impedir qualquer resposta; o cliente trata ausência de resposta de mutação como resultado desconhecido e consulta o manifesto.

### Idempotência e manifesto durável

Leituras não têm efeito repetível a deduplicar: são seguras de repetir, mas os dados podem mudar. Nenhum cache cruza principal, ambiente, filtro, grant ou observação. `batchId` de leitura, se existir, é apenas correlação.

Mutação exige **batchId e operationId por item**, ambos estáveis em retry. O operationId usa a chave atual do Dispatcher, que inclui principal estável, environment/destination. `batchId` identifica o manifesto no namespace daquele principal e binding de deployment. Não usar índice do array, timestamp novo ou sid/leaseId para identidade: reordenar itens, renovar autenticação ou reiniciar o connector não cria novos efeitos.

Antes do primeiro dispatch, reservar atomicamente no journal local o manifesto normalizado (keys, environments resolvidos, ação, inputs/precondições e operationIds), com hash canônico. Um batchId igual com conteúdo diferente retorna `batch_conflict`, sem novos envios. Normalizar por key evita que uma mudança apenas de ordem altere o significado; a resposta segue a ordem da chamada atual. Inputs não são publicados em logs; o manifesto precisa de armazenamento com a mesma proteção do journal e retenção documentada, sem credenciais. Logs guardam IDs correlacionáveis conforme política e códigos, não textos/respostas.

Cada item continua passando pelo **Dispatcher atual** e sua reserva atômica por operação. Não substituir N operações por um único `operationId`, nem tornar o RPC retryable por estar dentro de batch. Registrar resultados locais que não chegaram ao Dispatcher (noop/precondition skip) no manifesto. Reservar também a associação durável de cada operationId ao manifesto/input, inclusive para skips/noops, antes de qualquer execução: colisão com operação singular ou outro batch precisa ser detectada no mesmo namespace. Não registrar noop como completed de dispatch nem inventar receipt T3; o resultado local e o ACK remoto são fatos separados. A implementação precisa de reserva transacional dessas associações no journal local; se isso não puder ser feito, retirar a otimização de noop da v1 e sempre usar dispatch para ações válidas. No replay esses skips não viram novas tentativas. Um item rejected/not_started a ser reavaliado por uma intenção nova recebe **novo batchId e novo operationId**, depois de reler; repetir o batchId antigo é recuperação, não retomada de trabalho interrompido.

Crash depois de reservar manifesto e antes do item: continuar **somente a inspeção** do manifesto; a v1 não executa background/resume automático. Crash com reserva `preparing` antiga não é prova de ausência de envio; tratar conservadoramente como pendência de reconciliação. Journal completed existente deve ser recuperado e autorizado, nunca inferido por state visual. Documentar a janela conservadora em que o journal marcou uncertain antes do invoke e, mesmo sem envio físico, proíbe reenvio.

`exactly-once` distribuído não é promessa. O código atual estabiliza commandId explicitamente em send e project delete e fornece stableId a wrappers que o aceitam; várias ações base criam UUID no encode. A proteção principal é o journal com não reenvio de resultados incertos. Não presumir que todos os RPCs nativos (createNew, clone, settings, scheduler etc.) deduplicam remotamente.

### Best-effort, isolamento e interrupção

- **Sem transação de efeitos** entre threads/projetos/ambientes. Recusar `atomic:true` e não oferecer modo de rollback. A reserva do manifesto é atômica local; N dispatches T3 não são.
- Aplicar best-effort sobre itens independentes com falhas ordinárias. Alteração de escopo, perda/revogação da sessão, falha de journal/audit ou resultado de transporte incerto causam **parada global do batch**: não admitir novos envios. Itens já em voo podem concluir e ficam registrados; os restantes são not_started. Na v1, mutações sequenciais evitam N efeitos em voo quando o primeiro uncertain fecha a autoridade.
- Não enfraquecer `SessionWriteGate.close()`: atualmente falha grave revoga todas as sessões OAuth. A facade também **retém todo o resultado se a sessão acabou durante a chamada**. Nesse caso não é possível garantir que o cliente receba o envelope parcial: ele verá session_expired/erro/timeout, mesmo havendo efeitos aplicados. Reautenticar e consultar batchId/operationIds resolve a visibilidade; não reenviar. Essa limitação é parte do contrato, não motivo para liberar resultado após revogação.
- Checar autorização por item no início, imediatamente antes do invoke e antes de liberar conteúdo. Reutilizar conexão/snapshot autorizado por ambiente é otimização de leitura; **contexto mutável de escopo é privado por observação/operação**. Não compartilhar um Set `operationGrant` entre dois itens concorrentes. Nas escritas, preservar todas as revalidações atuais de projeto/workspace; uma autorização no topo do batch não as substitui.
- Não paralelizar ações sobre mesma entidade/fila, nem launch/delete no mesmo projeto. A v1 rejeita thread repetida mesmo que valores coincidam. Contratos futuros com mais de uma ação por entidade exigiriam dependência e ordem explícitas, fora deste desenho.
- Deadline global inclui conexão, autorização, preparação e leitura/espera/dispatch; não multiplicar timeout por N. Cancelamento encerra recursos do próprio batch, não interrompe runs, não “desfaz” comandos confirmados. Verificação de cancelamento entre itens e antes do envio; depois do envio, ausência de ACK permanece incerta.

### Limites iniciais e UX

Proposta inicial: **20 mutações**, **50 targets/queries de leitura**, **10 escopos de inbox**, até **4 ambientes consultados em paralelo** e **4 projeções em paralelo no total**, com limite por ambiente. Escritas sequenciais na v1, ajustáveis só após medir preservação do gate. Find/inbox/read/reconcile: deadline global de **10 s**; mutação: **20 s**, sem alterar janelas do Dispatcher nem forçar timeout de um RPC em voo como se não enviado. Lote grande retorna not_started; o cliente divide explicitamente depois de inspecionar os recibos. Esses limites são propostas, não benchmarks.

Orçamento padrão de resposta **64 KiB UTF-8**, máximo igual na v1, contado sobre o conteúdo serializado entregue; o envelope e todos os status mínimos precisam caber antes de admitir a chamada. Texto e coleções têm limites por item e orçamento global. Não omitir linhas para truncar resposta: leituras ainda não realizadas retornam not_read_budget; coleções lidas retornam truncated/cursor. Mutações sempre preservam operationId, status, erro seguro e recibo mínimo; campos extensos não essenciais ficam explicitamente truncados. Sem histórico/transcripts anexados ao manifesto.

A UI mostra seleção por ambiente/projeto, action, quantos alvos, datas locais, itens rejeitados/incertos e ações ainda não iniciadas. Não mostrar “20 concluídas” se só 17 aplicaram; noops, skips e reapresentação de recibos são contagens separadas. Para snooze, o schema continua com instante ISO absoluto compatível com o contrato atual; exemplos humanos desta entrega usam Brasília. Ao receber um valor Z/offset, converter para America/Sao_Paulo na conversa com Marcus. Não aplicar “amanhã” calculado separadamente no timezone de cada servidor.

`mode: preview` no inbox_update retorna alvo/estado observado, proposta e recusas previstas, sem reservar nem enviar operações T3. Precisa de permissão de escrita para a action proposta, já que a tool também tem apply (`readOnlyHint:false`); não é caminho de leitura privilegiado. Preview não vale como autorização futura, não executa, não garante o mesmo estado no apply. Apply revalida tudo. Não adicionar gesto humano ou passkey por item: conservar o profile de autoridade existente e a intenção explícita sobre os alvos.

## Schemas concretos da v1

Os exemplos são formatos de design. JSON usa IDs fictícios, campos em inglês e horários explícitos.

### 1. t3_thread_find_batch

```json
{
  "environments": ["polaris", "sirius"],
  "queries": [
    {"key": "owner-a", "search": "Correção runtimeMode", "match": "exact", "limit": 5},
    {"key": "owner-b", "threadId": "thread-b", "limit": 5}
  ],
  "timeoutMs": 10000
}
```

Environments obrigatório, não vazio, aliases/IDs configurados e deduplicados por environmentId. `visibility: active | all` deve delimitar o universo da busca: active é o recorte inicial da v1. all só pode ser anunciado quando a fonte de arquivadas tiver autorização e cobertura validadas; sem isso, retornar unsupported/inconclusive, não degradar silenciosamente para active. A descrição atual da busca singular promete arquivadas, mas o caminho de código usa apenas shell.threads da fonte HTTP active; isso é uma lacuna de cobertura documentada na análise, não uma garantia a herdar. Query aceita exatamente um de search/threadId; match só para search. `limit` e `cursor` são por query. Shell por ambiente compartilhada **dentro da chamada autorizada**, com aplicação de todas as queries em memória, conservando cobertura e ACL. Usar o mesmo snapshot melhora consistência local e evita Q×E leituras; não cria snapshot global entre hosts.

Output por key: status, query normalizada, total observado, returned, truncated, cursor, coverageComplete, queriedEnvironments/environmentFailures e candidates qualificados. `resolution: resolved | ambiguous | not_found | inconclusive`. Resolved exige **cobertura completa e total=1**; total>1 é ambiguous mesmo se a página mostrar só um; zero com cobertura completa é not_found **apenas no visibility/universo declarado**, não prova inexistência fora dele; resultado único/zero com falha de ambiente é inconclusive. Ambiguous pode também ser coverageComplete=false. Não escolher “o mais recente”, primeiro, prefixo ou host padrão. Uma resolução de leitura não autoriza a mutação.

Cursor liga query, conjunto de ambientes, cobertura e política/filtros de acesso, com validade documentada, incluindo visibility e fontes da população consultada. Cobertura mudou: erro local cursor_coverage_changed e nova primeira página para aquela query, sem reaproveitar silenciosamente o cursor em resultados diferentes. Cursor não é capability: autorização é refeita a cada página.

### 2. t3_inbox_read_batch

```json
{
  "view": "threads",
  "scopes": [
    {"key": "local-round", "environment": "polaris", "projects": {"mode": "ids", "ids": ["project-a", "project-b"]}, "includeNoRun": true, "limit": 20},
    {"key": "remote-round", "environment": "sirius", "projects": {"mode": "all_authorized"}, "state": "needs_intervention", "limit": 20}
  ],
  "timeoutMs": 10000
}
```

Cada scope tem selector explícito `projects: ids | all_authorized`. `all_authorized` só em leitura e respeita a política/grant atual. Environment não é implícito. `view` discrimina os filtros válidos: projects aceita search/limit/cursor; threads aceita state/includeNoRun/search/limit/cursor; attention aceita limit/cursor e seleção de projetos. Não aceitar state no projects nem misturar payloads de views no mesmo lote. Incluir nos resumos os campos públicos de triagem do thread_read.state e admitir filtros explícitos settled/snoozed/pinned em threads/attention, sem defaults que mudem a regra atual. No exemplo de inbox-zero o cliente pode selecionar settled=false e snoozed=false. Se a fonte não suportar um filtro, devolver unsupported ou cobertura desconhecida, nunca tratar campo ausente como false. Totais indicam filtro/população e instante observado; snoozed compara ao relógio declarado da observação.

Output por escopo: identidade, view, observedAt/sourceSequence quando disponível, contagens por estado do universo selecionado, total, returned, hiddenNoRun quando aplicável, coleção tipada e cursor. Uma shell por environment, filtrar scopes sem mutar escopo compartilhado. Se um scope listar projeto inexistente/não autorizado, recusar aquele scope inteiro sem retornar subconjunto como se completo. Falha do host produz error para seus scopes; outros retornam normalmente. Risco/limite global de output explicitado.

Adicionar `visibility: active | archived | all` explícito para threads; default active. A disponibilidade de archived depende da fonte/permissão; campo unsupported não vira vazio. Combinar shells requer política de sequência/cobertura explícita. **V1 suporta active; archived/all só devem ser habilitados depois de validar a fonte de arquivadas**. Para incluir unarchive na v1, implementar e validar **lookup arquivado por ID para autorização/preflight**, usando a fonte nativa autorizada; não basta repassar a ação existente, pois os resolvers atuais procuram shell.threads. Esse lookup não precisa anunciar uma busca/lista exaustiva de arquivadas, mas precisa comprovar projeto e existência do target. Se a fonte/capability não estiver disponível, o item é unsupported/not_started; não inferir projeto pela entrada nem buscar em outro ambiente. Sem esse gate, retirar unarchive da primeira entrega (nove ações de inbox) e manter explicitamente sua inclusão pendente. Não fingir que uma lista active é lista completa de histórico.

A matriz mantém unarchive como A/v1 pretendida, com esse requisito de fonte como gate concreto e sem afirmar suporte real já comprovado.

Contagens nesta tool são dos estados/threads visíveis da observação. Não têm a garantia de occupancy active+archived de `t3_contar_threads_projeto`, não autorizam delete e não devem ser nomeadas emptyProject/totalLiveThreads. Atenção tem a mesma regra atual: needs_intervention ou failed não settled; filtros/organização novos não devem mudar esse significado silenciosamente.

### 3. t3_thread_read_batch

```json
{
  "view": "detail",
  "items": [
    {"key": "a", "environment": "polaris", "threadId": "thread-a"},
    {"key": "b", "environment": "sirius", "threadId": "thread-b"}
  ],
  "maxCharacters": 1500,
  "timeoutMs": 10000
}
```

`state`: resumo canônico e campos de triagem públicos disponíveis: projectId, title, updatedAt, state/stateSource/runId, latestRunId quando distinto, runtimeMode/model, archivedAt/settledAt, snoozedUntil, pinnedAt, autoSettleDisabledAt e lastVisitedAt. Para campos opcionais ausentes em servidor antigo, indicar disponibilidade; não interpretar como off/null. Adicionar observation/expected para preflight sem inventar revision CAS.

`detail`: preservar a projeção atual `t3_thread`, incluindo activeRun, latestRun informacional, pendingRequests com conteúdo/capability/nextAction e history.complete. Campos de triagem entram junto do resumo. `messages`: limites da leitura atual de mensagens (default 6, 800 chars por mensagem), metadata de history e truncamento. View única por chamada, maxCharacters/limit tipados por view; não usar um objeto fields livre que exponha internals. Detail e messages podem reutilizar projeção autorizada de uma thread quando internamente necessário, sem prometer timeline exaustiva.

Output por item: data tipada, observedAt, history/truncation conforme view. Pode haver estado shell e projeção em instantes diferentes; registrar origem e não derivar forte CAS de updatedAt de uma shell anterior. Não escolher run pelo providerSession ou streaming. Repetição de target de leitura pode coalescer I/O apenas após autorização e com mesmas opções/snapshot; cada key recebe resposta própria. Conteúdo de pedidos runtime permanece individual: ler em lote não aprova nem responde em lote.

### 4. t3_thread_inbox_update_batch

```json
{
  "batchId": "round-17-snooze",
  "mode": "apply",
  "action": "snooze",
  "items": [
    {
      "key": "a",
      "environment": "polaris",
      "threadId": "thread-a",
      "operationId": "round-17-a-snooze",
      "expected": {"projectId": "project-a", "updatedAt": "2026-10-05T19:00:00-03:00", "runId": null},
      "snoozedUntil": "2026-10-07T09:00:00-03:00"
    }
  ],
  "timeoutMs": 20000
}
```

Schema discriminado por action; snooze requer snoozedUntil, auto_settle_set requer enabled, demais não aceitam esses campos. `expected.projectId` obrigatório em apply para todas as ações. updatedAt/runId observados são obrigatórios para settle/archive; opcionais nas demais, mas recomendados quando o gesto veio de uma seleção antiga. `runId` identifica o ativo observado, não latest queued. O validador converte somente formatos/instantes explicitamente aceitos, com schema de ISO definido; não renomeia ambiente nem tolera parâmetros legados desconhecidos.

Para **settle/archive**, exigir leitura recente e recusar se houver run ativo, pedido pendente, queued work ou estado de atividade/fila desconhecido. Precisar de ausência comprovada, não ausência de campo numa projeção truncada. Thread completed sem aceite continua fora da seleção. Erro local precondition_changed/active_work/pending_request/queue_not_empty/activity_unknown, sem envio. Arquivo e settle não são aliases; o usuário escolhe um por chamada.

Outras ações podem afetar visibilidade de uma thread ativa, se esse for o gesto explícito: snooze/pin/unpin/mark_unread não interrompem. Expor busy/needs_intervention no preview/output para que o cliente não interprete “sumiu da inbox” como “parou”. Unsettle/unsnooze nunca enviam mensagem nem respondem pergunta. Habilitar auto-settle não garante quando ocorrerá settlement; informar a configuração observada, sem prever o sweep.

**Noop semântico:** settle só é noop se o override já for explicitamente settled; um settledAt automático não é prova do mesmo efeito. Unsettle/unsnooze têm motivo user e podem gravar override de recuperação; campo superficial já vazio não autoriza pular a ação. Auto-settle campo ausente em backend antigo é unsupported/unknown. Para pin/archive/snooze, igualdade de estado/instante pode permitir noop somente após conferir que a action não precisa de side effect adicional no backend alvo. A implementação futura deve provar cada equivalência ou manter dispatch.

Preflight de expected é uma **comparação observada no Connector**, não CAS: os schemas públicos atuais settle/archive/snooze não aceitam expectedUpdatedAt. Uma leitura imediatamente antes do envio ainda permite mudança por outro client nesse intervalo. Retornar `preconditionStrength: observed`, observar o efeito posteriormente e sinalizar mudanças concorrentes sem rollback. Não liberar fechamento automático de threads baseado em shell antigo. Se o produto exigir garantia “nenhuma thread mudou entre aceite e settle”, será preciso CAS/guard atômico no T3; essa variante não cabe na baseline e não deve ser anunciada como pronta. O comando interno thread.auto-settle com snapshotAt não é atalho público permitido.

Preview usa o mesmo seletor/action/input e devolve before/desired/precondition/status previsto e títulos autorizados; operationIds permanecem do cliente para o apply. Apply revalida e cria manifesto durável; não confiar na autorização nem no estado do preview. Uma action exige sempre consent específico atual. Retorno de exemplo, com erro local que não fecha autoridade:

```json
{
  "batchId": "round-18-settle",
  "complete": true,
  "allSucceeded": false,
  "returned": 2,
  "summary": {"applied": 1, "rejected": 1},
  "items": [
    {"key": "a", "operationId": "round-18-a", "status": "applied", "journalState": "completed", "preconditionStrength": "observed", "postCheck": "matched", "receipt": {"sequence": 120}},
    {"key": "b", "operationId": "round-18-b", "status": "rejected", "error": {"code": "pending_request", "message": "The selected thread still needs a response."}}
  ]
}
```

Exemplo não representa saída atual do Connector. Se o primeiro envio ficar incerto e a sessão for revogada, esse envelope não será liberado; a recuperação é por manifesto/recibos após nova autenticação, como definido acima.

### 5. t3_write_reconcile_batch

```json
{
  "items": [
    {"key": "a", "environment": "polaris", "operationId": "round-18-a"},
    {"key": "b", "environment": "sirius", "operationId": "round-18-b"}
  ],
  "timeoutMs": 10000
}
```

Alternativa exclusiva: `{"batchId":"round-18-settle","timeoutMs":10000}`. Não aceitar batchId e items juntos. batchId resolve o manifesto do **mesmo principal/deployment**, nunca do principal da sessão anterior se diferente. Revalidar autorização dos recibos/targets/actions por item e omitir conteúdo não autorizado. Nenhuma consulta provoca retry do comando, resume dos not_started ou renovação de lease/sessão.

Output: keys/operationIds, estado do item no manifesto, estado do journal, recibo confirmado quando armazenado/autorizado e observação remota atual separada (`found`, `sequence`, `threadId`, `state`). O reconcile singular atual retorna state e observation e não necessariamente todo o receipt; o retorno de receipt armazenado é uma ampliação proposta que exige autorização, não comportamento já existente.

Estados preparing/rejected sem target e noop/not_started são lidos do manifesto/journal com prova sent=false quando existir. A variante OAuth atual já permite alguns rejeitados antes do envio sem target; lease ainda exige target conhecido. A v1 deve tratar essa diferença explicitamente e, no profile lease, retornar erro seguro/unsupported até existir lookup autorizado de manifesto: não contornar gate para fingir paridade.

`observation.found=false` não resolve uncertain nem prova inexistência de efeito. `state=completed` no journal prova ACK de dispatch daquela operação; `state=completed` na thread prova outro fato e não substitui o journal. Se não houver capacidade de provar a resolução, continuar reconciliationRequired=true e apresentar inspeção manual/autorizada; não criar nova operação com outro provider como fallback.

## Contratos por família

Estas seções completam **todas as linhas A/B da matriz**, inclusive candidatas adiadas. Cada linha herda o contrato comum e o contrato indicado, junto de suas restrições próprias. Inputs adicionais são propostas de guards, não parâmetros já aceitos pelas tools singulares.

### R — leitura de targets/escopos

Input é lista de targets/escopos qualificados e opções da leitura específica; output preserva dados/totais/truncamento por key. Falha de um target não derruba os outros salvo autenticação/revogação; shared host failure se propaga sem fabricar vazio. Idempotência é ausência de efeitos, não consistência temporal; observedAt/sequence informam a leitura. IDs exatos não são resolvidos por títulos; source/cursor variam por ambiente e filtro. Snapshot local quando disponível, best-effort entre hosts; sem atomicidade global. Campos omitidos por versão são unknown. Budget de conteúdo, ACL por item, cursor não autorizador e ausência de mutações implícitas são os riscos centrais. Aplica-se também a environment/project/configuration/transfers/queue/worktree/scheduler reads, conforme I/O específico da matriz.

### F — múltiplas queries de busca

Um resultado por query, com candidatos/coverage/resolution; não misturar candidatos de queries nem reduzir um único total para todas. Query estruturalmente inválida rejeita admissão; falha de host gera cobertura incompleta nas queries afetadas. Replay faz nova busca e não tem efeito. Títulos, snippets e IDs de ambiente desconhecido nunca viram seleção automática; múltiplas correspondências exigem resolução por quem pediu o alvo. Busca por título atual pode indicar cobertura completa dos hosts que responderam; **busca de conteúdo nativa sempre é bounded/non-exhaustive**, aplica projectId depois do top global, não tem paginação exaustiva e nunca atesta ausência mesmo sem falhas. Consistência local por snapshot de shell para busca de títulos; best-effort por RPC para conteúdo. Limitar fan-out, output e conteúdo sensível.

### O — contagem de ocupação de projetos

Targets environment/projectId; output por key com complete e total/active/archived/withoutRun/busy/sequence. Compartilhar uma dupla active+archived por ambiente e contar todos os projetos sobre essa dupla somente depois de autorização. Máximo de tentativas limitado (atual 3), deadline global; diferenças de snapshotSequence, linhas malformadas ou ausência de fonte devolvem complete=false,total=null, nunca zero. Repetição é nova observação sem efeito; IDs exatos, sem escolha por título. Coerência por dupla de snapshots, não transação entre hosts nem trava de writers. Busy é contagem de ocupação, não aceite. Não converter contagem incompleta ou antiga em autorização de delete; proteger metadata contra escopo negado.

### W — espera de vários runs

Targets environment/threadId/runId e um timeout global, completion any/all explícito; output de todos com ready/waiting/error, estado/motivo, run seguido, observedAt e timedOut. Snapshot inicial escolhe run ativo antes do latest quando runId omitido e congela seleção; recomendar runId explícito em rodadas. Failure local continua nos outros; definir erro como concluído da espera, separado de terminal de run. any retorna quando pelo menos um alvo já estiver pronto/intervenção/erro observado; demais recebem o último estado conhecido, sem fingir terminal. all espera todos prontos/erro até deadline; alvo sem observação tem erro, não unknown com sucesso. Timeout com observação é resultado normal; no_run é pronto, não run completed. `interrupted/rolled_back/cancelled` são terminais com seu significado, não completed.

Usar subscriptions/eventos nativos, multiplexando conexão quando suportado; limite inicial proposto 20 targets/5 s e cleanup completo no deadline/abort. Não Promise.all de waits com timeout em cascata, não polling de LLM, não schedule como espera. Replay acompanha novas observações sem efeitos; mesmo runId permanece alvo, run novo não substitui. Não atomicidade entre conclusões. Cancelar fecha subscriptions próprias, não interrompe run. E2E de cancellation pelo túnel ainda não provado; teto curto limita custo. Notificações/espera longa persistente são decisão de produto separada e ficam fora da v1.

### J — journal/recibos

Targets operationId ou manifesto autorizado; resultados por operação conservam estado conhecido/observação e não repetem dispatch. operation_unknown/lookup negado é erro local; journal indisponível ou sessão revogada é erro global. Idempotente como inspeção, mas observação remota pode mudar; não usar nova sessão como nova identidade de escrita se o subject estável é o mesmo. Ambiente/destination/actor são invariantes, não buscar a operação em todos os hosts até encontrar. Snapshot de journal e observação não são uma transação; registrar suas origens separadas. Retenção, minimização de payload e não revelar receipt de outra pessoa são os principais riscos. Nunca resolver uncertain a partir de coleção vazia ou título parecido.

### I — organização de inbox

Uma das dez ações permitidas, targets exatos com action-specific params e expected; saída com efeito observado/recibo/status por item. Erros locais como thread ausente, changed ou active_work continuam nas demais; incerteza/journal/gate param globalmente. BatchId/operationIds duráveis e skips fixos no replay; somente noops semanticamente provados, sem assumir que “setter é sempre idempotente”. Nenhum target inferido por estado completed, título ou no-run. Best-effort por thread, sem CAS forte na baseline; settle/archive requerem ausência de atividade e aceite explícito, com janela cross-client documentada. Riscos de ocultar trabalho, datas/fusos, overrides de recuperação e suporte de campos opcionais seguem as linhas da matriz. Não incluir delete, dismiss, approve, send, rollback ou varredura interna auto-settle.

### D — metadados, watermarks, vínculos e entregas

Lote **homogêneo por ação**, com campos precisos por item; output traz before/after disponíveis e recibo. `visit`: watermark lido, não relógio atual; máximo monotônico no servidor evita retroceder, mas não autoriza fingir leitura humana. Reorder: conjunto/versão e orderKeys explícitos, aplicação determinística; não computar vizinhos a partir de snapshots divergentes. PR link/unlink: identidade host/repo/number e URL validada; acknowledge de filho: task/parent/observedByRunId real, nunca mera presença na lista. Metadata path/branch precisa de guard/workspace no host de execução, separado de renomeação. Erros locais continuam quando operações independentes; reorder ou grupo dependente para no primeiro conflito, restantes not_started. Journal impede replay de efeito; desired state não substitui guard. Ambiguidade de título/link/source recusa o item. Best-effort sem transação, sem compensar watermarks/links/overrides automaticamente. Riscos: sumir entregas, ordenar indevidamente, perder binding e mudar auto-settle/monitoramento.

### K — configuração de runtime/model/provider/projeto/ambiente

Inputs tipados por recorte, expected configurado + run/contexto observado; output distingue configuração futura, run ativo e provider process. **Modo e modelSelection obrigatórios por item**, sem herdar full-access nem escolher fallback. No project/preferences patch, omissão preserva e null só limpa campos anuláveis definidos. Provider IDs, model slugs e capabilities vêm do ambiente alvo; incompatibilidade gera erro local, sem trocar instância/conta. Idempotência via journal, não pelo título/modelo aparente; read-merge-save sem CAS continua vulnerável a mudança concorrente, requer guard/postCheck e CAS nativo se forem exigidas garantias fortes. Best-effort sobre targets distintos; ambiente inteiro pode ter impacto em projetos fora da seleção e precisa de intenção explícita. Não interromper/reiniciar run como consequência escondida de atualização. Preview/diff é especialmente valioso para aumento de autoridade, paths/scripts/customInstructions; sem blanket aprovação persistente e sem route inferred.

### X — controle de execução/sessão

Targets de run/session com IDs exatos, reason e opção de fila explícita, expected ativo/preparado/detached. Output é ACK/estado observado, não conclusão de todos os efeitos do agente. Estado/run mudado é rejeição local; não converter interrupt em cancel de outra fila nem detach de outra sessão. operationId preservado, uncertain nunca retry automático. IDs de thread/run/session não são intercambiáveis; não descobrir alvo por “mais novo” no momento de enviar. Best-effort, sem restaurar arquivos nem processos ao falhar um item. Em recuperação ampla, parar admissão na primeira inconsistência de contexto/autoridade; permitir só targets independentes restantes em lotes replanejados. Riscos: custo, perda de trabalho, mensagens posteriores iniciando, decisões de arquitetura abandonadas.

### Q — filas e mensagens queued

Targets thread/queuedRun e hash/versão de fila/mensagem; parâmetros específicos da matriz. Output por item inclui delivery order observado, recibo e warnings de mudança. Alvo deixou queued, run ativo trocou, beforeRunId desapareceu ou fila mudou: conflito local, sem fallback para interrupt/send. Reorder/edit/promote na mesma fila exigem plano ordenado e rejeitam conflito do grupo, não parallel best-effort; cancel de filas distintas é best-effort. Journal por comando, sem repetir promote ao se perder ACK; edit mesmo texto não prova mesmo alvo. Ambiguidade de mensagem similar sempre recusa; reconhecer prioridade de delegatedCompletion. Não atomicidade de plano de fila, sem compensação ao falhar no meio. Resume/prepared release podem iniciar trabalho e custos; limpar uma fila não pode remover automaticamente mensagens de conclusão.

### U — respostas a user_input

Input por request com question IDs, answers tipadas e fingerprint de conteúdo/capability observado; output com request/run/recibo e pós-leitura do pedido. Conteúdo ausente, pergunta diferente, request respondido/substituído ou constraint incompatível: erro local, nunca usar texto genérico/send. Nenhum objeto `sharedAnswers` baseado só em question label; mapear respostas explícitas a cada request. Idempotência pelo journal e request específico; incierto não reenvia nem cria nova resposta. Operações independentes podem ser best-effort; respostas que dependem de decisão conjunta ficam singulares. Não batch de approval nem dismiss dentro desta família. Riscos: propagar decisão de negócio/contexto errado, opções com labels iguais mas valores/IDs diferentes e vazamento de perguntas. Aceitação futura deve provar semântica de capability message/structured contra backend e constraints, não apenas mock.

### L — criação de projetos/threads/tarefas/filhos/clones

Items completos com target de projeto/host, workspaceStrategy/path/model/runtime/prompt/sourcePoint/binding conforme a linha; sem defaults compartilhados que mudem conta/checkout/autoridade. Output inclui todos os IDs criados, receipt, eventual commitError/resultUnavailable e efeitos em filesystem conhecidos. Falha local pode continuar em outro item independente; colisão de path/branch, journal ou uncertainty para o grupo/global conforme risco. Idempotência por reserva + recibo, com commandId remoto somente onde suportado; nunca alegar exactly-once em clone/createNew/scheduler sem prova. Não escolher projeto por título ou worktree “similar”; reservar/validar destinations e preservar conteúdo existente. Best-effort, sem apagar criações bem-sucedidas para simular rollback. Launch de top-level e delegated child são diferentes: child mantém binding do pai; texto mandando cd não o muda. Scheduler fixed_time usa fuso do servidor e herda modes; clone não registra projeto. Limitar criação simultânea/custo e conteúdo copiado em forks; retorno truncado não pode omitir ID criado.

### S — envio de instruções

Input por item é union estrita de delivery, texto, clientRequestId=operationId e targetRunId quando steer/restart. Antes de enviar, inspecionar o run/pedido pendente e validar contexto; pergunta bloqueante não se responde por send. start_immediately só deve ser selecionado sem run ativo a preservar; T3 ainda pode enfileirar se um run surgir no intervalo, então output não deve afirmar início imediato sem evidência. queue_after_active exige intenção explícita de trabalho posterior/deferUntilActiveCompletes, nunca correção; steer/restart se alvo mudou gera erro local e replanejamento, sem fallback. Mesmo texto para várias donas é opção explícita da intenção, nunca broadcast automático por resultado de busca.

Journal estável por mensagem e target, sem novo clientRequestId em timeout; replay não reaplica texto. Best-effort entre threads, sequencial por mesma thread; não atomicidade de steering nem garantia de entrega imediata por todos os providers. Reinício interrompe trabalho mas não desfaz efeitos. Riscos: spam, gasto de assinatura, PHI/secrets/contexto errado, enfileirar correção tarde e instrução maliciosa vinda de retornos; não tratar conteúdo de leitura como nova autorização. Limite menor futuro (proposta 10 envios), preview com destinatários/delivery/texto revisável e result de dispatch separado do run final. Não incluir no executor de inbox da v1.

### P — apagar apenas projetos vazios

Input inclui projectId, confirmação de vazio observada e sequence; output inclui receipt e **postCheck clean/incomplete/unavailable/live_threads_remain**. Contagem fresca incoerente ou não zero: rejeição local, sem força nem fallback. Idempotência via journal; projeto já ausente não comprova que aquela operação o apagou. Identidade qualificada exata, nenhuma seleção por título/idade. Best-effort por projeto, serialização de launch/fork/delete do próprio Connector; não há trava sobre outros clients. Corrida cross-client da baseline pode deixar thread ligada a projeto deletado mesmo com count/guard/postCheck; não anunciar limpeza atômica. Risco é destruição de entidade e orfandade; manter fora da v1 até decisão sobre essa limitação e evidência nativa. `delete-force` continua C.

### T — scheduler update/delete/runNow

Targets environment/project/taskId, patch ou comando específico, versão/configuração esperada. Output preserva identidade, enabled/schedule/boundThreadId/nextRunAt e recibo/runCount quando apropriado. Task fora do projeto, binding inválido, versão mudada ou capability ausente: erro local; não tentar outra tarefa com título parecido. Idempotência via journal: enabled desired state pode ser noop verificado; delete/runNow não são reexecutados no retry. update é read-merge-save sem CAS; não esconder risco de lost update. Best-effort entre tarefas; pausá-las não interrompe automaticamente runs existentes. fixed_time segue timezone do host, interval segue a definição nativa; não copiar o mesmo relógio entre fusos sem conversão explícita. prompt/binding/worktree/model devem ser revisados por item; runNow inicia custo e não prova conclusão; delete exige snapshot preservado se for necessária recriação, sem rollback automático.

## Depois da v1

| Onda | Entradas principais | Condição para entrar |
|---|---|---|
| v1.1 — visibilidade | count de projetos (O), providers/configuration/environment/project/worktree status, queue/list scheduled (R), conteúdo search (F) | Orçamento, snapshots active+archived coerentes e semântica non-exhaustive testados; grants opcionais preservados |
| v1.1 — conclusão de rodadas | wait (W), visit/PR link/wake-policy/acknowledge (D) | Wait event-driven e cancellation/cleanup; watermark e prova de aceite/origem da entrega |
| v2 — política explícita | runtime/model (K), enabled/schedule de tarefas (T), cancel queued (Q) | Previews/guards, capabilities por ambiente, rota/conta exatas e política de concorrência comprovadas |
| v2 — comunicação/execução | send (S), answer (U), interrupt/release/resume/detach (X/Q) | Estado/capability/run IDs frescos, sem fallback, dispatch vs completion claros e ensaio real autorizado |
| Posterior, sob demanda | launch/fork/create/clone/schedule/delegate (L), reorder/metadata/unlink (D/Q), project/update/preferences (K), delete empty (P), scheduler delete/runNow (T) | Casos medidos, conflitos/path/custo, manutenção de journal e limites específicos; para deletes, resolver/aceitar corrida nativa |
| Sem batch de produto | approval lease, runtime approval/dismiss, thread delete, project force delete, rollback, merge_back, completion dispose, environment list | Conservar ações individuais ou agregado já existente |

Não transformar a próxima onda em vinte tools de uma vez. Começar com subrecortes homogêneos de ganho real: por exemplo runtime_mode_set_batch, queued_run_cancel_batch e scheduled_task_set_enabled_batch podem ser mais claros que “patch all configuration”. Compartilhar **biblioteca interna** de limiter, envelope, manifest/reconcile, autorização e erros; não expor essa biblioteca como tool genérica. Read-only e write devem ter schemas e annotations distintos; uma tool execute_batch com mistura de leitura/escrita destrói a escolha de scope baseada em readOnlyHint na facade atual.

Não reutilizar JSON-RPC batch do transporte como design de produto. Ele já aceita várias mensagens, mas não oferece manifesto, ID estável de lote, erro semântico por alvo, resolução de ambiguidade, orçamento coordenado nem uma intenção revisável; clients também não necessariamente o expõem ao modelo. A família tipada melhora esses contratos. Internamente ela pode reusar os serviços existentes e não precisa simular calls MCP entre handlers.

## Gates para uma implementação futura

1. **Cobertura:** tools/list nos perfis readonly/lease/OAuth restricted/all/admin/native, sem aumento de grant por oferecer batch; inventário continua explícito e flags antigos não ganham actions novas.
2. **Ambiguidade:** IDs iguais em dois ambientes, títulos duplicados, uma página com total>1, único candidato com host indisponível, cursor com cobertura/ACL alterada; nenhuma mutação decorrente dessas buscas sem seleção explícita.
3. **Isolamento:** dois principals e dois itens simultâneos com snapshots live/deleted/empty distintos, evitando regressão do escopo privado por invocation; nenhuma authority/grant mutável compartilhada.
4. **Partial/result:** misturar sucesso, scope denied, thread ausente, precondition changed, budget e timeout; preservar ordem/keys/totais/unknown; 0 não substitui fonte indisponível.
5. **Journal/crash:** batchId conflitante, keys/targets repetidos, operationId reutilizado com outro input, crash antes/depois de cada reserva/ACK/receipt, replay após reinício/nova autenticação e concorrência do mesmo batch. **Contar envios** e provar nenhum segundo envio uncertain/completed; preparing antigo não é auto-resume.
6. **Revogação:** kill/revoke/idle durante leitura, preview, preflight, invoke e release do resultado; reproduzir withholding da facade e recuperação autenticada de manifesto, sem próximos envios após perda de autoridade.
7. **Semântica de inbox:** snooze/unsnooze e unsettle overrides, auto-settle.set não sweep, noops provados, active vs latest, perguntas/fila/busy/versão desconhecida; settle/archive apenas após aceite e guard observado, sem alegar CAS.
8. **Cancel/deadline:** envelope admitido mas chamada abortada, RPC em voo, orçamento global, timeout de host e cleanup; nenhum cancel de run como efeito da cancel da tool.
9. **Ensaio real:** somente sandbox/threads/projetos próprios previamente autorizados, com backend/providers e profile de autenticação declarados; comparar dispatch/receipt/pós-estado. Esta investigação não fez esse ensaio nem alterou produção.

Aceite da v1: os cinco contratos implementados sem ampliar autoridade, sem efeitos repetidos por recuperação, com todas as linhas/códigos e limites documentados, e efeito observado de inbox confirmado no sandbox autorizado. Benchmarks devem medir round trips MCP, shell/projection/RPC calls, bytes e latência em duas máquinas com falhas; reduzir round trips não autoriza eliminar guards. Até isso ocorrer, esta entrega é proposta revisável, não API pronta.
