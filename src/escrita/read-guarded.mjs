// Leitura sob lease, pelo plugin de escrita: só projetos de leitura do grant DESTE
// environment, conferidos antes e depois de buscar os dados. Reaproveita as ferramentas
// da ponte de leitura sobre um registro de um environment só, com cliente GET filtrado.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {criarServidor} from '../servidor.mjs';
import {criarEscopo} from '../ambientes.mjs';

export const LEITURAS=Object.freeze(['t3_projetos','t3_threads','t3_atencao','t3_thread','t3_mensagens']);

export function clienteFiltrado(cliente,readIds) {
 return {
  shell:async o=>{const s=await cliente.shell(o);return {...s,projects:(s.projects??[]).filter(p=>readIds.has(p.id)),threads:(s.threads??[]).filter(t=>readIds.has(t.projectId))};},
  thread:async(id,o)=>{const s=await cliente.shell(o);const t=(s.threads??[]).find(t=>t.id===id&&!t.deletedAt);if(!t||!readIds.has(t.projectId))throw new Error('thread_not_found');return cliente.thread(id,o);},
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
