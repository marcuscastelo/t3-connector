import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {criarPonteEscrita} from '../src/escrita/ponte-mcp.mjs';
import {Dispatcher} from '../src/escrita/adapters.mjs';
import {StagingRpcTransport} from '../src/escrita/transport-staging.mjs';
import {setup,memoryJournal} from './escrita-fixtures.mjs';

const selection={instanceId:'claudeAgent_custom',model:'claude-opus-5-5'};
async function isolated(t,{failure=false}={}) {
 const s=setup();s.env.actions.push('thread.model-selection.set');const lease=await s.grant();
 const frames=[],listeners=new Map();
 const socket={url:'wss://isolated.invalid/ws?orchestrationProtocol=2',readyState:1,
  addEventListener:(name,fn)=>listeners.set(name,fn),close:()=>{},
  send(data) {
   const frame=JSON.parse(data);frames.push(frame);
   queueMicrotask(()=>listeners.get('message')({data:JSON.stringify({_tag:'Exit',requestId:frame.id,
    exit:failure?{_tag:'Failure',cause:{private:'must not leak'}}:{_tag:'Success',value:frame.tag==='orchestration.launchThread'?{threadId:frame.payload.threadId,projection:{},resumed:false}:{sequence:1}}})}));
  }};
 const rpc=new StagingRpcTransport({socket,onFailure:()=>{}});
 const adapter={invoke:(...args)=>rpc.invoke(...args),receipt:r=>rpc.receipt(r),projectForThread:async()=>'app'};
 const dispatcher=new Dispatcher({gate:s.gate,adapter,journal:memoryJournal(),environmentId:s.env.environmentId,destination:s.env.destination});
 let relays=0;
 const server=criarPonteEscrita({aliases:['isolated'],approvalOrigin:'https://approval.example.test',relay:async req=>{
  relays++;assert.equal(req.ambiente,'isolated');
  // Exercise the same JSON round trip as the private HTTP relay.
  return dispatcher.dispatch(s.caller,req.leaseId,JSON.parse(JSON.stringify(req)));
 }});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);
 const client=new Client({name:'isolated-launch-regression',version:'1'});await client.connect(a);
 t.after(async()=>{await client.close();await server.close();rpc.close();});
 return {client,frames,lease,relays:()=>relays};
}

test('tools/list publishes the same open model selection for launch and set',async t=>{
 const p=await isolated(t);const {tools}=await p.client.listTools();
 const model=name=>tools.find(t=>t.name===name).inputSchema.properties.input.properties.modelSelection;
 assert.deepEqual(tools.find(t=>t.name==='t3_escrever_thread_launch').annotations,tools.find(t=>t.name==='t3_escrever_thread_model_selection_set').annotations);
 const launch=model('t3_escrever_thread_launch');assert.deepEqual(launch,model('t3_escrever_thread_model_selection_set'));
 assert.deepEqual(launch.required,['instanceId','model']);
 for(const key of ['instanceId','model']) {
  assert.equal(launch.properties[key].type,'string');assert.equal(launch.properties[key].enum,undefined);
  assert.equal(launch.properties[key].const,undefined);
  assert.match(launch.properties[key].description,/Exact model ID|Exact ID/);
 }
});

for(const text of [undefined,'isolated initial message'])for(const options of [undefined,[{id:'effort',value:'high'}]]) {
 test(`direct custom-instance launch reaches RPC unchanged (text=${text!==undefined}, options=${options!==undefined})`,async t=>{
  const p=await isolated(t),modelSelection={...selection,...(options?{options}:{})};
  const result=await p.client.callTool({name:'t3_escrever_thread_launch',arguments:{leaseId:p.lease.leaseId,ambiente:'isolated',operationId:'direct-launch',
   input:{projectId:'app',title:'isolated launch',modelSelection,workspaceStrategy:{type:'root'},...(text!==undefined?{text}:{})}}});
  assert.equal(result.isError,undefined);assert.equal(JSON.parse(result.content[0].text).state,'completed');
  assert.equal(p.frames.length,1);assert.equal(p.relays(),1);
  const frame=p.frames[0];assert.equal(frame.tag,'orchestration.launchThread');assert.deepEqual(frame.payload.modelSelection,modelSelection);
  assert.equal(frame.payload.runtimeMode,'full-access');assert.equal(frame.payload.interactionMode,'default');
  assert.equal(frame.payload.initialMessage?.text,text);assert.equal(frame.payload.text,undefined);
  assert.equal(frame.payload.initialMessage===undefined,text===undefined);
  const changed=await p.client.callTool({name:'t3_escrever_thread_model_selection_set',arguments:{leaseId:p.lease.leaseId,ambiente:'isolated',operationId:'set-model',input:{threadId:frame.payload.threadId,modelSelection}}});
  assert.equal(changed.isError,undefined);assert.equal(p.frames[1].tag,'orchestration.dispatchCommand');
  assert.equal(p.frames[1].payload.type,'thread.model-selection.set');assert.deepEqual(p.frames[1].payload.modelSelection,frame.payload.modelSelection);
 });
}

test('upstream RPC failure remains uncertain, never leaks details or retries launch',async t=>{
 const p=await isolated(t,{failure:true});const args={leaseId:p.lease.leaseId,ambiente:'isolated',operationId:'failed-launch',input:{projectId:'app',title:'isolated',modelSelection:selection,workspaceStrategy:{type:'root'}}};
 const result=await p.client.callTool({name:'t3_escrever_thread_launch',arguments:args});
 assert.equal(result.isError,true);assert.match(result.content[0].text,/^reconciliation_required:.*tried to send to T3.*does not prove.*do not retry/i);assert.doesNotMatch(result.content[0].text,/must not leak/);
 await p.client.callTool({name:'t3_escrever_thread_launch',arguments:args});assert.equal(p.frames.length,1);
});

 test('pre-send rejection identifies bridge preparation without claiming a model block',async t=>{
 const server=criarPonteEscrita({aliases:['isolated'],approvalOrigin:'https://approval.example.test',relay:async()=>{throw new Error('dispatch_rejected');}});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);
 const client=new Client({name:'pre-send-error',version:'1'});await client.connect(a);
 t.after(async()=>{await client.close();await server.close();});
 const result=await client.callTool({name:'t3_escrever_thread_launch',arguments:{leaseId:'fake',ambiente:'isolated',operationId:'pre-send',input:{projectId:'app',title:'isolated',modelSelection:selection,workspaceStrategy:{type:'root'}}}});
 assert.equal(result.isError,true);assert.match(result.content[0].text,/^dispatch_rejected:.*before sending it to T3.*does not mean the model is blocked/);
 });
