# Control-plane/BFS v1 — proposta para revisão

> **Status (dona):** proposta para revisão, **não implementada**, salvo a correção de recuperação do launch legacy (§5.4), já aplicada em `5196734` (replay de `thread.launch`/`thread.fork` devolve o recibo com o `threadId` criado). Commits 1–7 da §8 implementados localmente com as recomendações da §9 adotadas como defaults (decisão da dona): 1 `5bba50f`, 2 `bc822df`, 3 `35b9469`, 4 `6828a7e`, 5 `f5bc02c`, 6 `79ffc8c`, 7 (paridade bridge/OAuth e guia `docs/control-plane.md`). Guia de uso: [../control-plane.md](../control-plane.md). Citações `arquivo:linha` valem para `07cb5ad`.

**Desenho, sem implementação.** Revalidado nesta execução Codex Galm, GPT-6.1-Sol/high, harness Codex, client T3 Code, host Sirius. Base exclusiva do código citado: **07cb5ade44d00ae3accf9a5d3eb4e970bf41277f**, em `integrate/bfs-snapshot-batch`. Referências `arquivo:linha` são desse commit; os antecedentes de batch e settle são históricos, não contratos atuais. Inventário completo: [control-plane-inventory.md](control-plane-inventory.md). Nenhum serviço, connector de produção, teste, sessão ou transcript foi acessado. Apenas arquivos desta pasta de entrega foram escritos.

## 1. Decisão recomendada e tamanho da mudança

Acrescentar **uma tool de leitura**, `t3_dispatch_preflight`, porque o contrato de admissão de launch/send não cabe numa listagem nem numa tool de escrita sem perder a separação de autoridade. Estender **sete operações existentes**, sem novos nomes para elas:

| Operação | Extensão proposta | Perfil |
|---|---|---|
| `t3_ambientes` | Recomendação de rota, opt-in `controlPlaneContractVersion: 1` | R/L/O |
| `t3_thread_find_batch` | Seletores estruturais, cobertura de população, relações e duplicatas | R/L/O |
| `t3_workset` | Página da fila de revisão; mesmos grupos e contagens | R/L/O |
| `t3_thread` | Packet de revisão e observação de settlement v2 | R/L/O |
| `thread.launch` | `dispatchGuard.version: 1`, recusa de duplicata e recibo recuperável | L/O |
| `thread.send` | Mesmo guard, execução observada e binding do workspace | L/O |
| `thread.settle` | `settleGuard.version: 2`, consumindo execution canônico | L/O |

Snooze/unsnooze já têm ações individuais e batch OAuth; conservar seus inputs, manifesto, Dispatcher e semântica. Não acrescentar settle ao inbox batch nesta v1: a allowlist atual contém só snooze/unsnooze (`src/escrita/lote-inbox.mjs:17`) e seu executor já compõe operações no Dispatcher (`src/escrita/lote-inbox.mjs:100`). Providers, espera e reconcile recebem apenas wiring de perfil ou correção de projeção de recibo, não outra operação semântica.

**Composição obrigatória:** adquirir dados pelos leitores existentes; derivar trabalho com `derivarExecucao` (`src/execucao.mjs:329`); classificar listas com workset (`src/workset.mjs:45`); derivar settlement e avaliar guard em `src/settlement.mjs:126` e `src/settlement.mjs:275`; escrever só pelo Dispatcher/journal existentes (`src/escrita/adapters.mjs:136`, `src/escrita/journal.mjs:16`). O módulo novo pode coordenar leituras e projetar contratos, mas não manter estado de thread, lista própria de blockers, motor de idempotência ou banco de preflights.

### Catálogos por perfil

R = read MCP; L = lease bridge; O = OAuth com escrita; A/N = opções admin/native consentidas. Totais atuais estão contados na fonte no inventário: R em `src/servidor.mjs:147`, L em `src/escrita/ponte-mcp.mjs:60`, O em `src/oauth/session-writes.mjs:394`. A/N são condicionais a flags e grants (`src/oauth/session-writes.mjs:380`, `src/oauth/session-writes.mjs:382`).

| Perfil | 07cb5ad | Com a v1 proposta | Delta |
|---|---:|---:|---|
| R / OAuth sem writes | 11 | **12** | Preflight |
| L | 49 | **55** | Preflight + ambientes/find_batch/providers/workset/wait |
| O sem A/N | 55 | **56** | Preflight |
| O/all + A | 58 | **59** | Preflight |
| O/all + N | 73 | **74** | Preflight |
| O/all + A + N | 76 | **77** | Preflight |
| União de nomes de produção | 77 | **78** | Preflight; nomes de L já existem em R/O |

Os cinco reads adicionados a L exigem adaptação do contexto de vários environments; a allowlist atual só tem cinco reads e monta registro de um environment (`src/escrita/read-guarded.mjs:9`, `src/escrita/read-guarded.mjs:20`). Não basta acrescentar nomes à lista. Reusar registros/conexões filtrados por grant, verificar lease antes/depois e antes de cada leitura, fornecer ticket/config via leitura autorizada e nunca renovar a lease. A verificação posterior já existe (`src/escrita/read-guarded.mjs:41`). Não acrescentar busca singular, batch inbox, admin ou native ao L.

Novos campos, códigos, tool nova e descrições nascem em inglês. Os nomes portugueses acima identificam os registros atuais, não recomendam perpetuar português no contrato 0.12. A migração English-only é separada: renomear um registro não acrescenta tool; manter aliases simultâneos mudaria estes totais e precisa de inventário próprio. Esta proposta não inventa nomes para a migração ainda não aprovada.

## 2. Contrato comum, identidade, limites e autoridade

Extensões de leitura usam `controlPlaneContractVersion: 1`; settlement tem versão própria **2**, e os guards mantêm versões próprias. Pedido de versão desconhecida é `contract_version_unsupported`, sem fallback. Omissão preserva output/schema/hash legacy, sem inserir defaults novos nos inputs já journaled. O precedente versionado está em `src/servidor.mjs:438` e `src/settlement.mjs:28`.

Alvos são `(environmentId, projectId)` e `(environmentId, threadId)`. Resolver aliases configurados, conservar IDs exatos e não comparar só threadId entre hosts. Caller vem da autoridade, nunca do argumento. R usa sua ACL, L usa `leaseId`, O usa o principal OAuth; O recusa `leaseId`. Exemplos omitem `leaseId`; L acrescenta esse único campo no topo. Readers não verificam consentimento de escrita como requisito para retornar fatos autorizados; `writeAuthorization: "not_checked"` lembra que preflight não concede escrita. Apply passa por todos os gates atuais, inclusive o contexto privado/final recheck OAuth/all (`src/oauth/session-writes.mjs:187`, `src/oauth/session-writes.mjs:199`).

Exemplo de envelope proposto de leitura:

```json
{
  "controlPlaneContractVersion": 1,
  "status": "ok",
  "complete": true,
  "observedAt": "2026-10-05T22:10:00-03:00",
  "sources": [{"environmentId":"env-sirius","kind":"shell","sequence":120}],
  "reasons": [],
  "truncated": false
}
```

`complete` diz completude da operação indicada, não prova de aceite, atomicidade entre hosts ou ausência de trabalho. As buscas têm `coverage`; packets têm `review.complete` e `settlement.complete`; preflight tem `admissible`. Campos desconhecidos são `null` ou `knowledge: "unknown"`, com motivo, nunca zero/false/coleção vazia simulando sucesso. Erro de host conserva linha de resultado e código seguro, sem stack/token/SSH output. Schema malformado, versão inválida ou budget mínimo impossível recusam chamada inteira antes de I/O; cursores inválidos podem continuar sendo erro por query, como hoje (`src/busca-threads.mjs:225`).

Limites propostos, não benchmarks: fan-out máximo 4 hosts simultâneos, 50 queries como o find atual (`src/busca-threads.mjs:176`), no máximo 50 nós na expansão de relações, packet de uma thread por chamada, 64 KiB UTF-8 de resposta por chamada. Discovery/preflight têm deadline global 10 s; aquisição coerente mantém no máximo 3 tentativas (`src/settlement.mjs:30`). Roster e modelos são recortados à instância/modelo solicitado; nunca devolver config inteira. Se nem status/IDs mínimos couberem, recusar antes de executar. Cortar textos/coleções com flag e cursor; não eliminar candidato para parecer único. Full snapshot pode ser caro: budget de resposta não limita o tamanho recebido do backend; fora do deadline, retornar observação incompleta.

Descrições MCP devem explicar entrada/resultado/limite em poucas frases, com annotations corretas, sem instruções de comportamento ao modelo ou fórmulas como "almost never". O código atual contém descrições longas de send/settle (`src/escrita/adapters.mjs:21`, `src/escrita/adapters.mjs:62`); a v1 desloca exemplos para docs e deixa refusals/campos sustentarem o fluxo. O número de tools e a marcação "Suspicious Instruction" são restrições do brief; nenhum limiar universal do ChatGPT foi medido aqui. Escritas conservam annotations e o fluxo de aprovação do host; preflight é `readOnlyHint: true`, sem apply escondido.

## 3. Rota — extensão de t3_ambientes

### Fontes observáveis, sem contas/papéis do fleet

| Sinal | Fonte verificável em 07cb5ad | Natureza e limite |
|---|---|---|
| ID/alias/transport/default | `src/ambientes.mjs:128` | Fato configurado; default não implica melhor host |
| Resposta da conexão | `src/ambientes.mjs:137`; cache `src/ambientes.mjs:77` | Observação/cache; rota exige leitura fresca, não só available cacheado |
| Provider enabled/installed/status/availability/auth.status/runtime modes | `server.getConfig`, `src/providers.mjs:18`, `src/providers.mjs:44` | Fato reportado por T3; campo ausente é desconhecido; não comprova quota real |
| Model slug/options | `src/providers.mjs:39`, `src/servidor.mjs:350` | Fato de catálogo; validação usa modelo exato e optionDescriptors, sem mapear alias de modelo |
| Carga | workset counts por host, `src/workset.mjs:169`; grupos `src/workset.mjs:37` | Derivada de shell autorizada ativa; indicador de ocupação, sem CPU/RAM/capacidade de conta |
| Projeto/path metadata/branch da thread | `src/servidor.mjs:57`, `src/servidor.mjs:204` | Fato de binding reportado; não prova filesystem nem ref Git atual |
| Path canônico aprovado | verifier no domínio de execução, `src/escrita/conexao.mjs:167` | Fato de filesystem limitado ao root exato autorizado; não prova limpeza de Git |
| Branch/ref/worktree física | wrapper `vcs.listRefs`, `src/escrita/native.mjs:230` | Fato se reader N consentido, snapshot/páginas completos e checkout autorizado; senão indisponível |
| Platform Linux/macOS | wrapper opt-in, `src/escrita/native.mjs:168` | Fato quando descriptor validado e esse acesso consentido; ausente no t3_ambientes atual |
| Mesma iniciativa em dois projetos/hosts | pares fornecidos pelo caller | Restrição/afinidade declarada; não inferir equivalência pelo título/root basename |
| Dona de frente | match estrutural + seleção do caller | Derivado/caller; lineage não declara responsabilidade humana |
| Conta, saldo, quota, assinatura, skills por papel | Campos excluídos de providers, `test/providers.test.mjs:125` | **Não observável pelo connector**; hard requirement recusa com insufficient_evidence |
| Processos OS e futuros wakes/autosettlement | limite documentado em `docs/execution-snapshot.md:146`; avisos `src/settlement.mjs:178` | **Não observável pelo connector** como ausência universal; recusar garantia absoluta |

A extensão não chama fleet, não lê model-routing, não aceita accountId inventado e não escolhe Codex pessoal por displayName. A própria tarefa foi executada nesta sessão Galm, sem delegação para outra conta.

### Input e output propostos

```json
{
  "controlPlaneContractVersion": 1,
  "route": {
    "candidates": [
      {"environment":"sirius","projectId":"project-s","modelSelection":{"instanceId":"codex_galm","model":"gpt-6.1-sol","options":[{"id":"reasoningEffort","value":"high"}]},"runtimeMode":"full-access"},
      {"environment":"polaris","projectId":"project-p","modelSelection":{"instanceId":"codex_galm","model":"gpt-6.1-sol","options":[{"id":"reasoningEffort","value":"high"}]},"runtimeMode":"full-access"}
    ],
    "front": {"title":{"value":"Connector control-plane","match":"exact"}},
    "discoveryEnvironments": ["sirius","polaris"],
    "constraints": {"allowedEnvironments":["sirius","polaris"],"requiredPlatform":null},
    "affinity": {"preferredEnvironments":["sirius"],"bindings":[]}
  }
}
```

`route` opcional; presente exige a versão e consultas frescas. Candidates 1–10, no máximo um por environment, IDs próprios de cada host; preferência explícita não inventa equivalência de provider. `discoveryEnvironments` obrigatório e não vazio quando há front. `front` tem os seletores da seção 4, sem cursor/limit; deve ter ao menos uma chave específica além de project. `requiredPlatform` nullable opcional aceita `linux|darwin`; não inferir OS de alias Sirius/Polaris. Constraints desconhecidas recusam schema.

```json
{
  "controlPlaneContractVersion":1,
  "status":"ok",
  "complete":true,
  "route":{
    "decision":"recommend_environment",
    "recommendedEnvironmentId":"env-sirius",
    "existingTargets":[],
    "candidates":[
      {"environmentId":"env-sirius","projectId":"project-s","eligible":true,"rank":1,"load":{"running":2,"backgroundPending":1,"inFlight":3,"needsIntervention":0,"unknown":0,"scope":"authorized_active_threads","coverageComplete":true},"orderKey":[0,0,0,3,0,0,"env-sirius"],"reasons":[{"code":"provider_model_available","source":"server.getConfig"},{"code":"explicit_host_preference","source":"caller"}]},
      {"environmentId":"env-polaris","projectId":"project-p","eligible":false,"rank":null,"load":null,"orderKey":null,"reasons":[{"code":"provider_unavailable","source":"server.getConfig"}]}
    ],
    "guarantee":"recommendation_only"
  }
}
```

`decision`: `recommend_environment|continue_existing|choose_target|inconclusive|no_eligible_environment`. Uma front existente produz `continue_existing` com alvo qualificado, mesmo que outro host esteja menos ocupado; a rota não migra nem envia. Múltiplos matches produzem `choose_target`; coverage incompleta ou população desconhecida produz `inconclusive`. Essas decisões têm `recommendedEnvironmentId: null`; podem mostrar ranking de candidatos como informação. Um `continue_existing` não declara que send seja admissível: ler execution/preflight da dona.

### Algoritmo determinístico

1. Resolver aliases, restringir a environments configurados/autorizados e projectId vivo autorizado. Conexão precisa responder com identidade esperada. Consultar só a instância/modelo candidato; ausência do modelo ou mismatch de option descriptor é recusa.
2. Elegibilidade conservadora: `enabled === true`, `installed === true`, `status === "ready"`, auth.status `authenticated`, runtimeMode explicitamente suportado, modelo exato presente, options válidas. `availability: "unavailable"` recusa; ausência de availability não é necessária se os demais fatos positivos completos provam o predicado. Valores novos/warning/unknown são `capability_unknown`, não sucesso. Valores ready/authenticated têm fixture em `test/providers.test.mjs:22`; não alegar que esgotam todo enum upstream. Suporte de provider sem autenticação precisa de predicado observável próprio; não inferir N/A.
3. Se requiredPlatform for informado, exigir fato reportado com acesso consentido; sem ele `insufficient_evidence`. Capacidade CPU/GPU, assinatura ou workload-specific tool não conhecida também falha fechado, sem trocar requisito por preferência.
4. Resolver front no universo declarado de projetos/hosts e população ativa+arquivada validada. Um match existente impede recomendação de novo launch; mais de um, ou fontes incompletas, impede escolha. `front` ausente permite ranking, mas não dá admissão ao launch protegido, que exige duplicateCheck.
5. Para candidatos elegíveis, carga = `running + background_pending` dos **grupos disjuntos workset** por host, antes de truncar. Não somar duas vezes background de thread running. `needs_intervention` e `unknown` ficam separados: não chamá-los de runs. `background_pending` conta threads com fundo que holdsThread, não quantidade de tasks. Sem source, load=null; não ordenar como zero. Comparar apenas candidatos com scopes declarados; o resultado informa que as ACLs entre hosts podem cobrir populações diferentes.
6. Ordenar lexicograficamente por `[exactWorkspaceAffinityPenalty, exactBranchAffinityPenalty, explicitHostPreferenceIndex, inFlight, needsIntervention, unknown, environmentId]`, ascendente. Afinidade é 0 se há match exato observado, 1 se não; desconhecimento também 1 e razão `affinity_unknown`, nunca match presumido. Paths são locais a cada host e vêm de `affinity.bindings[{environment,projectId,worktreePath?,branch?}]`. Preferência omitida = 0 para todos; lista presente: índice, não listados = tamanho. Ausência de load exclui do ranking com `load_unknown`, sem impedir reportar fatos de afinidade. Último desempate é ID binário ASCII, independente de locale, default e ordem das respostas.

Nenhum coeficiente oculto ou rota para outra conta/host. `reasons[]` ordenado por fase/código, com `source` e campo observado; toda mudança de rank pode ser explicada pelos inputs/fatos. `complete=false` ao falhar qualquer fonte necessária. É recomendação de elegibilidade observada, não garantia de que o provider aceitará iniciar um run.

## 4. Localizar frente e filhas — extensão de find_batch

Hoje o matcher só implementa título/ID (`src/busca-threads.mjs:58`); a resolução conta todos os candidatos antes da página (`src/busca-threads.mjs:238`). Conservar esses algoritmos e cursores para legacy. No opt-in, acrescentar ramo `selector`, coverage e relações; não alterar a semântica de `resolved` legacy por surpresa.

```json
{
  "controlPlaneContractVersion":1,
  "environments":["sirius","polaris"],
  "population":"all",
  "queries":[{
    "key":"owner",
    "selector":{"title":{"value":"Connector control-plane","match":"exact"},"branch":"feat/control-plane","projectIds":[{"environment":"sirius","projectId":"project-s"},{"environment":"polaris","projectId":"project-p"}]},
    "relations":{"direction":"descendants","maxDepth":2,"limit":20},
    "limit":5
  }]
}
```

`selector` estrito, aceita combinação **AND** de `threadId`, `title{value,match:exact|partial}`, `branch`, `worktreePath`, `pullRequest{host,repository,number}`, `projectIds[{environment,projectId}]`. Pelo menos uma condição, sem títulos de projeto implícitos. ThreadId/branch/path/PR literais; título usa normalização já existente (`src/busca-threads.mjs:64`). PR precisa host/repository/number observados, ou URL estruturada validada que forneça esses três; URL inválida/campo incompleto dá `selector_evidence_unavailable`, não match só por número. Dados de links atuais são shell metadata (`src/workset.mjs:61`, `src/escrita/adapters.mjs:75`). Não fazer HTTP em GitHub para completar evidência.

Path absoluto canônico na busca é comparação de metadata, **não** realpath probatório. Branch é comparação literal de binding; existência física é fonte diferente. Seletores fleet/opaqueReference não entram na v1: não existe armazenamento/busca T3 desse campo nesta base; nenhuma chave externa será fingida como existente.

```json
{
  "controlPlaneContractVersion":1,
  "complete":true,
  "results":[{
    "key":"owner","status":"ok","resolution":"resolved","total":1,"returned":1,"truncated":false,
    "coverage":{"environmentsComplete":true,"population":"all","populationComplete":true,"selectorEvidenceComplete":true,"scope":"authorized_projects"},
    "launchDisposition":"continue_existing",
    "candidates":[{"environment":{"alias":"sirius","environmentId":"env-sirius"},"threadId":"owner-a","project":{"projectId":"project-s"},"branch":"feat/control-plane","archived":false}],
    "relations":{"complete":true,"nodes":[{"environmentId":"env-sirius","threadId":"child-a","parentThreadId":"owner-a","depth":1,"source":"shell.lineage"}],"unresolved":[],"truncated":false},
    "reasons":[{"code":"front_exists","source":"shell"}]
  }]
}
```

`launchDisposition`: `continue_existing|choose_target|candidate_new|inconclusive`. `candidate_new` exige zero candidates, fontes/populações/campos necessários completos e nenhum cursor ocultando match. Mesmo esse valor **não autoriza mutação**, nem garante ausência fora da ACL. Thread settled/no_run/snoozed também é candidata, sem preferência por mais nova. Arquivada única não autoriza send automático: devolver alvo e exigir decisão explícita de reativação, sem unarchive escondido.

### Populações, duplicatas e relação BFS

- `population: active|all`, padrão opt-in `active`. `active` nunca prova ausência em all. O código declara lacuna de archived no workset (`src/workset.mjs:191`); há reader RPC já usado por occupancy (`src/escrita/conexao.mjs:149`), não nova API upstream. Reusar leitor/validação active+archived de `src/escrita/project-admin.mjs:63`, extraindo helper comum sem importar sua política de delete/busy. Só marcar all completo após fontes autorizadas, linhas válidas, sequência compatível e domínio de populations testado. Falha/sem suporte retorna `archived_source_unavailable`, resolution inconclusive para zero/um match. Nunca degradar all para active silenciosamente.
- Cobertura inclui projetos autorizados e campos do selector. Não encontrar branch por um campo ausente não prova ausência da frente. Dados de ambiente fora do grant não são revelados; registrar lacuna de cobertura somente no universo autorizado, sem contar threads ocultas.
- Ambiguidade é `total>1`, mesmo com limit=1; um candidato não vence por recência/modelo/host/carga. Caller desambigua escolhendo par exato ou acrescentando projeto/path/PR. Se input já fixa par `(environmentId,threadId)` autorizado, localizar aquele alvo não depende da saúde de outro host; entretanto a prova de ausência de duplicatas para launch continua dependente do domínio inteiro declarado.
- Relações usam `lineage.parentThreadId` e `relationshipToParent` existentes (`src/workset.mjs:83`). Percorrer roster autorizado de todas as threads da população, não apenas os grupos ativos do workset. BFS ordena por depth/environmentId/threadId, conjunto visited do par qualificado, detecta ciclos com `lineage_cycle`. Teto global 50 nós, depth 1–4, cursor para páginas; campos ausentes tornam cobertura de relações unknown. Parent/child não autorizam leitura.
- Refs de background com childThreadId (`src/execucao.mjs:128`) podem enriquecer o packet da dona, com `source: execution.background`; não ler full de todas as threads para achar filhas. Não confundir fork, delegated task e relacionamento humano de dono. Sem referência cross-environment explícita, lineage só liga IDs dentro do environment de origem; nunca procurar o mesmo childThreadId em outro host para adivinhar ligação.
- `relations.direction: children|descendants`, sem criar outra tool. Relations são observação, sem auto-acknowledge/dispose/settle. Cursor invalida por mudança de query/grant/coverage/snapshot necessário; não funciona como autoridade.

## 5. Preflight e despacho protegido

### 5.1 Tool nova, somente leitura

`t3_dispatch_preflight` aceita union estrita `action: thread.launch|thread.send`, `environment` explícito, `input` do branch da ação, `expected` de binding e, para launch, `duplicateCheck`. Não é executor genérico e nunca recebe script/RPC/toolName arbitrário.

```json
{
  "controlPlaneContractVersion":1,
  "environment":"sirius",
  "action":"thread.launch",
  "input":{"projectId":"project-s","title":"Connector control-plane","modelSelection":{"instanceId":"codex_galm","model":"gpt-6.1-sol","options":[{"id":"reasoningEffort","value":"high"}]},"runtimeMode":"full-access","workspaceStrategy":{"type":"existing_worktree","worktreePath":"/home/dev/app-control"},"text":"Implement the reviewed proposal."},
  "expected":{"projectId":"project-s","workspace":{"type":"existing_worktree","path":"/home/dev/app-control","branch":null}},
  "duplicateCheck":{"environments":["sirius","polaris"],"population":"all","selector":{"title":{"value":"Connector control-plane","match":"exact"}}}
}
```

Para send, exemplo de ramo:

```json
{
  "controlPlaneContractVersion":1,
  "environment":"sirius",
  "action":"thread.send",
  "input":{"threadId":"owner-a","text":"Continue with the verified findings.","clientRequestId":"continue-a-1","delivery":"start_immediately"},
  "expected":{"projectId":"project-s","workspace":{"type":"existing_worktree","path":"/home/dev/app-control","branch":null}}
}
```

Inputs não têm `dispatchGuard` no preview; write adiciona o guard resultante. Preflight não reserva operationId, grava texto, cria workspace ou inicia run. ClientRequestId no send continua igual ao operationId no apply (`src/escrita/adapters.mjs:140`). Root exige path=root aprovado; existing_worktree exige path exato aprovado e verifier no host. `branch:null` significa que caller não exige confirmação física de branch; output `branchKnowledge: "not_required"`. Branch exigida precisa reader de ref/worktree consentido e completo, senão `workspace_evidence_unavailable`. Não tratar null como prova de detached HEAD.

**Recorte v1:** despacho protegido suporta `root` e `existing_worktree`. `workspaceStrategy.type: worktree` continua possível no legacy, mas preflight/guard v1 recusam com `workspace_creation_preflight_unsupported`: a base encaminha baseRef/branch ao T3 (`src/escrita/adapters.mjs:126`) e não fornece preparação/resultado físico suficiente para provar o workspace antes da criação. Não simular sucesso com metadata nem criar/check-out worktree no preview. A v1 cobre as donas com checkouts já preparados; expansão de criação física tem contrato posterior. Send não muda workspace pelo texto e não faz handoff.

```json
{
  "controlPlaneContractVersion":1,"status":"ok","complete":true,"admissible":true,
  "action":"thread.launch",
  "target":{"environmentId":"env-sirius","projectId":"project-s"},
  "inputDigest":"sha256:fictional-input",
  "observationId":"dispatch1_fictional-observation",
  "writeAuthorization":"not_checked",
  "workspace":{"type":"existing_worktree","path":"/home/dev/app-control","pathVerified":true,"branch":null,"branchKnowledge":"not_required"},
  "duplicateCheck":{"resolution":"not_found","populationComplete":true,"domain":["env-polaris","env-sirius"],"candidates":[]},
  "execution":null,
  "reasons":[],
  "guarantee":"connector_preflight_and_observation"
}
```

Recusa normal retorna `status: "ok", admissible:false`, `observationId:null` quando dados necessários incompletos, `reasons[{code,source}]` e fatos disponíveis autorizados. Front existente retorna `front_exists` com candidatos qualificados; ambiguous retorna `front_ambiguous`; cobertura insuficiente retorna `front_discovery_incomplete`. Nenhuma recusa transforma-se em send/queue/fallback.

### 5.2 Guard nas duas escritas existentes

Envelope existente conserva environment/operationId/input. Guard é conector-only e removido do payload T3, seguindo precedente de settle (`src/escrita/adapters.mjs:28`). Modelo/runtime/workspace continuam explícitos e não herdados de outro host. Novo ramo semanticamente protegido exige runtimeMode informado; não aceitar o default full-access silencioso de legacy (`src/escrita/adapters.mjs:11`).

```json
{
  "environment":"sirius",
  "operationId":"launch-front-a-1",
  "input":{
    "projectId":"project-s","title":"Connector control-plane",
    "modelSelection":{"instanceId":"codex_galm","model":"gpt-6.1-sol","options":[{"id":"reasoningEffort","value":"high"}]},
    "runtimeMode":"full-access",
    "workspaceStrategy":{"type":"existing_worktree","worktreePath":"/home/dev/app-control"},
    "text":"Implement the reviewed proposal.",
    "dispatchGuard":{
      "version":1,
      "expectedInputDigest":"sha256:fictional-input",
      "expectedObservationId":"dispatch1_fictional-observation",
      "expected":{"projectId":"project-s","workspace":{"type":"existing_worktree","path":"/home/dev/app-control","branch":null}},
      "duplicateCheck":{"environments":["sirius","polaris"],"population":"all","selector":{"title":{"value":"Connector control-plane","match":"exact"}}}
    }
  }
}
```

Send recebe o mesmo objeto `dispatchGuard` em input, sem duplicateCheck e com `expectedRunId` obrigatório nullable, escolhido na observação: null para start_immediately sem ativo, ID do ativo para steer/restart/queue. Preview devolve esse campo. `start_immediately` protegido recusa `onBackgroundWork:"send"`; não oferecer override dos blockers canônicos nesse ramo. Legacy preserva o override existente (`src/escrita/adapters.mjs:226`). Guard hash inclui action/input **sem guard**, mais expected/duplicateCheck normalizados; inputDigest nunca inclui o texto em resposta. Digest é binding de integridade, não credencial ou autorização.

Exemplo completo do ramo protegido de send, com o digest/observationId obtidos do seu próprio preflight:

```json
{
  "environment":"sirius","operationId":"continue-a-1",
  "input":{
    "threadId":"owner-a","text":"Continue with the verified findings.",
    "clientRequestId":"continue-a-1","delivery":"start_immediately",
    "dispatchGuard":{
      "version":1,"expectedInputDigest":"sha256:fictional-send-input",
      "expectedObservationId":"dispatch1_fictional-send-observation",
      "expectedRunId":null,
      "expected":{"projectId":"project-s","workspace":{"type":"existing_worktree","path":"/home/dev/app-control","branch":null}}
    }
  }
}
```

```json
{
  "controlPlaneContractVersion":1,"state":"completed",
  "operationId":"continue-a-1","sent":true,"reconciliationRequired":false,
  "receipt":{"sequence":123},"deliveryObserved":"unavailable",
  "guarantee":"acknowledged_dispatch"
}
```

`expectedObservationId` é hash determinístico do material relevante obtido pelos leitores existentes: par qualificado, binding, provider/model/runtime/option descriptors necessários, resultado/cobertura de duplicateCheck, e para send material de observação da thread+execution. Em send, reutilizar builder versionado de observation/material de settlement, sem segundo banco. Em launch, material pertence à admissão de projeto/workspace/duplicatas, não a um estado de thread ainda inexistente. Não incluir observedAt/cache timestamps nem carga de hosts, pois mudam sem invalidar a intenção. Não persistir token de preview. Fresh read e digest recalculado no apply evitam confiar em conteúdo inventado pelo cliente, mas não provam gesto de revisão humana do preview.

### 5.3 Precondições a partir de execution, não outra lista de blockers

Adquirir observação completa da thread com `lerObservacaoComDados`, de onde já sai execution (`src/settlement.mjs:246`). O caminho atual `executionSnapshot` da conexão não passa shell/limitRecovery (`src/escrita/conexao.mjs:160`); a aquisição comum precisa corrigir isso para que limite/plano estejam disponíveis. Shell precisa ser realmente fresca para a comparação: o proxy OAuth/all reutiliza shell na invocation (`src/oauth/project-policy.mjs:70`), então adquirir/revalidar observação via leitor fresco privado e autorizado, preservando ACL e rechecks. Não chamar o snapshot cacheado três vezes e anunciar estabilidade.

Exigir validação de identidade/statuses/campos necessários no acquisition canônico. Se plano/limite/roster não puderem ser conhecidos, representar incompletude/unknown na camada de observação; não adicionar lógica desses campos no módulo control-plane. Execution já deriva plano e limite, e seu conjunto canônico de blockers está em `src/execucao.mjs:340` e `src/execucao.mjs:355`.

- `start_immediately`: exigir `execution.continuation.canStartNow === true`; recusar segundo `continuation.blockers`, inclusive background unknown. Reasons de resposta velha/fundo recém-encerrado (`src/execucao.mjs:364`) são orientação ao caller, não autorização para novo launch nem blocker inventado.
- `steer_active` e `restart_active`: intenção e targetRunId exatos; permitir o `active_run` que é precisamente o alvo, exigir igualdade de run e recusar os outros blockers canônicos. Validar capability operacional observável desse run/provider; sem suporte/sem evidência, `delivery_capability_unknown`, sem mudar para queue. Ser provider ready não prova suporte a steer. `restart_active` não é compensação de arquivos/efeitos.
- `queue_after_active`: deferUntilActiveCompletes literal true e expectedRunId ativo exato; permitir apenas blocker active_run alvo. Sem ativo, recusar em vez de iniciar imediatamente no protegido; no legacy a descrição permite início sem ativo (`src/escrita/adapters.mjs:60`). Fila já presente/pedido/plano/limite/fundo segurando/unknown recusam; não enfileirar correção automaticamente.

Esta seleção por delivery consome códigos de execution; não reimplementa a detecção dos fatos. Se surgir blocker canônico novo desconhecido pelo mapa de delivery, recusar `execution_blocker_unsupported`. Detalhe de pedido ausente exige inspect_in_t3, como `pendingRequests.nextAction` já define (`src/pedidos-runtime.mjs:51`). Nunca responder pedido com send.

### 5.4 Ordem do apply, journal e resultados

1. Validar schema/versões e autoridade inicial; usar chave atual `(caller,environmentId,destination,operationId)` e hash normalizado (`src/escrita/adapters.mjs:113`, `src/escrita/adapters.mjs:138`). Reservar pelo journal atomicamente antes de async preflight (`src/escrita/journal.mjs:16`). Replay nunca reenvia.
2. Resolver binding/grant, preparar conexão, canonicalizar workspace no host e fazer as revalidações finais existentes. Serializar launch no lock de projeto existente (`src/escrita/adapters.mjs:158`) e, dentro dele, refazer duplicateCheck observado. Esse lock é local em processo; não vendê-lo como trava distribuída.
3. Reexecutar o MESMO preflight com dados frescos, checar expected/inputDigest/observationId; registrar recusa conhecida antes de invoke. Não mutar outro host: discoveryEnvironments pode consultar hosts, mas invoke fica no environment escolhido.
4. Persistir payloadIds, reservar estado uncertain antes do invoke e enviar uma vez; mecanismo atual já o faz (`src/escrita/adapters.mjs:184`). Persistir receipt/results antes de liberar resposta. Sem ACK, uncertain permanece uncertain; sem evidence, não fingir completed/failure retryable.
5. Para launch protegido, acrescentar projeção durable `createdThread:{environmentId,threadId,projectId}` ao registro/resultado, derivada de ACK/payloadIds. ACK não prova preparação da thread: `workspacePostCheck: pending|observed|mismatch|unavailable`; usar leitura posterior autorizada sem auto-retry. Se IDs receipt/payload divergem, conservar ambos como inconsistência, não escolher título parecido.

```json
{
  "controlPlaneContractVersion":1,
  "state":"completed","operationId":"launch-front-a-1","sent":true,"reconciliationRequired":false,
  "receipt":{"threadId":"created-a","resumed":false},
  "createdThread":{"environmentId":"env-sirius","threadId":"created-a","projectId":"project-s"},
  "workspacePostCheck":"pending",
  "guarantee":"acknowledged_dispatch"
}
```

No send, `state:completed` significa ACK do dispatch, não run iniciado/entrega final. Não fabricar runId; retorno pode acrescentar pós-observação com sequence e `deliveryObserved: started|queued|unavailable`, sempre como fato posterior. Se a observação mostrar queued após start, reportar, sem reenviar/interromper.

Recusa nova: `state:rejected,sent:false,reconciliationRequired:false,error:{code,message}`. Persistir esse resultado também para replay/reconcile dos dois perfis, sem generalizar **toda** rejected para não enviada. O Dispatcher hoje tem exceção explícita para recusas settle (`src/escrita/adapters.mjs:247`); uma falha de journal antes do invoke continua conservadora. Reusar um operationId com input/guard diferente dá operation_conflict. Decisão nova após releitura exige ID novo; timeout/resultado oculto exige mesmo ID e reconcile.

**Correção necessária também no legacy launch:** o registro já guarda receipt/payloadIds (`src/escrita/adapters.mjs:189`), mas replay genérico omite receipt/created ID (`src/escrita/adapters.mjs:248`). Corrigir a projeção de recuperação para devolver identidade criada conhecida, reautorizada, sem novo efeito nem alterar hash/key de registros antigos. Reconcile já é inspeção de recibo (`src/escrita/conexao.mjs:171`); fazê-lo preservar a mesma identidade/receipt conhecida, distinguindo journal completed de remoteState desconhecido. É correção da classe “efeito criado conhecido, identidade perdida na recuperação”, não nova API de criação.

Sem exactly-once transversal: namespaces de canais/deployments, caller e journaling existente delimitam dedupe. Dois principals, outro gateway, UI/backend ou IDs novos podem lançar duas frentes no intervalo. A prova de ausência cobre somente o domínio autorizado/declarado, no instante observado. Não acrescentar front registry ou lease distribuída paralela. Se a intenção exige **unicidade global atômica**, recusar `atomic_front_uniqueness_unavailable`: não observável/garantível pelo connector atual. Guard reduz duplicação por erro/retry, não corridas globais.

## 6. Revisão de completed e settle verificado

### 6.1 Página de revisão no workset existente

```json
{
  "controlPlaneContractVersion":1,
  "environments":["sirius","polaris"],
  "reviewQueue":{"group":"completed_unsettled","limit":20}
}
```

Extensão adiciona `reviewQueue` de references sem texto e cursor, mantendo `groups/actionable/inFlight/counts` atuais. Único group v1 = completed_unsettled. Classificação usa grupoDa existente, sem novo critério de completed ou snooze. Total é anterior à página; fonte/cobertura por environment vem do mesmo workset. Hoje counts precedem slice sem cursor (`src/workset.mjs:179`); reusar `src/paginacao.mjs` para cursor vinculado a filtro/ACL/cobertura e vetor de sequences. Mudança no vetor devolve `cursor_snapshot_changed`, recomeçar e deduplicar refs, não anunciar snapshot congelado entre chamadas.

Schema do objeto `reviewQueue`: `group` literal obrigatório, `limit` inteiro 1–100 opcional (default 20), `cursor` string opcional. Cursor não altera grupos/counts e não seleciona thread para escrita. Retorno conserva uma reference por item da página, com environmentId canônico e projectId observado, sem transformar a fila em packet de N full snapshots.

```json
{
  "controlPlaneContractVersion":1,"complete":true,
  "reviewQueue":{"group":"completed_unsettled","total":21,"returned":20,"truncated":true,"nextCursor":"opaque-cursor","items":[{"environmentId":"env-sirius","threadId":"owner-a","projectId":"project-s","runId":"run-a","updatedAt":"2026-10-05T22:10:00-03:00","nextRead":{"settlementContractVersion":2,"review":true}}]},
  "reasons":[]
}
```

Fila é seleção de review, não prova de idle. Snoozed futuros continuam fora dela, mas intervenção/run/fundo mantêm a precedência atual (`src/workset.mjs:45`). Settled idle e no_run não são apagados da descoberta; ficam fora da fila de completed. Quem quiser revisar thread já settled lê por ID, sem desfazer lifecycle automaticamente.

### 6.2 Packet de revisão em t3_thread

```json
{
  "environment":"sirius","threadId":"owner-a",
  "controlPlaneContractVersion":1,"settlementContractVersion":2,
  "review":true,"maxCharacters":4000
}
```

`review:true` requer settlementContractVersion 2. Reusar `lerObservacaoComDados` e montar execution/settlement/review do mesmo full validado, como a base já faz para v1 (`src/servidor.mjs:453`, `src/servidor.mjs:465`). Nenhuma consulta posterior de bounded para escolher texto de outro momento. Observação incompleta não cai silenciosamente em pacote elegível: `review.complete=false`, `settlement.observationId=null`, nenhum guard válido.

```json
{
  "controlPlaneContractVersion":1,
  "threadId":"owner-a","environment":{"environmentId":"env-sirius"},
  "execution":{"contractVersion":1,"continuation":{"canStartNow":true,"blockers":[],"reasons":[]}},
  "settlement":{"contractVersion":2,"complete":true,"observationId":"obs2_fictional","expectedRunId":"run-a","eligibleMechanically":true,"acceptanceRequired":true,"blockers":[],"warnings":[]},
  "review":{
    "complete":true,
    "observationId":"obs2_fictional",
    "run":{"runId":"run-a","status":"completed"},
    "response":{"messageId":"msg-a","runId":"run-a","relation":"latest_executed_run","text":"Implementation and verification references.","truncated":false},
    "workspace":{"projectId":"project-s","worktreePath":"/home/dev/app-control","branch":"feat/control-plane","source":"snapshot_metadata"},
    "linkedPullRequests":[],"relatedThreads":[],
    "availableEvidence":[{"kind":"assistant_message","ref":{"environmentId":"env-sirius","threadId":"owner-a","messageId":"msg-a"},"runId":"run-a"}],
    "verification":{"status":"caller_required"},
    "reasons":[]
  }
}
```

Exemplos de output mostram apenas o delta/recorte; não propõem remover campos legacy. `review.run` aponta `settlement.expectedRunId`, não o providerSession nem a resposta mais recente sem atribuição. Execution já conserva relation da resposta (`src/execucao.mjs:250`); packet busca mensagem atribuída ao run exato no MESMO snapshot. Se só há resposta de run anterior, `response:null`, incluir referência informativa separada com relation older_run, `review.complete:false`, reason `review_response_missing_or_stale`. Se texto truncado/streaming/sem runId, packet é incompleto para aceite; caller pode ler mais conteúdo por leitura autorizada, refazer packet com budget suportado ou verificar artefato externamente. O connector não inventa caminho de artefato a partir de frase nem faz read de arquivos citados.

`availableEvidence` só enumera refs observadas — mensagens, links PR, filhas —, nunca "tests passed" interpretado como prova. Se campos de PR ausentes, `fieldAvailability:false`, não lista vazia conclusiva. Verificação de requisito, testes, ativação/deploy e absorção de filhas são trabalho do caller/dona; nenhuma execução local/PR externa neste contrato. Blockers/pedidos vêm do execution/pendingRequests existentes, sem resumo alternativo de plano/limite.

### 6.3 Settlement v2 no mesmo módulo

Versão 2 é necessária porque a v1 atual avisa sobre fundo unknown sem bloquear (`src/settlement.mjs:182`) e deriva plano/limite parcialmente da shell (`src/settlement.mjs:152`), enquanto execution inclui proposed_plan, auto-resume e background_work_unknown (`src/execucao.mjs:355`). Não declarar que a base já fez essa convergência completa.

Proposta: `observarSettlement` v2 valida aquisição e **projeta os códigos de execution.continuation.blockers**, enriquecidos com IDs presentes em execution, mais incompletude/lifecycle desconhecido já validados. O roster shell só acrescenta fatos conservadores na aquisição de execution, usando seguraAThread; não manter outro algoritmo de fundo em settlement. A v1 mantém contrato/IDs/replay antigos. V2 usa `obs2_` com digest determinístico do material de v1 estendido com binding projeto/path/branch, blockers canônicos, identidades dos runs/pedidos e fingerprint da resposta revisada. Material de background inclui kind/holdsThread/source relevante e endedSinceLatestRun, não só taskId; mudança de kind com mesmo ID invalida. Sem texto cru persistido; digest de conteúdo garante que texto editado sem novo messageId invalide. Não incluir sequence global/updatedAt meramente administrativo como causa universal de invalidação.

Plano/limite exigem frescor/coerência das fontes que os sustentam; se projection não contém planos e shell necessária diverge, v2 fica incompleta. Não concluir canStartNow apenas porque a shell não foi passada. Novo fato/blocker desconhecido torna v2 não elegível, sem duplicar política em batch ou preflight.

### 6.4 Settle com aceite explícito e observação

```json
{
  "environment":"sirius","operationId":"settle-owner-a-1",
  "input":{
    "threadId":"owner-a",
    "settleGuard":{
      "version":2,"expectedRunId":"run-a","expectedObservationId":"obs2_fictional",
      "acceptance":{"accepted":true,"evidenceRef":"review:control-plane-v1/owner-a:accepted"}
    }
  }
}
```

Mesmo shape do guard v1, sem nova action/scope. `acceptance.accepted:true` e evidenceRef não vazia são obrigatórios; evidenceRef é referência curta declarada por quem aceitou, não transcript/PHI/token ou prova autenticada de review humano. O connector não pode verificar o conteúdo de uma referência externa e não atribui aceite a Marcus sem declaração. Pode ser revisão externa de artefato mesmo se resposta textual T3 ausente; o guard prova integridade/ociosidade mecânica, não qualidade da entrega.

No fluxo semântico v1 fica **proibido** settle sem observationId, com obs1 no guard2, com accepted=false/evidenceRef vazia, a partir apenas de workset/completed, com blockers/incompletude ou substituindo runId por threadId. O caminho legacy sem guard continua existente em `src/escrita/adapters.mjs:28`; não prometer que opt-in remove essa bypass da implantação. Desabilitar legacy globalmente exigiria decisão compatível própria, fora desta proposta.

Reusar `avaliarGuard` com branch version2, ordem fixa: versão/aceite → aquisição completa → blockers canônicos → run exato → observationId. Mapeamento de códigos, nunca redefinição do fato:

| Blocker execution | Código settle v2 |
|---|---|
| active_run | settle_active_run |
| queued_runs | settle_queued_work |
| pending_request | settle_pending_request |
| proposed_plan, usage_limit, usage_limit_auto_resume, background_work_active | settle_unresolved_work, com reason = blocker original |
| background_work_unknown | settle_observation_incomplete |
| Novo blocker desconhecido | settle_observation_incomplete |

Settle não precisa run completed: mantém verificação/aceite explícitos para failed/no_run etc.; null expectedRunId só quando observação conhece ausência de run. Full acquisition válida com lifecycle desconhecido não é suficiente para verificação de settled: v2 completa para esse uso exige campos necessários presentes.

Após ACK, reusar pós-leitura/persistência de `src/escrita/adapters.mjs:274`. Branch v2 exige observação completa, sequência >= ACK, settled verdadeiro, blockers canônicos vazios. `postCheck: verified|mismatch|unavailable|pending` continua distinguindo estado observado de envio. Receipt completed não se transforma em uncertain porque pós-leitura falhou. Persistir versão/observation sequence/resultado junto ao recibo; replay não envia nem refaz aceite. Pós-read fresh posterior pode ser pedida via t3_thread, sem comando compensatório.

```json
{
  "state":"completed","operationId":"settle-owner-a-1",
  "receipt":{"sequence":125},
  "settlement":{"contractVersion":2,"guarantee":"observed_at_sequence","postCheck":"verified","settled":true,"observationSequence":126,"blockers":[]}
}
```

**Verified** significa observado settled e mecanicamente desbloqueado naquele sequence. Não significa permanência após restart/wake/merge/pin nem CAS. Intenção de auto-settle/merge fora do connector é **não observável pelo connector** como aceite; não interceptar/remover links/ligar autoSettle ou compensar com unsettle. Os avisos existentes devem permanecer (`src/settlement.mjs:178`). Se requisito é impedir qualquer auto-settle global, responder `upstream_settlement_control_unavailable`, não prometer guard universal.

### 6.5 Sequência BFS de uso

1. Workset/reviewQueue reconstrói quadro; find resolve frente e filhas sem selecionar duplicatas automaticamente.
2. Thread com review/settlement2 apresenta run, resposta atribuída, execution/blockers e refs. PendingRequests.nextAction orienta resolver pedido; não send genérico.
3. Caller verifica escopo/artefatos/resultados e absorve entrega. Decide continuar na mesma dona, esperar, snooze explicitamente ou aceitar.
4. Continuar usa preflight/send protegido; esperar usa `t3_aguardar_thread until=execution_idle`, teto atual 5 s (`src/espera.mjs:14`). Orquestrador que precisa condição longa usa evento/subscription ou polling em processo sem LLM, sem promessa de wake OAuth; não agendar tarefas para simular wait.
5. Aceitar usa settleGuard2 com evidenceRef e observa postCheck. Changed/mismatch/unavailable exigem leitura e decisão, sem replay de efeito nem auto-fallback.
6. Snooze/unsnooze: alvos já qualificados, contrato atual. Singular L/O (`src/escrita/adapters.mjs:29`); batch somente O (`src/oauth/session-writes.mjs:407`). Não interrompem trabalho nem resolvem blockers.

## 7. Códigos estáveis e recuperação

Códigos novos são propostas, não resultados atuais. `reasons[]` pode conservar todos os motivos; refusal primary segue fase e ordem fixa, sem depender da ordem de respostas dos hosts. Schema/auth/capability → aquisição/cobertura → blockers → binding → digest. Nomes adicionais de fontes não são endpoints T3.

| Família | Códigos v1/v2 propostos |
|---|---|
| Admissão | contract_version_unsupported, invalid_input, response_budget_exceeded |
| Rota | provider_unavailable, provider_model_unavailable, model_option_unsupported, runtime_mode_unsupported, capability_unknown, load_unknown, insufficient_evidence, no_eligible_environment |
| Descoberta | front_exists, front_ambiguous, front_discovery_incomplete, archived_source_unavailable, selector_evidence_unavailable, lineage_cycle, cursor_snapshot_changed |
| DispatchGuard | dispatch_guard_version_unsupported, dispatch_guard_required_fields_missing, dispatch_observation_incomplete, dispatch_observation_changed, dispatch_input_changed, dispatch_run_changed, dispatch_project_changed, dispatch_workspace_changed, workspace_evidence_unavailable, workspace_creation_preflight_unsupported, delivery_capability_unknown, execution_blocker_unsupported, atomic_front_uniqueness_unavailable |
| Blockers dispatch | dispatch_active_run, dispatch_queued_work, dispatch_pending_request, dispatch_unresolved_work; reason conserva blocker execution |
| Settlement2 | Códigos existentes de `src/settlement.mjs:288`, com novos reasons canônicos, sem renomear os códigos |
| Autoridade/journal | Reusar scope_denied, lease_closed/session_expired, journal_failed, operation_conflict, reconciliation_required dos perfis existentes |

`sent:false` só aparece quando recusa comprovadamente anterior a invoke. Failures pós-invoke são failed apenas se resposta remota tipada provar recusa; transporte/journal incertos continuam uncertain. O journal mantém preparing/rejected/completed/failed/uncertain, sem inventar estado dispatched/accepted/settled paralelo.

Relay OAuth pode ocultar todo resultado se sessão expire/revogue durante a chamada (`packages/mcp-connector-kit/oauth/resource-server.mjs:105`). Caller retém environment + operationId (e batchId de snooze) **antes** da chamada. Após reautenticação, reconcile autorizado e replay com mesmos IDs recuperam fatos; ausência de envelope, operation_unknown ou remoteState unknown não são prova de que nada aconteceu. Não despachar em outro host para contornar session_expired. Não alterar withholding nem expor credenciais para “melhorar UX”.

## 8. Implementação futura em commits pequenos

Esta entrega não executa o plano. Caminhos novos abaixo são **propostas**, sem referências de linha de arquivos ainda inexistentes. Tests usam fixtures; nenhum smoke/serviço/live connector se torna autorizado por este desenho.

| Ordem/commit | Mudança mínima e arquivos | Aceite determinístico |
|---|---|---|
| 1. Aquisição fresca e canonicalização dos fatos | `src/settlement.mjs`, `src/execucao.mjs`, `src/escrita/conexao.mjs`, `src/oauth/project-policy.mjs`; exportar acesso a observation/material, sem outro estado | Fixtures com active plan só na projeção, limit autoResume só na shell, roster ausente, shell cacheada/mudando; todos os consumers usam um execution. Preservar output/hash v1 e legacy; shell lagging não pode aprovar strict |
| 2. Settlement/guard2 | Mesmos módulos + adapters, servidor, ponte-mcp, session-writes; docs de settlement | Regressões unknown fundo, kind mudou com ID igual, mensagens editadas, path/project changed, autoResume, held queue; zero invokes em recusa. Full/packet/post-check da mesma observação. Obs1/guard2 recusa. Crash após ACK mantém receipt/pending; replay invokes=1 |
| 3. Find estrutural e população/lineage | `src/busca-threads.mjs`, `src/paginacao.mjs`, servidor; helper read active+archived extraído de project-admin/conexao sem copiar busy/delete | IDs iguais em hosts, titles iguais, PR number igual em repositórios diferentes, limit=1 com total=2; ausência de archived/campo é inconclusive. BFS ciclos/ACL/limite/filhas settled/no_run. Uma aquisição por host por chamada, não N shell por query |
| 4. Rota no agregador | Novo `src/control-plane.mjs` puro para coordenar/projetar; ambientes/providers/workset/servidor | Mesmas observações em ordem aleatória dão ranking/reasons iguais. Disabled/model ausente/opção inválida/platform desconhecida recusam. Counts antes da página e sem dupla contagem. Unknown nunca load=0. Frente existente vence recomendação de novo host |
| 5. ReviewQueue e packet | workset/paginacao/servidor/settlement; sem thread_read_batch | Cursor com sequences/grants alterados invalida. Completed com active/background é classificado pelo workset existente. Response de run antigo nunca vira entrega do expectedRun. Truncation explícita, 64 KiB contado em UTF-8, nenhuma leitura de arquivos citados |
| 6. Preflight/read + guards dispatch | control-plane/adapters/conexao/servidor; schema estrito com ramo guard separado | Spy de invoke=0 no preview. Expected binding/roster/plan/limit/run mudam em barrier após prepare: guard recusa. start/steer/restart/queue preservam intenção; nenhuma fallback. root/existing path host correct; criação worktree strict unsupported. Recuperação launch retorna created ID em original/replay/reconcile |
| 7. Paridade L/O, consent e documentação final | read-guarded/ponte-mcp/session-writes/t3-tools; README/docs/CHANGELOG e package checker se necessário | tools/list nos perfis dá totais acima, antigos grants não ganham A/N. Dois principals/mesmo threadId/refresh/relogin/restart; zero leitura fora da ACL. Revogar durante preview/apply/release bloqueia dados/envios e conserva recibo. Closed session withholding testado. Reconcile não reenvia |

Reusar exports reais de `test/apoio.mjs`: LOCAL/REMOTO com IDs repetidos (`test/apoio.mjs:11`), dadosPadrao (`test/apoio.mjs:25`), ambientesFalsos com contagem de chamadas (`test/apoio.mjs:64`), conectarMcp (`test/apoio.mjs:102`); fixtures thread/pedido/projecao/mensagem (`test/fixtures.mjs:8`, `test/fixtures.mjs:40`, `test/fixtures.mjs:55`, `test/fixtures.mjs:66`). **Ajustar explicitamente** projecao.thread/id, snapshotSequence, planos/roster: fixture básica não contém toda evidência strict. Não usar ausência no fixture como “sem fundo”. Provider doubles/optionDescriptors em `test/providers.test.mjs:10`. Barreiras/promises em fake readers testam corridas sem clock/sleep reais.

Estender `test/execucao-integracao.test.mjs`, `test/settlement.test.mjs`, `test/escrita-settle-guard.test.mjs`, `test/oauth-settle-guard.test.mjs`, `test/busca-lote.test.mjs`, `test/workset.test.mjs`, `test/escrita-launch-model.test.mjs`, `test/escrita-send.test.mjs`, `test/escrita-read-guarded.test.mjs`, `test/oauth-all-projects.test.mjs`, e adicionar testes de control-plane/preflight. FileJournal de teste deve estar em diretório temporário da suite, sem journal real. Contar invocations e provar persistência depois de reiniciar handle/Dispatcher: novo input com mesmo ID conflita; uncertain/preparing antigos nunca reexecutam.

Após implementação, rodar targeted tests de cada commit, depois `npm test` e `npm run test:package` definidos em `package.json:28`. Não repetir suite sem novo motivo. Validação E2E real/ChatGPT do catálogo, orçamento e aprovação precisa rodada explicitamente autorizada; fixtures não provam backend instalado. Nenhum teste foi rodado nesta investigação, por restrição do brief.

## 9. Fora da v1 e decisões humanas abertas

Fora: criação física de worktree pelo despacho protegido; mover thread entre hosts/projetos; conta/quota/roteamento por papel; fleet ledger/frentes; executor genérico; batch de launch/send/settle; inbox read/thread read/reconcile batch; nova política de scheduler; watchers persistentes/wake de voz; gerenciar Git/deploy/PR; canonicalidade distribuída/lock cross-client; interceptar autosettlement do T3; provas de requisitos por análise automática do texto. Nada demanda alteração do backend/upstream.

| Decisão aberta (máximo 7) | Recomendação | Risco residual |
|---|---|---|
| 1. Compatibilidade do settle legacy | Manter omissão/v1 e anunciar v2 como fluxo semântico; avaliar retirar legacy só em migração própria | Clientes antigos podem bypassar guard; sem proteção universal |
| 2. Domínio da prova de duplicata | Exigir domain explícito + all validado no launch protegido; sem fonte, recusar | Existe frente fora da ACL/outro gateway; unicidade global indisponível |
| 3. Workspace strict v1 | Root/existing preparados; branch física só com reader consentido; criação worktree depois | Recorte bloqueia algumas launches atuais, mas não promete preflight físico inexistente |
| 4. Elegibilidade warning/unknown de provider | Aceitar inicialmente somente ready/authenticated e support explícito | Provider funcional pode ser excluído; ampliar só com predicado/fixture reais, sem fallback |
| 5. Carga e preferência | Workset authorized_active_threads, ordem lexicográfica explícita da seção 3 | Escopos desiguais e sem CPU/quota; preferência humana pode superar carga |
| 6. Revisão/evidenceRef | Declaração de aceite do caller, packet de fatos, refs curtas sem conteúdo sensível | Referência pode não ser verificada pelo connector; completed não comprova entrega |
| 7. Catálogo L e limites de ChatGPT | Cinco reads existentes + uma tool; budget 64 KiB e descrições curtas; ensaio posterior | Sem medição de payload/tool limit/consent real; não ativar profile novo só com design |

**Bloqueios observacionais, não trabalho pendente de implementação nesta investigação:** suporte real a archived/ref readers/steering e fresh shell precisa validação futura no ambiente autorizado. Guarantees globais de unicidade/CAS/ausência de processos/wakes/controle de autosettlement são não observáveis ou indisponíveis pelo connector; comportamento strict é recusar a garantia, não inventar upstream. Os arquivos finais são material de revisão da dona implementadora; não há código, push, PR ou ativação nesta entrega.
