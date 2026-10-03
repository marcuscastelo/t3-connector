import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Dispatcher,parseAction} from '../src/escrita/adapters.mjs';
import {criarPonteEscrita} from '../src/escrita/ponte-mcp.mjs';
import {setup,memoryJournal} from './escrita-fixtures.mjs';
import {sendCases,unsafeSendCases} from './escrita-send-fixtures.mjs';
async function ponte(relay) {
 const server=criarPonteEscrita({relay,aliases:['remoto'],approvalOrigin:'http://localhost:7433'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);
 const client=new Client({name:'send-contract',version:'1'});await client.connect(a);
 return {client,close:async()=>{await client.close();await server.close();}};
}
test('tools/list exposes temporal consequences and conditional requirements to ChatGPT',async()=>{
 const p=await ponte(async()=>({}));try {
  const tool=(await p.client.listTools()).tools.find(t=>t.name==='t3_escrever_thread_send');
  assert.match(tool.description,/Correction.*steer_active.*targetRunId/);
  const schema=tool.inputSchema.properties.input;
  const branches=schema.oneOf??schema.anyOf;assert.equal(branches.length,4);
  const modes=new Map(branches.map(b=>[b.properties.delivery.const,b]));
  for(const mode of ['steer_active','restart_active'])assert.ok(modes.get(mode).required.includes('targetRunId'));
  assert.ok(modes.get('queue_after_active').required.includes('deferUntilActiveCompletes'));
  assert.equal(modes.get('queue_after_active').properties.deferUntilActiveCompletes.const,true);
  assert.match(modes.get('queue_after_active').properties.delivery.description,/does not change the current run/);
  assert.match(modes.get('start_immediately').properties.delivery.description,/turn this into a queued message/);
  assert.match(modes.get('restart_active').properties.delivery.description,/does not undo/);
  assert.match(modes.get('steer_active').properties.delivery.description,/without waiting for it to finish/);
  for(const b of branches)assert.equal(b.additionalProperties,false);
 } finally {await p.close();}
});
for(const c of sendCases)test(`safe intent: ${c.intent}`,()=>{
 const p=parseAction('thread.send',c.input),wire=p.spec.encode(p.input);
 assert.deepEqual(wire.dispatchMode,c.wire);
 assert.equal(wire.deferUntilActiveCompletes,undefined,'confirmation is connector-only');
 assert.equal(wire.commandId,'op');assert.equal(wire.messageId,'op');
});
for(const [i,c] of unsafeSendCases.entries())test(`unsafe send ${i}: ${c.error} before journal/outbound`,async()=>{
 const s=setup(),lease=await s.grant();let calls=0,reservations=0;
 const journal=memoryJournal(),reserve=journal.reserve;journal.reserve=(...a)=>{reservations++;return reserve(...a);};
 const adapter={projectForThread:async()=>{calls++;return 'app';},invoke:async()=>{calls++;}};
 const d=new Dispatcher({gate:s.gate,adapter,journal,environmentId:s.env.environmentId,destination:s.env.destination});
 await assert.rejects(d.dispatch(s.caller,lease.leaseId,{operationId:'op',action:'thread.send',input:c.input}),new RegExp(c.error));
 assert.equal(calls,0);assert.equal(reservations,0);assert.equal(s.gate.status(lease.leaseId).active,true);
});
test('MCP schema rejects missing run and implicit queue with useful messages before relay',async()=>{
 let calls=0;const p=await ponte(async()=>{calls++;return {};});try {
  for(const [delivery,message] of [['steer_active',/targetRunId required/],['restart_active',/targetRunId required/],['queue_after_active',/queue_after_active requires explicit intent/]]) {
   const r=await p.client.callTool({name:'t3_escrever_thread_send',arguments:{leaseId:'l',ambiente:'remoto',operationId:'op',input:{threadId:'t',text:'fix',clientRequestId:'op',delivery}}});
   assert.equal(r.isError,true);assert.match(r.content[0].text,message);
  }
  assert.equal(calls,0);
 } finally {await p.close();}
});
test('safe validation codes survive relay as actionable messages, without rejected input text',async()=>{
 const p=await ponte(async()=>{throw new Error('target_run_id_required');});try {
  const r=await p.client.callTool({name:'t3_escrever_thread_send',arguments:{leaseId:'l',ambiente:'remoto',operationId:'op',input:sendCases[0].input}});
  assert.equal(r.isError,true);assert.match(r.content[0].text,/targetRunId required.*t3_thread/);
 } finally {await p.close();}
 const q=await ponte(async()=>{throw new Error('queue_explicit_intent_required');});try {
  const r=await q.client.callTool({name:'t3_escrever_thread_send',arguments:{leaseId:'l',ambiente:'remoto',operationId:'op',input:sendCases[4].input}});
  assert.equal(r.isError,true);assert.match(r.content[0].text,/explicit request to defer.*steer_active/);
 } finally {await q.close();}
});
test('no automatic default, mismatched target or confirmation on other modes',()=>{
 assert.throws(()=>parseAction('thread.send',{...sendCases[2].input,delivery:undefined}));
 assert.throws(()=>parseAction('thread.send',{...sendCases[2].input,targetRunId:'run'}));
 assert.throws(()=>parseAction('thread.send',{...sendCases[0].input,deferUntilActiveCompletes:true}));
});
