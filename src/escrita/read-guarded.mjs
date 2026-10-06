// Leitura sob lease, pelo plugin de escrita: só projetos de leitura do grant DESTE
// environment, conferidos antes e depois de buscar os dados. Reaproveita as ferramentas
// da ponte de leitura sobre um registro de um environment só, com cliente GET filtrado.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {criarServidor} from '../servidor.mjs';
import {criarEscopo} from '../ambientes.mjs';

export const LEITURAS=Object.freeze(['t3_projetos','t3_threads','t3_atencao','t3_thread','t3_mensagens','t3_providers','t3_aguardar_thread']);
// Control-plane v1 (§1): leituras que atravessam environments, sobre todos os da lease, cada um
// com os projetos de leitura do próprio grant.
export const LEITURAS_MULTI=Object.freeze(['t3_ambientes','t3_thread_find_batch','t3_workset']);

export function clienteFiltrado(cliente,readIds) {
 return {
  shell:async o=>{const s=await cliente.shell(o);return {...s,projects:(s.projects??[]).filter(p=>readIds.has(p.id)),threads:(s.threads??[]).filter(t=>readIds.has(t.projectId))};},
  thread:async(id,o)=>{const s=await cliente.shell(o);const t=(s.threads??[]).find(t=>t.id===id&&!t.deletedAt);if(!t||!readIds.has(t.projectId))throw new Error('thread_not_found');return cliente.thread(id,o);},
  // Full snapshot (settlement observation): same ACL as the bounded read.
  threadCompleto:async(id,o)=>{const s=await cliente.shell(o);const t=(s.threads??[]).find(t=>t.id===id&&!t.deletedAt);if(!t||!readIds.has(t.projectId))throw new Error('thread_not_found');return cliente.threadCompleto(id,o);},
  // WS (providers, espera, arquivadas): a ACL de thread é conferida pela shell filtrada antes.
  ...(cliente.ticketWs?{ticketWs:o=>cliente.ticketWs(o),base:cliente.base}:{}),
 };
}

function registroUnico({ambiente,cliente,readIds}) {
 const r={alias:ambiente.alias,environmentId:ambiente.environmentId,projetosPermitidos:[...readIds],escopo:criarEscopo(ambiente.alias,[...readIds]),ssh:null};
 const conexao={cliente,info:{}};
 return {
  padrao:ambiente.alias,registros:[r],identidade:()=>({...ambiente}),
  resolver:chave=>{if(chave!==undefined&&chave!==ambiente.alias&&chave!==ambiente.environmentId)throw new Error('ambiente_fora_da_lease');return r;},
  conectar:async()=>conexao,usar:async(_r,fn)=>fn(cliente,{}),falhou(){},listar:async()=>[],fechar(){},
 };
}

export async function leituraProtegida({verificar,cliente,ambiente,operation,input}) {
 if(!LEITURAS.includes(operation))throw new Error('action_unavailable');
 const readIds=new Set(verificar().readProjectIds??[]);
 if(!readIds.size)throw new Error('scope_denied');
 if(input.projectId&&!readIds.has(input.projectId))throw new Error('scope_denied');
 const servidor=criarServidor({ambientes:registroUnico({ambiente,cliente:clienteFiltrado(cliente,readIds),readIds})});
 const mcp=new Client({name:'leitura-protegida',version:'1.0'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 try {
  await servidor.connect(b);await mcp.connect(a);
  const resultado=await mcp.callTool({name:operation,arguments:{...input,environment:ambiente.alias}});
  // Lease vencida ou revogada durante a leitura: o resultado já buscado não sai.
  verificar();
  return resultado;
 } finally {await mcp.close();await servidor.close();}
}

function registroMultiplo(itens) {
 const registros=itens.map(i=>({alias:i.ambiente.alias,environmentId:i.ambiente.environmentId,projetosPermitidos:[...i.readIds],escopo:criarEscopo(i.ambiente.alias,[...i.readIds]),ssh:null,obter:i.obter,readIds:i.readIds}));
 const resolver=chave=>{const r=chave===undefined?registros[0]:registros.find(x=>x.alias===chave||x.environmentId===chave);if(!r)throw new Error('ambiente_fora_da_lease');return r;};
 const cliente=async r=>clienteFiltrado(await r.obter(),r.readIds);
 return {
  padrao:registros[0].alias,registros,identidade:r=>({alias:r.alias,environmentId:r.environmentId}),resolver,
  conectar:async r=>({cliente:await cliente(r),info:{}}),usar:async(r,fn)=>fn(await cliente(r),{}),falhou(){},fechar(){},
  listar:async()=>registros.map((r,i)=>({alias:r.alias,environmentId:r.environmentId,default:i===0,transport:'lease',allowedProjectCount:r.readIds.size})),
 };
}

/**
 * Leitura sob lease que atravessa environments (t3_ambientes, t3_thread_find_batch, t3_workset):
 * só environments da lease com projetos de leitura, cada um com sua ACL; a lease é conferida antes
 * e depois. Um environment que não responde vira falha de cobertura, não erro da chamada.
 */
export async function leituraProtegidaMulti({verificarTodos,conexoes,operation,input}) {
 if(!LEITURAS_MULTI.includes(operation))throw new Error('action_unavailable');
 const grants=verificarTodos();
 const itens=[];
 for(const c of conexoes) {
  const g=grants.find(e=>e.environmentId===c.registro.environmentId&&e.destination===c.registro.destination);
  const readIds=new Set(g?.readProjectIds??[]);
  if(readIds.size)itens.push({ambiente:{alias:c.registro.alias,environmentId:c.registro.environmentId},readIds,obter:()=>c.cliente()});
 }
 if(!itens.length)throw new Error('scope_denied');
 const servidor=criarServidor({ambientes:registroMultiplo(itens)});
 const mcp=new Client({name:'leitura-protegida-multi',version:'1.0'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 try {
  await servidor.connect(b);await mcp.connect(a);
  const resultado=await mcp.callTool({name:operation,arguments:input});
  verificarTodos();
  return resultado;
 } finally {await mcp.close();await servidor.close();}
}
