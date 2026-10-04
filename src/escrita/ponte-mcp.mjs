// MCP da escrita (plugin separado do de leitura). Cada ferramenta só repassa ao relay
// privado do gate; aprovação, escopo e roteamento por environment ficam no gate.
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {ACTIONS,schemaForAction,SEND_DESCRIPTION} from './adapters.mjs';
import {LEITURAS} from './read-guarded.mjs';
import {esquema,normalizarParametros,ParametroInvalido} from '../parametros.mjs';

export const VERSAO_ESCRITA='0.5.0';

const MENSAGENS={
 target_run_id_required:'targetRunId required: read t3_thread in the same environment and pass the active run for steer_active or restart_active; do not replace it with queue_after_active',
 queue_explicit_intent_required:'queue_after_active requires an explicit request to defer and deferUntilActiveCompletes=true; to correct architecture/requirements of the current run use steer_active with targetRunId',
 ambiente_obrigatorio:'pass `environment` (alias or environmentId); writes have no default environment',
 ambiente_desconhecido:'environment not configured in the write connector',
 ambiente_fora_da_lease:'the active lease does not include this environment; request a new approval (t3_pedir_aprovacao) after it expires or is revoked',
 ambiente_indisponivel:'the T3 server of this environment did not respond; nothing was sent',
 scope_denied:'project or action outside the scope approved for this environment',
 thread_not_found:'thread not found in this environment',
 lease_closed:'lease missing, expired or revoked; request approval (t3_pedir_aprovacao)',
 gate_indisponivel:'the approval gate on the local machine is not running',
 dispatch_rejected:'rejected while the connector prepared the request, before sending it to T3; no mutation was sent. It does not mean the model is blocked or the provider is invalid',
 reconciliation_required:'the connector tried to send to T3 but could not confirm the result (RPC, transport or acknowledgement failure); this does not prove the thread was not created nor that the model is invalid. Do not retry and do not create with another provider as a fallback; call t3_reconciliar_escrita with the same environment and operationId',
};

// Nomes antigos (português) aceitos sem aparecer no tools/list (ver docs/adr/0004). O
// relay privado até o gate continua com os nomes antigos: um gate ainda na versão
// anterior entende o que esta ponte manda.
const LEGADO={ambiente:'environment',busca:'search',limite:'limit',estado:'state',incluirSemExecucao:'includeNoRun',maxCaracteres:'maxCharacters'};
const ESTADO_LEGADO={rodando:'running',precisa_intervencao:'needs_intervention',concluida:'completed',falhou:'failed',cancelada:'cancelled',sem_execucao:'no_run',desconhecido:'unknown'};
const PARA_RELAY=Object.fromEntries(Object.entries(LEGADO).map(([legado,ingles])=>[ingles,legado]));
const ESTADO_RELAY=Object.fromEntries(Object.entries(ESTADO_LEGADO).map(([legado,ingles])=>[ingles,legado]));
const entradaDoRelay=input=>Object.fromEntries(Object.entries(input).map(([k,v])=>[PARA_RELAY[k]??k,k==='state'?ESTADO_RELAY[v]:v]));

export function criarPonteEscrita({relay,aliases=[],approvalOrigin}) {
 const lista=aliases.length?aliases.join(', '):'see t3_pedir_aprovacao';
 const erro=e=>{if(e instanceof ParametroInvalido)return {isError:true,content:[{type:'text',text:`${e.codigo}: ${e.message}`}]};const code=/^[a-z_]+$/.test(e.message)?e.message:'gate_rejected';const extra=code==='ambiente_desconhecido'?` (configured: ${lista})`:'';return {isError:true,content:[{type:'text',text:MENSAGENS[code]?`${code}: ${MENSAGENS[code]}${extra}`:code}]};};
 const resultado=async op=>{try{return {content:[{type:'text',text:JSON.stringify(await op())}]};}catch(e){return erro(e);}};
 const environment=z.string().min(1).describe(`T3 environment where the thread/project lives (required; alias or environmentId): ${lista}. IDs from one environment are not valid in another.`);
 const server=new McpServer({name:'t3-connector-write',version:VERSAO_ESCRITA});
 // Ferramenta com parâmetros em inglês e aliases legados; `fn` recebe os campos normalizados.
 // Sem `environment` (nem `ambiente`) falha com ambiente_obrigatorio: escrita não tem padrão.
 const registrar=(nome,{forma,...config},fn)=>{
  const aliases=Object.fromEntries(Object.entries(LEGADO).filter(([,ingles])=>ingles in forma));
  const obrigatorios=Object.entries(forma).filter(([,s])=>!s.safeParse(undefined).success).map(([k])=>k);
  server.registerTool(nome,{...config,inputSchema:esquema(forma,obrigatorios)},async(args,extra)=>{
   let entrada;
   try {
    entrada=normalizarParametros(args,forma,{aliases,valores:{estado:ESTADO_LEGADO},obrigatorios:obrigatorios.filter(k=>k!=='environment')});
    if(entrada.environment===undefined)throw new Error('ambiente_obrigatorio');
   } catch(e) {return erro(e);}
   return fn(entrada,extra);
  });
 };

 server.registerTool('t3_pedir_aprovacao',{description:'Requests passkey approval on the local machine to write for 60 min in the available environments (the per-environment scope is shown on the page), or returns the lease already approved. Never renews.',inputSchema:{},annotations:{readOnlyHint:false,destructiveHint:false}},()=>resultado(async()=>{
  const r=await relay({op:'request'});
  if(r.active)return {authorized:true,...r,channelIdentity:true,individualIdentity:false};
  return {authorized:false,requestId:r.requestId,scopeHash:r.scopeHash,approvalUrl:`${approvalOrigin}/#request=${r.requestId}`,durationMinutes:60,
   ambientes:r.scope.environments.map(e=>({alias:e.alias,environmentId:e.environmentId,projetos:e.projects.length,acoes:e.actions.length})),
   indisponiveis:r.indisponiveis??[],channelIdentity:true,individualIdentity:false};
 }));

 const descricaoAcao=action=>action==='thread.send'?SEND_DESCRIPTION
  :action==='runtime-request.answer'?'Answers a pending user_input runtime request using requestId and answers keyed by question ID from t3_thread.pedidosPendentes; thread.send does NOT answer it.'
  :action==='runtime-request.approve'?'Responds to a pending approval runtime request using requestId and decision from t3_thread.pedidosPendentes; user_input requires runtime-request.answer instead.'
  :action;
 for(const action of ACTIONS)registrar(`t3_escrever_${action.replaceAll('.','_').replaceAll('-','_')}`,{description:`${descricaoAcao(action)} in the chosen environment; requires a 60-min passkey-approved lease that includes this environment; the work runs in full-access mode.`,forma:{leaseId:z.string(),environment,operationId:z.string(),input:schemaForAction(action)},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false}},
  ({leaseId,environment:amb,operationId,input})=>resultado(()=>relay({op:'dispatch',action,leaseId,ambiente:amb,operationId,input})));

 const cursor=z.string().min(1).optional();
 const leituras={t3_projetos:{search:z.string().min(1).optional(),limit:z.number().int().min(1).optional(),cursor},t3_atencao:{},
  t3_threads:{projectId:z.string().optional(),state:z.enum(Object.values(ESTADO_LEGADO)).optional(),includeNoRun:z.boolean().optional(),search:z.string().min(1).optional(),limit:z.number().int().min(1).max(50).optional(),cursor},
  t3_thread:{threadId:z.string().min(1),maxCharacters:z.number().int().min(200).max(6000).optional()},
  t3_mensagens:{threadId:z.string().min(1),limit:z.number().int().min(1).max(20).optional(),maxCharacters:z.number().int().min(100).max(4000).optional()}};
 for(const name of LEITURAS)registrar(name,{description:`${name}: read of the projects approved in the lease, in the chosen environment; requires an active lease and never renews it.${name==='t3_thread'?' Pending runtime requests include full public content and proximaAcao; thread.send does NOT answer them. Use runtime-request.answer for user_input or runtime-request.approve for approval with the requestId; unavailable detail requires inspection in T3.':''}`,forma:{leaseId:z.string(),environment,...leituras[name]},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true}},
  async({leaseId,environment:amb,...input})=>{try{return await relay({op:'read',operation:name,leaseId,ambiente:amb,input:entradaDoRelay(input)});}catch(e){return erro(e);}});

 registrar('t3_reconciliar_escrita',{description:'Looks up the receipt of an operation in the same environment; never repeats the mutation; requires a lease.',forma:{leaseId:z.string(),environment,operationId:z.string()},annotations:{readOnlyHint:true,destructiveHint:false}},
  ({leaseId,environment:amb,operationId})=>resultado(()=>relay({op:'reconcile',leaseId,ambiente:amb,operationId})));
 return server;
}

/** Relay HTTP para o gate local. A capability é relida a cada chamada: muda a cada boot do gate. */
export function relayHttp({porta,lerCapability,timeoutMs=20000}) {
 return async request=>{
  let capability;try{capability=lerCapability();}catch{throw new Error('gate_indisponivel');}
  let r;try{r=await fetch(`http://localhost:${porta}/relay`,{method:'POST',headers:{'content-type':'application/json','x-t3-private-relay':capability},body:JSON.stringify(request),signal:AbortSignal.timeout(timeoutMs)});}catch{throw new Error('gate_indisponivel');}
  const v=await r.json();if(!r.ok)throw new Error(v.error);return v;
 };
}
