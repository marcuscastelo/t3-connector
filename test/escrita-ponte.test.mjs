import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {criarPonteEscrita} from '../src/escrita/ponte-mcp.mjs';
import {criarConexaoEscrita} from '../src/escrita/conexao.mjs';
import {ACTIONS} from '../src/escrita/adapters.mjs';

async function ponte(relay) {
 const server=criarPonteEscrita({relay,aliases:['local','remoto'],approvalOrigin:'http://localhost:7433'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);
 const c=new Client({name:'t',version:'0'});await c.connect(a);return c;
}

test('catálogo: 42 escritas, aprovação, 7 leituras de um environment, 3 multi, preflight e reconcile; environment obrigatório em todas as que tocam um environment',async()=>{
 const c=await ponte(async()=>({}));
 const {tools}=await c.listTools();
 assert.equal(tools.length,ACTIONS.length+13);
 const multi=['t3_ambientes','t3_thread_find_batch','t3_workset'];
 for(const t of tools.filter(t=>t.name!=='t3_pedir_aprovacao'&&!multi.includes(t.name))){assert.ok(t.inputSchema.required.includes('environment'),t.name);assert.equal('ambiente' in t.inputSchema.properties,false,t.name);}
 // Multi-environment reads take `environments` (optional filter) and always the lease.
 for(const name of multi){const t=tools.find(t=>t.name===name);assert.ok(t,name);assert.ok(t.inputSchema.required.includes('leaseId'),name);assert.equal('environment' in t.inputSchema.properties,false,name);}
 assert.ok(!tools.some(t=>/dispatchCommand|rpc/.test(t.name)));
});

test('repassa o ambiente ao relay e explica erros de roteamento',async()=>{
 const pedidos=[];
 const c=await ponte(async req=>{pedidos.push(req);if(req.ambiente==='inexistente')throw new Error('ambiente_desconhecido');if(req.ambiente==='remoto'&&req.leaseId==='velha')throw new Error('ambiente_fora_da_lease');return {ambiente:{alias:req.ambiente},state:'completed'};});
 const args={leaseId:'l',operationId:'op',input:{threadId:'t',text:'oi',clientRequestId:'op',delivery:'start_immediately'}};
 const ok=await c.callTool({name:'t3_escrever_thread_send',arguments:{...args,environment:'remoto'}});
 assert.equal(ok.isError,undefined);assert.equal(pedidos[0].ambiente,'remoto');assert.equal(pedidos[0].op,'dispatch');
 const inexistente=await c.callTool({name:'t3_escrever_thread_send',arguments:{...args,environment:'inexistente'}});
 assert.match(inexistente.content[0].text,/^environment_unknown: .*configured: local, remoto/);
 const fora=await c.callTool({name:'t3_escrever_thread_send',arguments:{...args,leaseId:'velha',environment:'remoto'}});
 assert.match(fora.content[0].text,/^environment_not_in_lease: /);
 const sem=await c.callTool({name:'t3_escrever_thread_send',arguments:args});
 assert.equal(sem.isError,true,'sem ambiente o schema recusa');
 assert.equal(pedidos.filter(p=>p.op==='dispatch'&&!p.ambiente).length,0);
});

test('pedido de aprovação lista environments incluídos e indisponíveis',async()=>{
 const c=await ponte(async()=>({requestId:'R',scopeHash:'h',scope:{environments:[{alias:'local',environmentId:'p',projects:[1],actions:[1,2]}]},indisponiveis:[{alias:'remoto',environmentId:'s',motivo:'ambiente_indisponivel'}]}));
 const r=JSON.parse((await c.callTool({name:'t3_pedir_aprovacao',arguments:{}})).content[0].text);
 assert.equal(r.approvalUrl,'http://localhost:7433/#request=R');
 assert.deepEqual(r.environments,[{alias:'local',environmentId:'p',projectCount:1,actionCount:2}]);
 assert.deepEqual(r.unavailableEnvironments,[{alias:'remoto',environmentId:'s',reason:'environment_unavailable'}]);
 assert.equal('ambientes' in r||'indisponiveis' in r,false);
});

// Servidor T3 falso: HTTP (identidade, shell, ticket) e WS que responde Exit Success.
function servidorFalso({environmentId='env-s',escopos=['orchestration:read','orchestration:operate'],threads={'llm':'app'}}={}) {
 const sockets=[];
 class SocketFalso extends EventEmitter {
  constructor(url){super();this.url=url;this.readyState=0;this.enviados=[];sockets.push(this);setTimeout(()=>{this.readyState=1;this.emit('open');},1);}
  addEventListener(ev,fn,o){(o?.once?this.once:this.on).call(this,ev,e=>fn(e));}
  send(data){const f=JSON.parse(data);this.enviados.push(f);if(f._tag==='Request'&&!this.mudo)setTimeout(()=>this.emit('message',{data:JSON.stringify({_tag:'Exit',requestId:f.id,exit:{_tag:'Success',value:{sequence:42}}})}),1);}
  close(){this.readyState=3;this.emit('close');}
 }
 const cliente=()=>({ambiente:async()=>({orchestrationProtocolVersion:2,environmentId,label:'remoto',serverVersion:'v'}),sessao:async()=>({scopes:escopos}),
  shell:async()=>({projects:[{id:'app',title:'app',workspaceRoot:'/home/dev/app'}],threads:Object.entries(threads).map(([id,projectId])=>({id,projectId}))}),ticketWs:async()=>'ticket'});
 return {sockets,SocketFalso,cliente};
}
const registro={alias:'remoto',environmentId:'env-s',ssh:{host:'remoto'},tokenFile:'/x',destination:'t3://env-s'};
const transporte=()=>{const t={descartes:0,baseUrl:async()=>'http://127.0.0.1:43773',descartar(){t.descartes++;},fechar(){}};return t;};

test('conexão: exige read+operate exatos e o environmentId certo',async()=>{
 for(const [opcoes,erro] of [[{escopos:['orchestration:read']},/without scope orchestration:operate/],[{escopos:['orchestration:read','orchestration:operate','terminal:operate']},/extra scopes/],[{environmentId:'env-p'},/expected env-s/]]){
  const f=servidorFalso(opcoes);
  const c=criarConexaoEscrita(registro,{transporte:transporte(),lerToken:()=>'t',criarClienteImpl:f.cliente,WebSocketImpl:f.SocketFalso});
  await assert.rejects(c.verificar(),erro);
 }
});

test('conexão: WS sob demanda, socket perdido deixa a operação incerta e só a próxima abre outro',async()=>{
 const f=servidorFalso(),t=transporte();
 const remotos=[];
 const c=criarConexaoEscrita(registro,{transporte:t,lerToken:()=>'t',criarClienteImpl:f.cliente,WebSocketImpl:f.SocketFalso,realpathRemotoImpl:async(host,p)=>{remotos.push([host,p]);return p==='/home/dev/link'?'/home/dev/app':p==='/home/dev/fora'?'/etc':null;}});
 assert.equal(f.sockets.length,0);
 assert.equal(await c.adapter.projectForThread('llm'),'app');
 await c.adapter.prepare();
 assert.match(f.sockets[0].url,/^ws:\/\/127\.0\.0\.1:43773\/ws\?orchestrationProtocol=2&wsTicket=ticket$/);
 assert.deepEqual(await c.adapter.invoke('orchestration.dispatchCommand',{type:'thread.settle'}),{sequence:42});
 f.sockets[0].mudo=true;
 const pendente=c.adapter.invoke('orchestration.dispatchCommand',{type:'thread.settle'});
 f.sockets[0].close();
 await assert.rejects(pendente,/control_transport_uncertain/);
 assert.throws(()=>c.adapter.invoke('orchestration.dispatchCommand',{}),/ambiente_indisponivel/);
 await c.adapter.prepare();
 assert.equal(f.sockets.length,2);
 assert.equal(f.sockets[1].enviados.length,0,'nada reenviado no socket novo');
 assert.equal(await c.adapter.verifyWorkspace('/home/dev/link',['/home/dev/app']),true,'realpath no host remoto igual ao root aprovado');
 assert.equal(await c.adapter.verifyWorkspace('/home/dev/fora',['/home/dev/app']),false);
 assert.equal(await c.adapter.verifyWorkspace('/home/dev/inexistente',['/home/dev/app']),false);
 assert.deepEqual(remotos.map(([h])=>h),['remoto','remoto','remoto']);
 c.fechar();
});

test('realpath remoto: um argumento ssh com o caminho entre aspas, sem interpolação',async()=>{
 const {realpathRemoto}=await import('../src/escrita/conexao.mjs');
 let args;
 const r=await realpathRemoto('remoto',"/home/dev/a b'; rm -rf ~",{execFileImpl:(cmd,a,o,cb)=>{args=[cmd,a];cb(null,'/home/dev/x\n');}});
 assert.equal(r,'/home/dev/x');assert.equal(args[0],'ssh');
 assert.equal(args[1].at(-1),`realpath -e -- '/home/dev/a b'\\''; rm -rf ~'`);
 assert.equal(args[1].at(-2),'remoto');
});

test('conexão: leitura repete uma vez quando o transporte caiu, com transporte recriado',async()=>{
 const f=servidorFalso(),t=transporte();let falhas=1;
 const cliente=()=>{const base=f.cliente();return {...base,shell:async()=>{if(falhas-->0){const {ErroT3}=await import('../src/t3.mjs');throw new ErroT3('T3 indisponível',{codigo:'indisponivel'});}return base.shell();}};};
 const c=criarConexaoEscrita(registro,{transporte:t,lerToken:()=>'t',criarClienteImpl:cliente,WebSocketImpl:f.SocketFalso});
 assert.equal(await c.adapter.projectForThread('llm'),'app');
 assert.equal(t.descartes,1,'túnel descartado e recriado');
});
