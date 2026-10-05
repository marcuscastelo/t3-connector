# Tools públicas do T3 Connector: investigação de batch

Data: 05/10/2026, Brasília. Baseline: **0.11.2**, commit **34cc095bf9ed2b5452b87729da51e6d878404af3**. `git ls-remote origin refs/heads/main` retornou esse mesmo SHA durante a investigação. A proposta 0.12 de renomeação não foi aplicada a esta matriz. Investigação/design apenas; nenhum handler, schema de produção ou comportamento foi implementado. Trabalho executado na sessão Codex Galm (`codex_galm`, GPT-6.1-Sol high).

## Resultado e critério

**74 nomes únicos de produção**, cobrindo a união dos perfis disponíveis no código, mais **4 tools públicas exclusivamente sintéticas de rehearsal**, classificadas no final. Uma instalação não anuncia necessariamente as 74: flags, grants, scopes e transporte mudam o catálogo.

- **A — forte candidata:** uma ação/consulta tipada sobre um conjunto explícito reduz trabalho repetitivo frequente de control-plane/inbox-zero, sem perder a identidade de cada alvo. Ser A não implica entrar na v1.
- **B — útil em casos específicos:** ganha em rodadas/migrações/recuperações explícitas, mas precisa de contexto, precondições, revisão de payload ou controle de execução próprios.
- **C — não deve ter batch de produto:** já agrega os alvos, tem gesto de autorização individual ou efeitos cujo agrupamento dilui clareza/segurança. Um script de manutenção excepcional não justifica uma tool pública de lote.

A recomendação é começar com **cinco tools tipadas**, descritas em [API batch v1](batch-api-v1.md): find, inbox read, thread read, inbox update e write reconcile. Compartilhar o envelope de resultados, identidade e journal; não oferecer um executor arbitrário de tools/actions.

## Como o inventário foi conferido

Foram enumerados todos os pontos de registro em `src/` e no kit; depois os três catálogos de produção foram instanciados e consultados via **SDK MCP tools/list e InMemoryTransport**, com autoridade e registros fictícios. Não se executou `tools/call`, não houve acesso ao backend nem uso de credenciais. `npm ci --ignore-scripts --no-audit --no-fund` preparou as dependências locais. O [inventário JSON](batch-tools-inventory.json) registra nomes, ações, grupos, perfis, campos obrigatórios e classificação; uma comparação exata verifica que cada nome de produção aparece uma vez na matriz.

| Perfil | tools/list | Observação |
|---|---:|---|
| Leitura stdio | 9 | O catálogo base de leitura |
| Escrita por lease | 49 | 42 ações, 5 leituras guardadas que repetem nomes base, approval e reconcile |
| Escrita OAuth, all, admin/native habilitados e consentidos | 64 | 42 ações, 2 deletes de projeto, 18 wrappers nativos, count e reconcile |
| OAuth completo, somando as 9 leituras | 73 | Approval por lease não pertence ao OAuth |
| União de produção | 74 | Nomes repetidos de leituras/reconcile contados uma vez |

Partição da união: **12 leituras/utilidades + 42 ações base + 2 ações admin de projeto + 18 wrappers nativos**. `projectAdmin` e `nativeTools` são opt-in OAuth/all e dependem dos grants. Leituras com o mesmo nome no plugin de escrita exigem `leaseId`; OAuth usa principal verificado no servidor e não aceita lease como sessão. As famílias batch futuras devem manter essa distinção.

## Fontes e limites da evidência

- **S1 — leituras:** [servidor.mjs](../../src/servidor.mjs), registros em linhas 106–425; busca em [busca-threads.mjs](../../src/busca-threads.mjs), paginação em [paginacao.mjs](../../src/paginacao.mjs).
- **S2 — ações, schemas e journal:** [adapters.mjs](../../src/escrita/adapters.mjs), ações em linhas 15–92 e Dispatcher a partir de 108; [journal.mjs](../../src/escrita/journal.mjs).
- **S3 — perfis/autoridade:** [ponte-mcp.mjs](../../src/escrita/ponte-mcp.mjs), [session-writes.mjs](../../src/oauth/session-writes.mjs) e [t3-tools.mjs](../../src/oauth/t3-tools.mjs).
- **S4 — admin/count:** [project-admin.mjs](../../src/escrita/project-admin.mjs); aponta a corrida entre criação de threads por outros clients e delete de projeto, além de guards/count/postCheck.
- **S5 — wrappers:** [native.mjs](../../src/escrita/native.mjs), writes em 65–164 e reads em 176–257; as listas exportadas são a fonte da cobertura.
- **S6 — espera:** [espera.mjs](../../src/espera.mjs) e [ADR 0002](../adr/0002-waiting.md). O código atual segue o run ativo antes do latest; o trecho antigo do ADR que fala só em latest não prevalece sobre a correção 0.11.2.
- **S7 — isolamento OAuth:** [project-policy.mjs](../../src/oauth/project-policy.mjs), [resource-server.mjs](../../packages/mcp-connector-kit/oauth/resource-server.mjs), [oauth-all-projects.test.mjs](../../test/oauth-all-projects.test.mjs).
- **S8 — contrato nativo de referência:** [orchestrationV2.ts](../../reference/packages_contracts_src_orchestrationV2.ts), campos de shell em 1710–1750 e comandos em 2440–2538. É snapshot vendorizado, não prova da versão do backend instalado.
- **S9 — sintéticas:** [rehearsal-tools.mjs](../../src/oauth/rehearsal-tools.mjs).

**Atrito adicional conferido na fonte:** a descrição atual de buscar_threads promete arquivadas, mas `criarCliente.shell` lê apenas `/api/orchestration/shell` e a busca percorre somente `shell.threads`. O próprio adapter de occupancy documenta essa fonte como active e consulta `getArchivedShellSnapshot` em separado. Os testes de busca inserem uma thread arquivada diretamente na shell fictícia; não comprovam a cobertura real de arquivadas. As resoluções de alvo e o preflight de escrita também dependem dessa shell. A API batch deve declarar a população consultada e validar um lookup autorizado de arquivadas antes de prometer descoberta/unarchive completos; não se confirmou o backend instalado nesta tarefa.

Os casos de uso abaixo derivam do fluxo de donas, aceite, rodadas, filas e inbox-zero descrito nos contratos do produto e nesta solicitação; não são estatísticas de frequência nem experiências de usuário medidas. O catálogo foi conferido na fonte pública atual; não se afirma que produção instalada tenha os mesmos flags, versão ou capabilities. Vários adapters se identificam como mock-only: sucesso de desenho/teste não comprova efeito real contra todos os providers.

## Como ler os contratos da matriz

Cada candidata A/B tem caso concreto, input/output e risco próprio na sua linha. A coluna **Contrato** aponta uma seção da [proposta de API](batch-api-v1.md#contratos-por-família) que define, para aquela linha, **erros parciais, idempotência, ambiguidade e atomicidade/best-effort**, além das regras comuns. As observações específicas da linha são restrições adicionais ao contrato da família. C não recebe um contrato de lote.

Não há atomicidade distribuída entre ambientes/projetos. O que pode ser atômico na v1 é a admissão do manifesto local, nunca todos os efeitos T3. Nenhuma candidata pressupõe fallback de ambiente, provider, queue ou força. Busca e seleção de alvos ficam separadas de mutação.

Classificação de produção: **35 A, 30 B e 9 C**.

## Leituras e utilidades — S1/S3/S4/S6 (12)

| Tool atual | Classe / fase | Contrato | Caso concreto | Input → output recomendado | Risco / restrição específica |
|---|---|---|---|---|---|
| `t3_ambientes` | **C** / — | — | Já lista e verifica todos os ambientes em uma chamada. | Manter `check`; saída atual já é coleção. | Batch de um agregador sem alvos adicionais só duplicaria chamadas. |
| `t3_projetos` | **A** / v1 | R | Visão dos projetos autorizados de Polaris e Sirius, com contagens para triagem. | `scopes[{key,environment,projects}]`, busca/página por escopo → projetos e totais por escopo. | Contagens de estado na shell não substituem ocupação ativa+arquivada. |
| `t3_threads` | **A** / v1 | R | Revisar threads de vários projetos/ambientes sem repetir a consulta da shell. | Escopos, filtros de estado/título/includeNoRun e cursor local → páginas e totais por escopo. | Não achatar identidades; paginação pode mudar durante a triagem. |
| `t3_buscar_threads` | **A** / v1 | F | Resolver uma lista de referências de donas, PRs ou frentes em todos os ambientes. | `queries[{key,search ou threadId,match,cursor?}]`, ambientes explícitos → candidatos, cobertura e resolução por query. | Um resultado com ambiente indisponível continua inconclusivo; títulos não são IDs. |
| `t3_atencao` | **A** / v1 | R | Inbox único dos projetos selecionados nas duas máquinas. | `scopes`, view attention → razões, threads e total por escopo. | Não settle automático de failed/needs_intervention; lista exige limite novo para não estourar saída. |
| `t3_thread` | **A** / v1 | R | Conferir estado, run ativo, resposta e pedidos de várias donas antes de aceitar entrega. | `items[{key,environment,threadId}]`, view detail e orçamento → detalhes independentes. | Preservar precedência canônica de estado; providerSession não decide run/modelo. |
| `t3_mensagens` | **A** / v1 | R | Ler os últimos retornos e instruções de várias donas numa rodada de aceite. | Mesmos targets, view messages, limites por thread → messages e history por item. | Não marcar como lido/settled por ter recebido texto; limitar payload global e conteúdo sensível. |
| `t3_providers` | **A** / depois | R | Auditar disponibilidade e roteamento em múltiplos ambientes antes de mudar modelos. | `items[{key,environment,instanceId?,includeModels?}]` → catálogo por item/ambiente. | IDs/options pertencem ao ambiente; includeModels só em instâncias explícitas e com orçamento. |
| `t3_aguardar_thread` | **A** / depois | W | Aguardar um conjunto de donas sem N waits sequenciais ou loop de LLM. | Targets qualificados com runId, timeout global e completion any/all → observações e motivos por item. | Fixar run ativo inicial; atingir timeout não é falha; subscriptions custam recursos. |
| `t3_pedir_aprovacao` | **C** / — | — | Uma aprovação já inclui os ambientes disponíveis e nunca renova lease. | Manter chamada singular e gesto humano. | Batch diluiria o escopo consentido ou multiplicaria prompts de passkey. |
| `t3_reconciliar_escrita` | **A** / v1 | J | Após transporte incerto, auditar os recibos de várias mutações sem repetir efeitos. | `items[{key,environment,operationId}]` → estado do journal e observação por item. | Ausência de observação não prova ausência do efeito; reconciliação atual não resolve automaticamente uncertain. |
| `t3_contar_threads_projeto` | **A** / depois | O | Localizar projetos vazios e medir dívida de threads antes de limpeza. | `items[{key,environment,projectId}]` → total/active/archived/busy/withoutRun/sequence/complete. | Uma dupla de snapshots coerente por ambiente; complete=false mantém total=null. |

## Ações base e administração de projetos — S2/S3/S4/S8 (44)

| Tool atual | Classe / fase | Contrato | Caso concreto | Input → output recomendado | Risco / restrição específica |
|---|---|---|---|---|---|
| `t3_escrever_thread_archive` | **A** / v1 | I | Guardar várias threads já aceitas fora da lista ativa. | Targets + expected → recibo e estado de arquivo observado. | Arquivar esconde contexto: verificar aceite, pedidos, run e fila; não equivale a apagar arquivos. |
| `t3_escrever_thread_unarchive` | **A** / v1 | I | Trazer de volta threads de uma iniciativa retomada. | Targets + expected → recibo e archivedAt observado. | A leitura de inbox precisa permitir arquivadas explicitamente; não iniciar run ao reabrir. |
| `t3_escrever_thread_delete` | **C** / — | — | Apaga histórico/entidade; faxina de inbox pode usar settle/archive. | Manter ação individual. | Amplifica perda irreversível de contexto; não confundir com settle nem limpeza de worktree. |
| `t3_escrever_thread_settle` | **A** / v1 | I | Encerrar donas/testes curtos após aceite e transferir os próximos passos. | Targets + expected de revisão → settled observado e recibo. | Completed não é aceite; bloquear atividade/pedidos/fila; contrato público não tem CAS de estado. |
| `t3_escrever_thread_unsettle` | **A** / v1 | I | Reabrir a pilha de threads de uma frente sem relançar agentes. | Targets + expected → settledOverride/settledAt observados. | Override explícito afeta auto-settle; não tratar como simples inversão sem contexto. |
| `t3_escrever_thread_snooze` | **A** / v1 | I | Adiar threads que esperam a mesma janela, acesso ou resposta externa. | Targets com snoozedUntil absoluto por item → timestamp efetivo e recibo. | Snooze só visibilidade: não interrompe trabalho; mostrar fuso e prazo vencido. |
| `t3_escrever_thread_unsnooze` | **A** / v1 | I | Trazer de volta vários itens quando um bloqueio externo acaba. | Targets + expected → snoozedUntil observado e recibo. | O motivo nativo é user; threads podem ressurgir em conjunto e sobrecarregar inbox. |
| `t3_escrever_thread_auto_settle_set` | **A** / v1 | I | Desligar auto-settle nas donas duradouras, ligar em threads descartáveis aceitas. | Targets com enabled boolean explícito → autoSettleDisabledAt e recibo. | É configuração, não execução de thread.auto-settle; nunca aplicar regra interna por conta própria. |
| `t3_escrever_thread_pin` | **A** / v1 | I | Destacar as donas críticas de uma rodada em vários projetos. | Targets + expected → pinnedAt e recibo. | Pin não altera prioridade de execução; ordem relativa fica fora da v1. |
| `t3_escrever_thread_unpin` | **A** / v1 | I | Remover pins antigos após concluir uma rodada. | Targets + expected → pinnedAt e recibo. | Não supor que ausência de pin significa conclusão ou aceite. |
| `t3_escrever_thread_mark_unread` | **A** / v1 | I | Deixar retornos que precisam de revisão visíveis para Marcus. | Targets + expected → lastVisitedAt/unread conforme suporte e recibo. | Não afirmar que recebeu/abriu/avaliou conteúdo; ausência de campo nativo é unknown. |
| `t3_escrever_thread_pin_reorder` | **B** / depois | D | Reorganizar um conjunto conhecido de pins após mudar a prioridade. | Lista de targets/orderKeys e versão do conjunto → recibos por posição. | Chaves fracionárias e vizinhos compartilhados; aplicar em ordem determinística, resultado parcial pode não ser a ordem pedida. |
| `t3_escrever_thread_active_reorder` | **B** / depois | D | Ordenar manualmente o conjunto de donas ativas no control-plane. | Targets/orderKeys + versão do conjunto → ordem observada e recibos. | Não é prioridade do scheduler; alterações concorrentes precisam replanejamento, não rollback automático. |
| `t3_escrever_thread_visit` | **A** / depois | D | Marcar como vistos vários retornos que Marcus efetivamente revisou. | Targets com visitedAt igual ao watermark lido por item → watermark observado. | Servidor usa máximo; usar now esconderia atividade nova não vista. Leitura por agente não comprova leitura humana. |
| `t3_escrever_thread_title` | **B** / depois | D | Padronizar nomes de uma rodada, preservando mapeamento por ID. | Targets com title explícito → título e recibo. | Nomes podem colidir e não roteiam efeitos; título antigo não serve como precondição única. |
| `t3_escrever_thread_runtime_mode_set` | **A** / depois | K | Aplicar uma política explícita às threads selecionadas após auditar permissões. | Targets com runtimeMode e configuração/run esperado → modo configurado, ativo separado e recibo. | Exigir modo por item; proibir default full-access no batch; mudança pode aumentar autoridade. |
| `t3_escrever_thread_interaction_mode_set` | **B** / depois | K | Preparar threads selecionadas para planejamento ou execução por decisão humana. | Targets com interactionMode e configuração esperada → configuração e recibo. | Não inferir que plan/default impede efeitos existentes; modos têm significado do provider. |
| `t3_escrever_thread_model_selection_set` | **A** / depois | K | Migrar donas escolhidas para modelo/effort/conta após política de roteamento explícita. | Targets com modelSelection exata do catálogo de cada ambiente → configurado, ativo e recibo. | Não substituir conta/modelo indisponível; modelo do run ativo é fixado na criação. |
| `t3_escrever_provider_switch` | **B** / depois | K | Migrar providers de um conjunto revisado de threads, com handoff planejado. | Targets com modelSelection, provider/config anterior e run observado → seleção/recibo. | Pode envolver processos e continuidade de sessão; migração não é só mudança de campo. |
| `t3_escrever_provider_session_detach` | **B** / depois | X | Recuperar um conjunto confirmado de sessões órfãs após diagnóstico. | Targets com providerSessionId, reason e estado esperado → recibo por sessão. | Nunca detached geral por título; pode cortar continuidade ou processo em uso. |
| `t3_escrever_run_interrupt` | **B** / depois | X | Parar uma rodada equivocada ou excessiva explicitamente identificada. | Targets com runId, reason e holdQueue explícito → estado do run/recibo. | Não desfaz arquivos/efeitos; fila pode prosseguir se holdQueue não for escolhido conscientemente. |
| `t3_escrever_prepared_run_release` | **B** / depois | X | Liberar uma rodada preparada depois de um gate comum satisfeito. | Targets com runId e preparação esperada → liberação/recibo. | A liberação inicia trabalho/custo; sucesso de dispatch não prova execução concluída. |
| `t3_escrever_queue_resume` | **B** / depois | Q | Retomar filas deliberadamente pausadas de várias donas após janela/gate. | Targets com fingerprint/versão de fila esperada → fila observada e recibo. | Pode iniciar mensagens não revisadas; não é unsnooze nem desbloqueio de user_input. |
| `t3_escrever_queued_run_cancel` | **A** / depois | Q | Remover duplicatas/follow-ups obsoletos de várias filas com IDs conhecidos. | Targets com runId e mensagem/estado expected → recibos e itens restantes. | Só queued; se promovido ou já iniciado, recusar, não transformar em interrupt. |
| `t3_escrever_queued_run_reorder` | **B** / depois | Q | Reordenar a entrega de uma fila ou conjunto de filas confirmado. | Targets com runId,beforeRunId e versão da fila → ordem observada/recibos. | Operações na mesma fila não comutam; aceitar plano de ordem, não parallel arbitrary. |
| `t3_escrever_queued_run_edit` | **B** / depois | Q | Corrigir prompts já enfileirados de uma rodada ainda não iniciada. | Targets com runId,text e hash da mensagem anterior → recibo/novo hash. | Se já entregue, recusar; logs não guardam prompts; overwrite perdido exige guard. |
| `t3_escrever_queued_message_promote_to_steer` | **B** / depois | Q | Aplicar correções enfileiradas ao run ativo certo em várias donas. | Targets com queuedRunId,targetRunId e estado esperado → recibo por promoção. | Não promover completion automática ou mensagem errada; revalidar ambos os runs, sem fallback. |
| `t3_escrever_runtime_request_approve` | **C** / — | — | Decisão de autoridade por comando, recurso ou duração. | Manter requestId/decision singular com conteúdo revisado. | acceptForSession/acceptAlways podem ampliar permissão; agrupar não preserva intenção informada. |
| `t3_escrever_runtime_request_answer` | **B** / depois | U | Responder a um mesmo levantamento replicado em donas, com respostas explicitamente mapeadas. | Targets com requestId e answers por question ID, hash do conteúdo/capability → estado/recibo. | Perguntas parecidas não são iguais; nenhuma resposta compartilhada inferida, nenhuma aprovação embutida. |
| `t3_escrever_thread_user_input_dismiss` | **C** / — | — | Descartar uma pergunta altera intervenção sem a responder. | Manter requestId individual. | Limpar várias perguntas para inbox-zero pode ocultar decisões ainda necessárias. |
| `t3_escrever_checkpoint_rollback` | **C** / — | — | Rollback pode restaurar arquivos e invalidar trabalho posterior. | Manter scopeId/checkpointId/restoreFiles por ação. | Sem transação de filesystem entre threads/worktrees; impacto e conflitos exigem inspeção própria. |
| `t3_escrever_thread_launch` | **B** / depois | L | Abrir uma dona por issue/projeto com checkout e rota próprios. | Items com projeto/title/model/workspace/runtime/text completos → threadId/run/recibo por item. | Colisão de branches/paths, autoridade e custo; não presumir suporte às opções da launch nativa. |
| `t3_escrever_thread_send` | **B** / depois | S | Propagar instrução explícita a várias donas, como mudança comum de aceite. | Targets com texto, delivery obrigatório, targetRunId quando necessário, clientRequestId=operationId → recibo e delivery observado se disponível. | Sem broadcast cego; start_immediately pode enfileirar; pendingRequests usam answer/approve, não send. |
| `t3_escrever_thread_metadata_update` | **B** / depois | D | Atualizar metadados conhecidos de uma rodada; renomear é o recorte mais seguro. | Targets com patch tipado e valores anteriores → metadados/recibo. | worktreePath/branch mudam binding; separar título de rebinding; não agrupar regenerateTitle com caminhos. |
| `t3_escrever_thread_pull_request_link` | **A** / depois | D | Registrar cada PR de uma pilha na thread dona correspondente. | Targets com host/repository/number/url/source e vínculo esperado → links/recibos. | Vínculo afeta UX e pode participar de auto-settle; validar URL/identidade de PR, não cruzar donos. |
| `t3_escrever_thread_pull_request_unlink` | **B** / depois | D | Retirar vínculos obsoletos depois de reatribuir uma pilha. | Targets com identidade exata do PR e vínculo esperado → links restantes/recibos. | Pode quebrar monitoramento e rastreabilidade; não tratar todos os links como equivalentes. |
| `t3_escrever_thread_fork` | **B** / depois | L | Criar variantes/revisões de contextos explicitamente selecionados. | Items com sourceThreadId e sourcePoint preciso → thread criada/recibo. | latest_stable não é snapshot fixo entre itens; preferir run/checkpoint, controlar cópia de contexto. |
| `t3_escrever_thread_merge_back` | **C** / — | — | Consolidar contextos pai/filho depende de conflitos e direção do merge. | Manter source,target,sourcePoint individual. | Fan-in concorrente pode perder/duplicar contexto; não há merge atômico de todos os itens. |
| `t3_escrever_delegated_task_request` | **B** / depois | L | Criar vários blocos independentes dentro de um mesmo dono com parentRun/Node verificados. | Items com parent IDs,task,modelSelection,runtimeMode → task/thread/recibo. | Não cria donas em projetos/worktrees arbitrários; preservar binding herdado e custo por filho. |
| `t3_escrever_delegated_task_wake_policy` | **A** / depois | D | Reduzir despertares ruidosos de vários filhos conhecidos na rodada. | Targets parentThreadId/taskId/completionWake → política/recibo. | settled_only depende de aceite; não usar para esconder falhas/intervenções. |
| `t3_escrever_delegated_task_completion_delivery_acknowledge` | **A** / depois | D | Confirmar várias entregas já observadas e integradas pelo dono. | Targets parentThreadId/taskId/observedByRunId explícito → acknowledgement/recibo. | Receber lista não comprova integração; preservar origem e run que observou cada entrega. |
| `t3_escrever_delegated_task_completion_delivery_dispose` | **C** / — | — | Descartar notificação/entrega de filho sem acknowledgement. | Manter ação individual. | Batch favorece apagar entregas ainda não lidas e rompe rastreabilidade de aceite. |
| `t3_escrever_project_delete` | **B** / depois | P | Limpar vários projetos temporários comprovadamente vazios. | Targets projectId + expected count=0/sequence → recibo e postCheck por projeto. | Só vazio; active+archived coerentes; backend tem janela cross-client e pode deixar threads órfãs. |
| `t3_escrever_project_delete_force` | **C** / — | — | Exclui projeto e todas as threads após confirmação específica. | Manter force/confirmProjectId/expectedThreadCount por projeto. | Não normalizar apagamento em massa; guard de contagem não elimina corrida cross-client. |

## Wrappers nativos opcionais — S3/S5 (18)

| Tool atual | Classe / fase | Contrato | Caso concreto | Input → output recomendado | Risco / restrição específica |
|---|---|---|---|---|---|
| `t3_environment_read` | **A** / depois | R | Auditar preferências e versão das duas máquinas. | `items[{key,environment}]` → identidade/preferences por ambiente. | Instruções customizadas têm conteúdo sensível e limite de 4000; leitura não sincroniza configuração. |
| `t3_project_read` | **A** / depois | R | Inspecionar configuração completa dos projetos de uma iniciativa. | `items[{key,environment,projectId}]` → Project por item. | Paths/scripts pertencem ao host; controlar tamanho e escopo antes de expor. |
| `t3_thread_configuration` | **A** / depois | R | Auditar modelo, runtime e interaction de donas antes de política em lote. | Targets → modelSelection/runtimeMode/interactionMode por item. | Evitar confundir configuração com modelo do run ativo; respeitar flag/consent nativo. |
| `t3_thread_transfers` | **B** / depois | R | Verificar handoffs de um conjunto de forks quando investigar perda de contexto. | Targets → transfers por thread. | IDs de origem/destino não autorizam ler os pares; não expandir grafo automaticamente. |
| `t3_queue_list` | **A** / depois | R | Auditar backlog/duplicatas de mensagens em várias donas. | Targets com cursor/limit por fila → itens em ordem e cursor local. | Completion automática tem prioridade; não supor FIFO pelo ordinal; listas podem mudar. |
| `t3_queue_read` | **B** / depois | R | Inspecionar mensagens específicas antes de cancel/edit/promote em lote. | Targets threadId/queuedRunId → texto/truncated por mensagem. | Orçamento para textos de até 16000 caracteres; mensagem pode deixar de ser queued. |
| `t3_thread_search` | **A** / depois | F | Executar várias pesquisas de conteúdo sobre uma rodada em múltiplos ambientes. | Queries com query/projectId/limit por item → matches, bounded=true, exhaustive=false. | Busca nativa aplica projectId após top global; não confundir falta de match com inexistência. |
| `t3_worktree_status` | **A** / depois | R | Auditar isolation/binding de uma dona por issue em toda a rodada. | Targets → attached/path/branch/root/defaultStartFromOrigin por item. | Não prova limpeza de Git nem autoriza git clean/cópia/delete de checkout. |
| `t3_worktree_list` | **B** / depois | R | Preparar várias launchs e conferir refs em checkouts de projetos distintos. | Targets com query/refKind/limit/cursor → refs e cursor por checkout. | Deduplicar por checkout só após autorização; mesma threadId em hosts diferentes não é mesmo cwd. |
| `list_scheduled_tasks` | **A** / depois | R | Auditar automações que vão reabrir inbox em vários projetos. | Targets environment/projectId → tasks por projeto. | Prompts podem ser grandes; retornar resumo com truncamento explícito; não assumir falta de tarefa em falha. |
| `t3_project_create` | **B** / depois | L | Registrar projetos de uma migração/onboarding em vários ambientes. | Items title/workspaceRoot/defaultModel/scripts → Project/commitError/recibo por item. | Title-only pode criar Git/README/commit; commandId não é aceito por todos os caminhos nativos. |
| `t3_project_clone` | **B** / depois | L | Preparar checkouts independentes numa máquina ou várias. | Items URL/provider/protocol/destinationPath → checkout/recibo por item. | Clonar não registra projeto; não sobrescrever destinos; disco/rede/credenciais e rollback limitado. |
| `t3_project_update` | **B** / depois | K | Aplicar defaults de modelo/autopull/modo de checkout a projetos escolhidos. | Targets com patch e configuração anterior → Project/recibo. | scripts/paths/defaults não devem compartilhar broadcast; omissão preserva, null apaga; CAS não comprovado. |
| `t3_environment_preferences_update` | **B** / depois | K | Alinhar preferências escolhidas de Polaris/Sirius quando Marcus pedir. | Targets ambiente + patch e valores anteriores → preferences/recibo. | Escopo inteiro do ambiente; fusos e capacidades podem divergir; não sobrescrever instruções sem preview. |
| `schedule_task` | **B** / depois | L | Criar uma mesma rotina em projetos diferentes com binding explícito por item. | Items threadId,prompt,schedule objeto,bindToCurrentThread → taskId/nextRunAt/recibo. | Herda modos/modelo; fixed_time usa relógio local do servidor; false cria worktree de main por execução. |
| `update_scheduled_task` | **A** / depois | T | Pausar/retomar rotinas selecionadas ou reagendar uma janela comum. | Items environment/projectId/taskId + patch/versão → tarefa efetiva/recibo. | enabled é estado desejado; update faz read-merge-save sem CAS, pode sobrescrever edição concorrente. |
| `delete_scheduled_task` | **B** / depois | T | Remover rotinas temporárias já aceitas, após salvar sua configuração. | Targets projectId/taskId e snapshot esperado → deleted/recibo. | Irreversível sem recriar; não excluir por título; execução em curso é questão separada. |
| `run_scheduled_task_now` | **B** / depois | T | Rodar conjunto aprovado de verificações programadas após gate comum. | Targets projectId/taskId + operationId por item → thread/runCount/nextRunAt/recibo. | Cada chamada cria novo run; dispatch concluído não é turno concluído; limite de custo/overlap. |

## Modo público de ensaio — S9 (4, fora das 74 de produção)

| Tool | Classe | Motivo |
|---|---|---|
| `rehearsal_now` | **C** | Uma leitura de relógio não ganha sentido como lote. |
| `rehearsal_echo` | **C** | Eco sintético para testar OAuth; não é operação do control-plane. |
| `rehearsal_notes` | **C** | Já lista todas as notas efêmeras do processo. |
| `rehearsal_note_write` | **C** | Append sintético sem journal; batching testaria outro contrato, sem caso de produto. |

Também foram conferidas as oito entradas `NATIVE_OMITTED`: attachments prepare/discard/send, timeline `t3_thread_read`, list_thread_pull_requests, legacy thread_update, native thread_launch e native project_delete. **Não são tools públicas atuais do Connector**; algumas têm alternativa própria já coberta na matriz. Tools do MCP interno da aplicação, como create_threads, watch_pull_request, preview ou orchestrator_capabilities, não passam a ser tools do Connector por existirem no runtime do T3. Métodos HTTP OAuth, relay privado, CLI e primitivas do SDK não são tools públicas MCP.

## O que o batch deve economizar

1. Achar várias referências: de consultas repetidas em cada host para uma shell autorizada por host e várias queries locais.
2. Montar inbox de vários projetos: de shell por projeto para uma observação por ambiente e páginas independentes por escopo.
3. Inspecionar donas selecionadas: shell/autoridade compartilhadas quando seguro, projeção por thread, com orçamento de resposta; não alegar redução de N projeções para uma sem RPC de suporte.
4. Organizar threads aceitas: de N round trips MCP para uma chamada e N dispatches protegidos. A v1 não deve remover revalidações de segurança para parecer mais rápida.
5. Reconhecer incerteza: N recibos em uma leitura tipada, sem reenviar os efeitos nem converter found=false em prova de não execução.

A priorização, os schemas propostos, as condições de entrada e os testes de aceitação estão no [desenho v1](batch-api-v1.md). A classificação é recomendação do agente, não decisão de Marcus nem autorização de implementação/publicação.
