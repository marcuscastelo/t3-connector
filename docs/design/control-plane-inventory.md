# Inventário semântico do T3 Connector

Revalidado e finalizado em **05/10/2026, Brasília**, nesta execução **Codex Galm** (GPT-6.1-Sol/high, harness Codex, client T3 Code, Sirius), sem Codex pessoal. O rascunho anterior foi reutilizado, mas contagens, fontes e conclusões abaixo foram conferidas novamente. A proposta final está em [control-plane-v1.md](control-plane-v1.md).

Base exclusiva das afirmações sobre implementação: **07cb5ade44d00ae3accf9a5d3eb4e970bf41277f**, branch `integrate/bfs-snapshot-batch`, worktree a worktree de integração local. Todas as citações relativas `arquivo:linha` abaixo pertencem a esse commit. HEAD e árvore limpa conferidos por leitura; não houve execução de testes, serviços, connectors, sessões ou transcripts. Não houve alteração de código, índice, checkout ou refs.

R = MCP de leitura; L = bridge com lease; O = OAuth com escrita; A = opção projectAdmin consentida em OAuth/all; N = opção nativeTools consentida em OAuth/all. A presença no catálogo não concede a ação nem comprova suporte do backend instalado.

## 1. Contagem na fonte

Contagem estática dos registros e expansão dos loops/Map, sem instanciar serviços. Leituras vêm de `registrar` em `src/servidor.mjs:147`; 42 ações vêm do Map congelado em `src/escrita/adapters.mjs:87`, antes da inclusão opt-in de project/native (`src/escrita/adapters.mjs:91`). As fórmulas abaixo referem-se ao catálogo oferecido, com grants necessários presentes; a facade ainda verifica scope a cada chamada (`packages/mcp-connector-kit/oauth/resource-server.mjs:96`).

| Perfil de produção | Total de tools | Composição e fonte |
|---|---:|---|
| R, stdio | **11** | 11 registros de leitura listados na seção 2; `src/servidor.mjs:147`, `src/servidor.mjs:575` |
| L | **49** | 42 writes + 5 leased reads + approval + reconcile; `src/escrita/ponte-mcp.mjs:47`, `src/escrita/ponte-mcp.mjs:60`, `src/escrita/ponte-mcp.mjs:68`, `src/escrita/ponte-mcp.mjs:71` |
| OAuth sem catálogo de escrita | **11** | Reusa R; escrita depende de writeConfig/conexoes; `src/oauth/t3-tools.mjs:19`, `src/oauth/t3-tools.mjs:21` |
| O restricted ou all, sem A/N | **55** | 11 reads + 42 writes + inbox batch + reconcile; `src/oauth/t3-tools.mjs:19`, `src/oauth/session-writes.mjs:394`, `src/oauth/session-writes.mjs:407`, `src/oauth/session-writes.mjs:423` |
| O/all + A, sem N | **58** | 55 + 2 deletes + count; `src/escrita/project-admin.mjs:25`, `src/oauth/session-writes.mjs:380`, `src/oauth/session-writes.mjs:428` |
| O/all + N, sem A | **73** | 55 + 8 native writes + 10 native reads; `src/escrita/native.mjs:67`, `src/escrita/native.mjs:162`, `src/oauth/session-writes.mjs:382` |
| O/all + A + N | **76** | 55 + 3 + 18; mesmas fontes acima |
| União de nomes de produção R/L/O/A/N | **77** | O completo (76) + `t3_pedir_aprovacao`, exclusivo de L; cinco leased reads e reconcile repetem nomes; `src/escrita/ponte-mcp.mjs:47`, `src/escrita/read-guarded.mjs:9` |

As flags A/N exigem all (`src/oauth/session-writes.mjs:118`, `src/oauth/session-writes.mjs:119`); grants antigos não ganham tools opt-in (`src/oauth/session-writes.mjs:378`). O catálogo R continua listado pela facade mesmo com scope de chamada insuficiente, pois tools/list não o filtra por scope (`packages/mcp-connector-kit/oauth/resource-server.mjs:92`). Não afirmar que um token read-only só descobre 11 nomes quando a implantação tem escrita configurada.

Números antigos nos textos não prevalecem: `docs/oauth-session.md:27` ainda diz oito reads; o desenho histórico em outra ref contava nove. Esta composição registra onze (`src/servidor.mjs:304`, `src/servidor.mjs:391`). Não contar relay HTTP, CLI, endpoints OAuth ou tools do MCP interno do T3 como tools públicas do connector.

## 2. Tools reais de leitura/utilidade

| Nome literal em 07cb5ad | Perfis | Registro/semântica |
|---|---|---|
| `t3_ambientes` | R/O | Configuração/disponibilidade, não recomendação; `src/servidor.mjs:148` |
| `t3_projetos` | R/L/O | Projetos autorizados, directory, running/intervention counts; `src/servidor.mjs:171`, `src/servidor.mjs:199` |
| `t3_threads` | R/L/O | Lista por projeto/state/title/ID; `src/servidor.mjs:221` |
| `t3_buscar_threads` | R/O | Busca entre environments por título ou ID; `src/servidor.mjs:272`, `src/busca-threads.mjs:58` |
| `t3_thread_find_batch` | R/O | Até 50 queries, resolution/cobertura/cursor por query; `src/servidor.mjs:305`, `src/busca-threads.mjs:176`, `src/busca-threads.mjs:238` |
| `t3_providers` | R/O | `server.getConfig`, models/capabilities opt-in; `src/servidor.mjs:345`, `src/providers.mjs:44` |
| `t3_atencao` | R/L/O | Intervenção ou failed unsettled, shell apenas; `src/servidor.mjs:371`, `src/servidor.mjs:385` |
| `t3_workset` | R/O | BFS compacto, actionable/inFlight/grupos; `src/servidor.mjs:391`, `src/workset.mjs:204` |
| `t3_thread` | R/L/O | execution; opt-in settlement v1 no mesmo full snapshot; `src/servidor.mjs:422`, `src/servidor.mjs:453`, `src/escrita/ponte-mcp.mjs:66` |
| `t3_mensagens` | R/L/O | Janela de mensagens, truncamento/histórico; `src/servidor.mjs:512` |
| `t3_aguardar_thread` | R/O | Até 5 s, run_terminal ou execution_idle, eventos; `src/servidor.mjs:546`, `src/espera.mjs:14`, `src/espera.mjs:209` |
| `t3_pedir_aprovacao` | L | Passkey/lease, nunca renovação; `src/escrita/ponte-mcp.mjs:47` |
| `t3_reconciliar_escrita` | L/O | Consulta journal/recibo sem repetir; `src/escrita/ponte-mcp.mjs:71`, `src/oauth/session-writes.mjs:423` |
| `t3_thread_inbox_update_batch` | O | Snooze/unsnooze somente; manifesto + Dispatcher por item; `src/oauth/session-writes.mjs:407`, `src/escrita/lote-inbox.mjs:17` |
| `t3_contar_threads_projeto` | A | Contagem live ativa+arquivada e digest; `src/oauth/session-writes.mjs:428`, `src/escrita/project-admin.mjs:63` |

L não expõe ambientes/providers/find/workset/wait nem inbox batch: allowlist de cinco reads em `src/escrita/read-guarded.mjs:9`; writes geradas em `src/escrita/ponte-mcp.mjs:60`. OAuth compartilha R e tem fontes privadas por invocation em all (`src/oauth/t3-tools.mjs:19`); isso não significa que cada getter shell seja fresco, pois o contexto reutiliza uma shell dentro da invocation (`src/oauth/project-policy.mjs:70`).

## 3. As 42 ações base e seus nomes públicos

Todas em L/O. Nome público exato = `t3_escrever_` + action com `.` e `-` substituídos por `_`; regra no bridge `src/escrita/ponte-mcp.mjs:60` e OAuth `src/oauth/session-writes.mjs:111`. Por exemplo, `thread.launch` é **t3_escrever_thread_launch**, não o `t3_thread_launch` do MCP nativo. Cada ação abaixo gera uma tool; pares na mesma linha continuam sendo duas ações.

| # | Action IDs reais | Definição |
|---|---|---|
| 1–8 | `thread.archive`, `thread.unarchive`, `thread.delete`, `thread.settle`, `thread.pin`, `thread.unpin`, `thread.unsnooze`, `thread.mark-unread` | `src/escrita/adapters.mjs:17`; settle sobrescrito em `src/escrita/adapters.mjs:28` |
| 9 | `thread.unsettle` | `src/escrita/adapters.mjs:18` |
| 10–11 | `thread.snooze`, `thread.auto-settle.set` | `src/escrita/adapters.mjs:29` |
| 12–13 | `thread.pin.reorder`, `thread.active.reorder` | `src/escrita/adapters.mjs:31` |
| 14–15 | `thread.visit`, `thread.title` | `src/escrita/adapters.mjs:32` |
| 16–18 | `thread.runtime-mode.set`, `thread.interaction-mode.set`, `thread.model-selection.set` | `src/escrita/adapters.mjs:34` |
| 19–20 | `provider.switch`, `provider-session.detach` | `src/escrita/adapters.mjs:37` |
| 21–23 | `run.interrupt`, `prepared-run.release`, `queue.resume` | `src/escrita/adapters.mjs:39` |
| 24–27 | `queued-run.cancel`, `queued-run.reorder`, `queued-run.edit`, `queued-message.promote-to-steer` | `src/escrita/adapters.mjs:42` |
| 28–30 | `runtime-request.approve`, `runtime-request.answer`, `thread.user-input.dismiss` | `src/escrita/adapters.mjs:46` |
| 31 | `checkpoint.rollback` | `src/escrita/adapters.mjs:49` |
| 32 | `thread.launch` | `src/escrita/adapters.mjs:54` |
| 33 | `thread.send` | `src/escrita/adapters.mjs:72` |
| 34–36 | `thread.metadata.update`, `thread.pull-request.link`, `thread.pull-request.unlink` | `src/escrita/adapters.mjs:74` |
| 37–39 | `thread.fork`, `thread.merge_back`, `delegated_task.request` | `src/escrita/adapters.mjs:78` |
| 40–42 | `delegated_task.wake-policy`, `delegated_task.completion-delivery.acknowledge`, `delegated_task.completion-delivery.dispose` | `src/escrita/adapters.mjs:81` |

A acrescenta `project.delete` e `project.delete-force`, gerando `t3_escrever_project_delete` e `t3_escrever_project_delete_force` pela mesma regra (`src/escrita/project-admin.mjs:25`, `src/oauth/session-writes.mjs:394`). Não estão nas 42 ACTIONS (`src/escrita/adapters.mjs:89`).

## 4. As 18 tools nativas opcionais

Somente N; mantêm nomes literais e usam environment explícito. Não presumir estes wrappers disponíveis nos outros perfis (`src/oauth/session-writes.mjs:384`, `src/oauth/session-writes.mjs:389`).

| Tipo | Nome | Fonte |
|---|---|---|
| Write | `t3_project_create` | `src/escrita/native.mjs:68` |
| Write | `t3_project_update` | `src/escrita/native.mjs:87` |
| Write | `t3_project_clone` | `src/escrita/native.mjs:92` |
| Write | `t3_environment_preferences_update` | `src/escrita/native.mjs:98` |
| Write | `schedule_task` | `src/escrita/native.mjs:105` |
| Write | `update_scheduled_task` | `src/escrita/native.mjs:120` |
| Write | `delete_scheduled_task` | `src/escrita/native.mjs:139` |
| Write | `run_scheduled_task_now` | `src/escrita/native.mjs:145` |
| Read | `t3_environment_read` | `src/escrita/native.mjs:163` |
| Read | `t3_project_read` | `src/escrita/native.mjs:171` |
| Read | `t3_thread_configuration` | `src/escrita/native.mjs:181` |
| Read | `t3_thread_transfers` | `src/escrita/native.mjs:186` |
| Read | `t3_queue_list` | `src/escrita/native.mjs:191` |
| Read | `t3_queue_read` | `src/escrita/native.mjs:200` |
| Read | `t3_thread_search` | `src/escrita/native.mjs:209` |
| Read | `t3_worktree_status` | `src/escrita/native.mjs:219` |
| Read | `t3_worktree_list` | `src/escrita/native.mjs:230` |
| Read | `list_scheduled_tasks` | `src/escrita/native.mjs:241` |

As omissões são declaradas, não tools oferecidas (`src/escrita/native.mjs:254`). Busca nativa de conteúdo é bounded, sem paginação exaustiva (`src/escrita/native.mjs:210`); não serve como prova de ausência. Rehearsal é catálogo sintético separado (`src/oauth/rehearsal-tools.mjs:1`), excluído dos totais de produção.

## 5. Capacidade semântica → implementação → lacuna

Severidade: **alta** = pode duplicar despacho ou permitir aceite com observação insuficiente; **média** = exige composição manual ou perde cobertura; **baixa** = essencialmente já coberta. Não é classificação de vulnerabilidade nem pedido de upstream.

| Caso/capacidade | O que existe: tool/ação/campo, perfil e fonte | Lacuna | Severidade |
|---|---|---|---|
| 1a. Identificar environments e alcance | t3_ambientes (R/O), identidade/transport/available; `src/ambientes.mjs:126`; auth/identidade verificadas `src/t3.mjs:100` | Available pode vir de conexão verificada cacheada (`src/ambientes.mjs:77`); não é saúde fresca da tarefa; L não tem discovery agregada | Média |
| 1b. Elegibilidade de provider/model/runtime | t3_providers (R/O), models[].slug/capabilities, supportedRuntimeModes, auth.status; `src/providers.mjs:18`, `src/providers.mjs:35`, `src/providers.mjs:44` | Sem recomendação; fields ausentes são ausentes, nenhum validador de rota. Contas/quota/skills não são expostas (`test/providers.test.mjs:125`) | Alta |
| 1c. Carga operacional | workset queriedEnvironments[].counts (R/O); `src/workset.mjs:169`; inFlight groups `src/workset.mjs:37` | Sem definição pública de carga/escopo de contagem; roster shell não prova ausência (`src/workset.mjs:14`). Não mede CPU/RAM/quota | Média |
| 1d. Afinidade projeto/worktree/branch | directory/branch de thread (R/L/O), `src/servidor.mjs:57`; projetos/directory `src/servidor.mjs:199`; worktree_list/status (N), `src/escrita/native.mjs:219`, `src/escrita/native.mjs:230` | Sem mapa de projetos equivalentes entre hosts; metadata não prova existência física/ref atual; nenhuma regra de ordenação de environments | Média |
| 1e. Frente já vive em outro host | find_batch resolve título/ID (R/O), `src/busca-threads.mjs:238` | Não busca PR/path/branch nem recomenda continue_existing; ausência parcial não pode permitir launch | Alta |
| 2a. Localizar dona | buscar/find_batch com coverage e ambiguidade (R/O), `src/busca-threads.mjs:58`, `src/busca-threads.mjs:238` | Sem busca estrutural; projectId só na lista local `src/servidor.mjs:228`; “dona” não é campo do domínio | Alta |
| 2b. Encontrar filhas | workset item lineage.parentThreadId/relationship (R/O), `src/workset.mjs:60`, `src/workset.mjs:83`; execution childThreadId de background `src/execucao.mjs:128` | Sem traversal/cobertura/ciclos; IDs de filhos não autorizam suas leituras. Parent pode estar settled/no_run e só contado (`src/workset.mjs:166`) | Média |
| 2c. Settled, snoozed, no_run, arquivadas | find aplica ACL e !deleted na shell (`src/busca-threads.mjs:89`); workset declara archived indisponível (`src/workset.mjs:191`) | HTTP shell é active (`src/escrita/project-admin.mjs:12`); archived source existe no occupancy (`src/escrita/conexao.mjs:149`), mas não está conectada à descoberta. Complete de hosts não significa complete de populations | Alta |
| 3a. Launch com workspace e idempotência | thread.launch (L/O), root/existing_worktree/worktree, model obrigatório; `src/escrita/adapters.mjs:50`; journal key/reserve `src/escrita/adapters.mjs:113`, `src/escrita/adapters.mjs:148`; path canonical no host `src/escrita/conexao.mjs:167` | Sem preflight revisável, duplicate check ou expected project/path/branch. #workspace só verifica path em existing_worktree (`src/escrita/adapters.mjs:125`); branch/baseRef vão ao T3. Sem garantia de unicidade entre writers | Alta |
| 3b. Recibo/replay de launch | payloadIds preservados no journal, receipt projetado; `src/escrita/adapters.mjs:184`, `src/escrita/conexao.mjs:145` | Replay genérico completed de launch não retorna receipt/created threadId (`src/escrita/adapters.mjs:248`); reconcile normal pode só informar sequence/unknown (`src/escrita/conexao.mjs:171`) | Alta |
| 3c. Send correto/sem fallback | delivery union explícita, operationId=clientRequestId (L/O); `src/escrita/adapters.mjs:66`, `src/escrita/adapters.mjs:140` | start_immediately checa apenas background conhecido que holdsThread; desconhecido passa (`src/escrita/adapters.mjs:225`). Sem guard geral de observation/workspace/pedido/plano/limite/fila | Alta |
| 3c. Aquisição de fatos para send | executionSnapshot usa full sem shell/limitRecovery; `src/escrita/conexao.mjs:160`; execution depende de shell para plano fallback/limite (`src/execucao.mjs:340`, `src/execucao.mjs:343`) | Não basta chamar continuation.canStartNow sobre esse caminho e prometer guard completo: a aquisição precisa incluir fontes frescas autorizadas. OAuth/all reutiliza shell na invocation (`src/oauth/project-policy.mjs:70`), portanto repetição do getter não prova frescor | Alta |
| 3d. Autoridade e recuperação | Dispatcher/Gate; OAuth all contexto privado/final recheck; `src/oauth/session-writes.mjs:187`, `src/oauth/session-writes.mjs:199`; batch journal `src/escrita/lote-inbox.mjs:100` | Identidades de canal e OAuth têm namespaces distintos (`src/escrita/identidade.mjs:12`, `src/escrita/identidade.mjs:21`); não oferecem dedupe transversal mesmo que o armazenamento fosse compartilhado. Reconcile não prova resultado remoto uncertain (`src/escrita/conexao.mjs:177`) | Alta |
| 4a. Fila completed_unsettled | workset groups/counts/actionable (R/O); `src/workset.mjs:34`, `src/workset.mjs:209` | limit corta lista; counts completos não dão cursor (`src/workset.mjs:179`), nem entrega/evidência; L não expõe fila | Média |
| 4b. Avaliar entrega | t3_thread v1 completo, execution e settlement do mesmo full; latestResponse truncada; `src/servidor.mjs:465`, `src/servidor.mjs:503`; correlação resposta/run `src/execucao.mjs:250` | Último texto pode pertencer a outro run; não há avaliação semântica de escopo nem prova de review. Novo packet deve conservar identities/truncation, jamais fabricar aceite | Alta |
| 5a. Pedido/plano/limite/run | execution.continuation.blockers e pendingRequests.nextAction (R/L/O); `src/execucao.mjs:355`, `src/pedidos-runtime.mjs:51` | Workset só resumo shell; detalhe faltante exige inspect_in_t3, não resposta inferida (`src/pedidos-runtime.mjs:48`) | Baixa |
| 5b. Fundo e espera | execution.background.knowledge/holdsThread; `src/execucao.mjs:168`, `src/execucao.mjs:48`; wait execution_idle (R/O), `src/espera.mjs:209` | Roster não é censo OS; futuros wakes não são excluídos (`docs/execution-snapshot.md:146`). L não tem wait, mas pode ler execution | Média |
| 6a. Snooze/unsnooze individual | thread.snooze/unsnooze (L/O), `src/escrita/adapters.mjs:17`, `src/escrita/adapters.mjs:29` | Schema singular UTC; não exige expectedProjectId como batch; `src/escrita/lote-inbox.mjs:25` | Baixa |
| 6b. Snooze/unsnooze em lote | inbox_update_batch (O), 20 itens, offsets normalizados, expectedProjectId, manifesto; `src/escrita/lote-inbox.mjs:17`, `src/escrita/lote-inbox.mjs:39`, `src/oauth/session-writes.mjs:323` | Não existe em L. Sem necessidade de nova política; current batch não faz settle (`src/escrita/lote-inbox.mjs:17`) | Baixa |
| 6c. Snooze não oculta bloqueio | workset precedência intervention/run/background antes de snooze; `src/workset.mjs:45` | Sem lacuna de política; não construir fila alternativa que esconda atividade | Baixa |
| 7a. Guard de settle com aceite | settlementContractVersion:1 + settleGuard.version:1 (R/L/O leitura, L/O write); `src/escrita/adapters.mjs:22`, `src/settlement.mjs:275` | Legacy sem guard continua permitido (`src/escrita/adapters.mjs:28`). Background unknown é warning, não blocker (`src/settlement.mjs:182`); execution bloqueia desconhecimento (`src/execucao.mjs:362`) | Alta |
| 7b. Blockers completos | settlement deriva execution do mesmo full; `src/settlement.mjs:126`, `src/settlement.mjs:159` | v1 ainda usa plano/limite da shell (`src/settlement.mjs:152`), enquanto execution olha plans da projeção/autoResume (`src/execucao.mjs:340`, `src/execucao.mjs:360`). Modo semântico estrito deve consumir continuation canônica | Alta |
| 7c. Pós-verificação e replay | receipt + settlement postCheck/sequence; pending em replay quando não gravado; `src/escrita/adapters.mjs:251`, `src/escrita/adapters.mjs:274` | observed_at_sequence não é CAS/permanência; ACK com pending/unavailable não é settle verificado | Média |
| 7d. Auto-settle fora do connector | warnings PR/pin; `src/settlement.mjs:178`, `src/settlement.mjs:181`; comando link `src/escrita/adapters.mjs:75` | Não observável pelo connector: intenção/aceite que gerou auto-settle upstream. Sem poder interceptar merge/UI; não prometer guard universal | Alta |

## 6. Fronteira de produto e precedentes

Não há campo canônico “frente do fleet” neste domínio. Aqui “frente” é uma seleção T3 de threads por referências verificáveis; titularidade humana permanece decisão do caller. Não inferir conta pelo displayName/instanceId nem quota por runningThreads: a projeção pública dos providers recorta auth.status e omite dados de conta (`src/providers.mjs:35`, `test/providers.test.mjs:125`). Nenhuma integração com fleet é necessária à proposta.

Precedentes lidos: estelar, projeto `t3-connector` (relatos conferidos no código, não estado autoritativo); design batch em `polaris/investigate/batch-tool-opportunities:docs/design/{batch-api-v1.md,batch-tools-analysis.md,batch-tools-inventory.json}`; investigação local de settle prematuro (não versionada). São antecedentes, não provas de API atual. O snapshot de investigação incluído também declara bases históricas distintas (`.investigation/coherent-snapshot.md:18`). A regra final de composição é a que esta base implementa: execution canônico, workset usa holdsThread, batch conserva journal/Dispatcher (`src/workset.mjs:31`, `src/settlement.mjs:26`, `src/escrita/lote-inbox.mjs:1`).

Os limites de ChatGPT fornecidos no brief (tamanho/número de tools e marcação “Suspicious Instruction”) são requisitos de desenho, não um limiar numérico comprovado pelo código. A ocultação efetiva do envelope após revogação é conferida em `packages/mcp-connector-kit/oauth/resource-server.mjs:105`; por isso recuperação precisa manter operationId/batchId depois de `session_expired`.

## 7. Verificação desta entrega

Recontagem estática nesta execução: 11 registros read, 42 actions base, 8 native writes e 10 native reads. As composições por perfil da seção 1 foram refeitas a partir desses registros e dos gates de catálogo, sem instanciar servidor. Todas as referências de ambos os entregáveis foram conferidas por existência/linha; o conteúdo dos arquivos de fonte citados foi comparado byte a byte com os objetos Git de `07cb5ad`. Exemplos JSON da proposta foram parseados. HEAD permaneceu no commit indicado e `git status --short` permaneceu vazio. São verificações documentais, não testes de comportamento nem evidência do backend instalado.
