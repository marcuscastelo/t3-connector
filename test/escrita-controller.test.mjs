import test from 'node:test';
import assert from 'node:assert/strict';
import {controller} from '../src/escrita/controller.mjs';
import {setup,memoryJournal,ORIGIN} from './escrita-fixtures.mjs';
import {fixtures} from './escrita-acoes-fixtures.mjs';
import {validarConfigEscrita} from '../src/escrita/config.mjs';

// Dois environments com os MESMOS IDs de projeto e thread: o roteamento tem de separar.
function conexaoFalsa(alias,environmentId,{projetos=[{id:'app',name:'app',directory:`/${alias}/app`},{id:'outro',name:'outro',directory:`/${alias}/outro`}],threads={thread:'app','t-outro':'outro'},falhaInventario=false,acoes}={}) {
 const calls=[];
 return {calls,registro:{alias,environmentId,destination:`t3://${environmentId}`,acoes:acoes??['thread.send','thread.settle','thread.unsettle','run.interrupt']},
  inventario:async()=>{if(falhaInventario)throw new Error('ambiente_indisponivel');return projetos;},
  cliente:async()=>({shell:async()=>({projects:projetos.map(p=>({id:p.id,title:`${p.name}@${alias}`,workspaceRoot:p.directory})),threads:Object.entries(threads).map(([id,projectId])=>({id,projectId,title:`${id}@${alias}`,status:'completed',latestRunId:'r1',modelSelection:null}))}),thread:async()=>({projection:{messages:[],runs:[]},hasMoreHistory:false})}),
  adapter:{prepare:async()=>calls.push('prepare'),projectForThread:async id=>threads[id],invoke:async(m,p)=>{calls.push({m,p});return {sequence:calls.length};},receipt:r=>({sequence:r.sequence}),reconcile:async r=>({found:r.state==='completed',state:'unknown'})},
  fechar(){}};
}
const send=(texto='oi',id='op-1')=>({action:'thread.send',operationId:id,input:{threadId:'thread',text:texto,clientRequestId:id,delivery:'start_immediately'}});

async function montar(opcoes={}) {
 const s=setup(),local=conexaoFalsa('local','env-p',opcoes.local),remoto=conexaoFalsa('remoto','env-s',opcoes.remoto);
 const c=controller({conexoes:[local,remoto],passkeys:s.passkeys,journal:{...memoryJournal(),audit:()=>{}},organization:'my-org',tunnelId:'tunnel_fixture'});
 const aprovar=async()=>{const r=await c.relay(c.capability,{op:'request'});const ch=c.gate.challenge(r.requestId,ORIGIN);const l=await c.gate.approve(r.requestId,{response:s.auth.assertion(ch),origin:ORIGIN});return {r,l};};
 return {s,c,local,remoto,aprovar,relay:req=>c.relay(c.capability,req)};
}

test('relay recusa canal forjado, RPC arbitrário e todas as ações sem lease',async()=>{
 const {c,local,remoto,relay}=await montar();
 await assert.rejects(c.relay('model-claimed-session',{op:'request'}),/channel_unverified/);
 await assert.rejects(relay({op:'rpc',method:'arbitrary',ambiente:'local'}),/action_unavailable/);
 for(const {action,input} of fixtures)for(const ambiente of ['local','remoto'])await assert.rejects(relay({op:'dispatch',ambiente,leaseId:'none',operationId:input.clientRequestId??'operation',action,input}));
 assert.equal(local.calls.length+remoto.calls.length,0);
});

test('pedido mostra os dois environments com grants separados e identidade de canal estável',async()=>{
 const {relay}=await montar();
 const r=await relay({op:'request'});
 assert.equal(r.scope.scopeVersion,2);
 assert.deepEqual(r.scope.environments.map(e=>[e.alias,e.environmentId,e.destination]),[['local','env-p','t3://env-p'],['remoto','env-s','t3://env-s']]);
 assert.deepEqual(r.scope.environments[1].projects.map(p=>p.directory),['/remoto/app','/remoto/outro']);
 assert.equal(r.scope.caller,'canal:my-org|securetunnel:tunnel_fixture');
 assert.deepEqual(r.indisponiveis,[]);
});

test('mutação exige ambiente; desconhecido falha; nada vai ao Local por padrão',async()=>{
 const {aprovar,relay,local,remoto}=await montar();const {l}=await aprovar();
 await assert.rejects(relay({op:'dispatch',leaseId:l.leaseId,...send()}),/ambiente_obrigatorio/);
 await assert.rejects(relay({op:'dispatch',ambiente:'inexistente',leaseId:l.leaseId,...send()}),/ambiente_desconhecido/);
 assert.equal(local.calls.length+remoto.calls.length,0);
});

test('send no Remoto vai só ao socket do Remoto e o receipt diz o environment',async()=>{
 const {aprovar,relay,local,remoto}=await montar();const {l}=await aprovar();
 const r=await relay({op:'dispatch',ambiente:'remoto',leaseId:l.leaseId,...send()});
 assert.deepEqual(r.ambiente,{alias:'remoto',environmentId:'env-s'});
 assert.equal(r.state,'completed');
 assert.equal(local.calls.length,0);
 assert.equal(remoto.calls.filter(x=>x.m).length,1);
 assert.equal(remoto.calls.find(x=>x.m).p.type,'message.dispatch');
 // Por environmentId também resolve, e o mesmo operationId noutro environment é outra operação.
 await relay({op:'dispatch',ambiente:'env-p',leaseId:l.leaseId,...send()});
 assert.equal(local.calls.filter(x=>x.m).length,1);
 const rep=await relay({op:'dispatch',ambiente:'remoto',leaseId:l.leaseId,...send()});
 assert.equal(rep.state,'completed');assert.equal(remoto.calls.filter(x=>x.m).length,1,'mesmo operationId no mesmo environment não reenvia');
});

test('settle e unsettle no Remoto com threadId que só existe lá',async()=>{
 const {aprovar,relay,local,remoto}=await montar({local:{threads:{}},remoto:{threads:{'llm-center':'app'}}});const {l}=await aprovar();
 for(const [action,type] of [['thread.settle','thread.settle'],['thread.unsettle','thread.unsettle']]){
  const r=await relay({op:'dispatch',ambiente:'remoto',leaseId:l.leaseId,action,operationId:`${action}-1`,input:{threadId:'llm-center'}});
  assert.equal(r.state,'completed');assert.equal(remoto.calls.filter(x=>x.m).at(-1).p.type,type);
 }
 await assert.rejects(relay({op:'dispatch',ambiente:'local',leaseId:l.leaseId,action:'thread.settle',operationId:'x',input:{threadId:'llm-center'}}),/thread_not_found/);
 assert.equal(local.calls.filter(x=>x.m).length,0);
});

test('pedido leva o inventário completo do environment, sem filtro nem allowlist',async()=>{
 const projetos=[{id:'app',name:'app',directory:'/h/app'},{id:'mcp-project:web',name:'app.example',directory:'/h/app.example'},
  ...Array.from({length:30},(_,i)=>({id:`mcp-project:issue-${i}`,name:`app.example-issue-${i}`,directory:`/h/app.example/.worktrees/issue-${i}`}))];
 const {aprovar,relay,remoto}=await montar({remoto:{projetos,threads:{'t-issue':'mcp-project:issue-7'}}});
 const {r,l}=await aprovar();
 const grant=r.scope.environments.find(e=>e.alias==='remoto');
 assert.equal(grant.projects.length,32);
 assert.ok(grant.projects.some(p=>p.name==='app.example'));
 assert.equal(grant.projects.filter(p=>p.name.startsWith('app.example-issue-')).length,30);
 assert.deepEqual(grant.readProjectIds.length,32);
 const lido=JSON.parse((await relay({op:'read',ambiente:'remoto',leaseId:l.leaseId,operation:'t3_projetos',input:{}})).content[0].text);
 assert.ok(lido.projects.some(p=>p.title==='app.example-issue-7@remoto'));
 const w=await relay({op:'dispatch',ambiente:'remoto',leaseId:l.leaseId,action:'thread.settle',operationId:'issue-settle',input:{threadId:'t-issue'}});
 assert.equal(w.state,'completed');assert.equal(remoto.calls.filter(x=>x.m).length,1);
});

test('environment fora do ar no pedido fica fora do escopo e a lease não vale nele',async()=>{
 const {aprovar,relay,remoto}=await montar({remoto:{falhaInventario:true}});const {r,l}=await aprovar();
 assert.deepEqual(r.scope.environments.map(e=>e.alias),['local']);
 assert.deepEqual(r.indisponiveis,[{alias:'remoto',environmentId:'env-s',motivo:'ambiente_indisponivel'}]);
 await assert.rejects(relay({op:'dispatch',ambiente:'remoto',leaseId:l.leaseId,...send()}),/ambiente_fora_da_lease/);
 assert.equal(remoto.calls.length,0);
});

test('ação fora do grant daquele environment é negada mesmo se o outro a tiver',async()=>{
 const {aprovar,relay,remoto}=await montar({remoto:{acoes:['thread.send']}});const {l}=await aprovar();
 await assert.rejects(relay({op:'dispatch',ambiente:'remoto',leaseId:l.leaseId,action:'thread.settle',operationId:'s',input:{threadId:'thread'}}),/scope_denied/);
 assert.equal(remoto.calls.length,0);
});

test('status não cria pedido e consulta de lease ativa não renova nem amplia',async()=>{
 const {aprovar,relay}=await montar();
 assert.deepEqual(await relay({op:'status'}),{active:false});
 const {l}=await aprovar();
 const st=await relay({op:'request'});
 assert.equal(st.leaseId,l.leaseId);assert.equal(st.active,true);
 assert.deepEqual(st.ambientes.map(a=>a.alias),['local','remoto']);
});

test('leitura protegida usa o grant e o servidor do environment escolhido',async()=>{
 const {aprovar,relay}=await montar();const {l}=await aprovar();
 const r=await relay({op:'read',ambiente:'remoto',leaseId:l.leaseId,operation:'t3_projetos',input:{}});
 const dados=JSON.parse(r.content[0].text);
 assert.equal(dados.environment.alias,'remoto');
 assert.ok(dados.projects.every(p=>p.directory.startsWith('/remoto/')));
 await assert.rejects(relay({op:'read',ambiente:'remoto',leaseId:'outra',operation:'t3_projetos',input:{}}),/lease_closed/);
 await assert.rejects(relay({op:'read',ambiente:'remoto',leaseId:l.leaseId,operation:'t3_aguardar_thread',input:{}}),/action_unavailable/);
});

test('reconcile fica no environment da operação',async()=>{
 const {aprovar,relay}=await montar();const {l}=await aprovar();
 await relay({op:'dispatch',ambiente:'remoto',leaseId:l.leaseId,...send()});
 const r=await relay({op:'reconcile',ambiente:'remoto',leaseId:l.leaseId,operationId:'op-1'});
 assert.equal(r.state,'completed');assert.deepEqual(r.ambiente,{alias:'remoto',environmentId:'env-s'});
 await assert.rejects(relay({op:'reconcile',ambiente:'local',leaseId:l.leaseId,operationId:'op-1'}),/operation_unknown/);
});

test('config de escrita: destino lógico estável, ações válidas e sem environment padrão',()=>{
 const base={porta:7433,estado:'~/x',canal:{organization:'my-org',tunnelId:'tunnel_abc'},ambientes:{remoto:{environmentId:'env-s',ssh:{host:'remoto'},tokenFile:'~/t'}}};
 const c=validarConfigEscrita(base);
 assert.equal(c.ambientes[0].destination,'t3://env-s');
 for(const campo of ['projetos','acoes'])assert.throws(()=>validarConfigEscrita({...base,ambientes:{remoto:{...base.ambientes.remoto,[campo]:['x']}}}),/não é suportado/);
 assert.equal(c.ambientes[0].acoes.length,42);
 assert.throws(()=>validarConfigEscrita({...base,ambientes:{remoto:{...base.ambientes.remoto,url:'http://127.0.0.1:1'}}}),/exatamente um/);
 assert.throws(()=>validarConfigEscrita({...base,canal:{organization:'x',tunnelId:'nope'}}),/channel/);
});

test('config de escrita: rótulos da passkey são opcionais e validados',()=>{
 const base={porta:7433,estado:'~/x',canal:{organization:'my-org',tunnelId:'tunnel_abc'},ambientes:{remoto:{environmentId:'env-s',ssh:{host:'remoto'},tokenFile:'~/t'}}};
 assert.deepEqual(validarConfigEscrita(base).passkey,{});
 assert.deepEqual(validarConfigEscrita({...base,passkey:{rpName:'Minha ponte',userName:'eu'}}).passkey,{rpName:'Minha ponte',userName:'eu'});
 assert.throws(()=>validarConfigEscrita({...base,passkey:{rpName:''}}),/passkey.rpName/);
 assert.throws(()=>validarConfigEscrita({...base,passkey:{userName:'x'.repeat(65)}}),/passkey.userName/);
});
