import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Gate,grantDoAmbiente} from './gate.mjs';
import {Dispatcher} from './adapters.mjs';
import {grantFromInventory,escopoDosGrants} from './scope.mjs';
import {identidadeCanal,exigirIdentidade} from './identidade.mjs';
import {resolverAmbiente} from './config.mjs';
import {leituraProtegida,leituraProtegidaMulti} from './read-guarded.mjs';
import {fontesEscrita,preflightDespacho} from '../despacho.mjs';
// Private relay only. Its fixed binding is provisioned by the operator bootstrap,
// never selected by a tool argument/sessionId/callId. No generic RPC forwarding.
//
// Cada environment configurado tem conexão, dispatcher e grant próprios. A operação
// escolhe o environment por `ambiente` (alias ou environmentId); sem ele, ou fora da
// lease, falha. Nunca há fallback para outro environment.
export function controller({conexoes,passkeys,journal,organization,tunnelId,inventarioMs=15000}) {
 const capability=randomBytes(32).toString('base64url');
 const gate=new Gate({audit:e=>journal.audit(e),verify:p=>passkeys.verify(p)});
 const identity=identidadeCanal({organization,tunnelId});
 const registros=conexoes.map(c=>c.registro);
 const dispatchers=new Map(conexoes.map(c=>[c.registro.alias,new Dispatcher({gate,adapter:c.adapter,journal,environmentId:c.registro.environmentId,destination:c.registro.destination,dispatchPreflight:(pedido,{scope})=>preflightDespacho(pedido,fontesEscrita(conexoes,scope))})]));
 const porAlias=new Map(conexoes.map(c=>[c.registro.alias,c]));
 const identidade=r=>({alias:r.alias,environmentId:r.environmentId});
 const authenticate=value=>{if(typeof value!=='string'||value.length!==capability.length||!timingSafeEqual(Buffer.from(value),Buffer.from(capability)))throw new Error('channel_unverified');};
 const resolver=chave=>porAlias.get(resolverAmbiente(registros,chave).alias);

 // Inventário de cada environment no momento do pedido; quem não responde fica de fora
 // do escopo e aparece em `indisponiveis` (sem conceder nada nele).
 async function montarEscopo() {
  const grants=[],indisponiveis=[];
  await Promise.all(conexoes.map(async c=>{
   const r=c.registro;
   try {
    // Inventário completo do environment agora; nada é filtrado aqui.
    const projetos=await Promise.race([c.inventario(),new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),inventarioMs).unref())]);
    if(!projetos.length)throw new Error('sem_projetos');
    grants.push(grantFromInventory({alias:r.alias,environmentId:r.environmentId,label:r.alias,destination:r.destination,projects:projetos,actions:r.acoes}));
   } catch(e) {indisponiveis.push({...identidade(r),motivo:/^[a-z_]+$/.test(e.message)?e.message:'ambiente_indisponivel'});}
  }));
  if(!grants.length)throw new Error('ambiente_indisponivel');
  return {scope:escopoDosGrants(grants),indisponiveis};
 }

 const resumoLease=s=>({active:true,leaseId:s.leaseId,expiresAt:s.expiresAt,remainingMs:s.remainingMs,scopeHash:s.scopeHash,
  ambientes:s.scope.environments.map(e=>({alias:e.alias,environmentId:e.environmentId,projetos:e.projects.length,acoes:e.actions.length}))});

 return {gate,capability,identity,async relay(auth,request){
  authenticate(auth);
  if(request.op==='ambientes')return {ambientes:registros.map(identidade)};
  if(request.op==='status'){const s=gate.statusFor(identity);return s.active?resumoLease(s):{active:false};}
  if(request.op==='request'){
   const current=gate.statusFor(identity);if(current.active)return resumoLease(current);
   const {scope,indisponiveis}=await montarEscopo();
   return {...gate.request(identity,scope),indisponiveis};
  }
  // Lease ativa deste canal; nunca renova.
  const leaseAtiva=()=>{const s=gate.status(request.leaseId);if(!s.active||s.scope.caller!==exigirIdentidade(identity))throw new Error('lease_closed');return s;};
  if(request.op==='readMulti')return leituraProtegidaMulti({verificarTodos:()=>leaseAtiva().scope.environments,conexoes,operation:request.operation,input:request.input??{}});
  if(request.op==='preflight'){
   // Mesmo cálculo e mesma ACL do dispatchGuard no apply (grant da lease); candidatos de projetos
   // sem leitura no grant saem só como contagem.
   const s=leaseAtiva();
   const leitura=new Map(s.scope.environments.map(e=>[e.environmentId,new Set(e.readProjectIds??[])]));
   let r;
   try {r=await preflightDespacho(request.input,fontesEscrita(conexoes,s.scope));}
   catch(e){if(e?.codigo==='invalid_input')throw new Error('invalid_input');throw e;}
   leaseAtiva();
   const visivel=c=>leitura.get(c.environmentId)?.has(c.projectId);
   const filtrar=l=>l.filter(visivel);
   const ocultos=l=>l.filter(c=>!visivel(c)).length;
   return {...r,
    ...(r.duplicateCheck?{duplicateCheck:{...r.duplicateCheck,candidates:filtrar(r.duplicateCheck.candidates),hiddenCandidates:ocultos(r.duplicateCheck.candidates)}}:{}),
    reasons:r.reasons.map(x=>x.candidates?{...x,candidates:filtrar(x.candidates),hiddenCandidates:ocultos(x.candidates)}:x)};
  }
  const c=resolver(request.ambiente),r=c.registro;
  if(request.op==='dispatch'){
   const result=await dispatchers.get(r.alias).dispatch(identity,request.leaseId,{operationId:request.operationId,action:request.action,input:request.input});
   return {ambiente:identidade(r),...result};
  }
  if(request.op==='reconcile')return {ambiente:identidade(r),...await dispatchers.get(r.alias).reconcile(identity,request.leaseId,request.operationId)};
  if(request.op==='read'){
   const verificar=()=>{
    const s=gate.status(request.leaseId);
    if(!s.active||s.scope.caller!==exigirIdentidade(identity))throw new Error('lease_closed');
    const grant=grantDoAmbiente(s.scope,{environmentId:r.environmentId,destination:r.destination});
    if(!grant)throw new Error('ambiente_fora_da_lease');
    return grant;
   };
   return leituraProtegida({verificar,cliente:await c.cliente(),ambiente:identidade(r),operation:request.operation,input:request.input??{}});
  }
  throw new Error('action_unavailable');
 },fechar(){gate.close();for(const c of conexoes)c.fechar();}};
}
