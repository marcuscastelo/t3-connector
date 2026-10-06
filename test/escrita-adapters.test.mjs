import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher,ACTIONS,parseAction } from '../src/escrita/adapters.mjs';
import { FileJournal } from '../src/escrita/journal.mjs';
import { setup } from './escrita-fixtures.mjs';
import { memoryJournal } from './escrita-fixtures.mjs';
function dispatcher(s,adapter,journal=memoryJournal()) {return new Dispatcher({gate:s.gate,adapter,journal,environmentId:s.env.environmentId,destination:s.env.destination});}
const send={operationId:'req1',action:'thread.send',input:{threadId:'thread',text:'hello',clientRequestId:'req1',delivery:'start_immediately'}};
function adapter() {const calls=[];return {calls,verifyWorkspace:async()=>true,projectForThread:async()=> 'app',invoke:async(method,payload)=>{calls.push({method,payload});return {sequence:10};},receipt:r=>({sequence:r.sequence}),reconcile:async()=>({found:true})};}
test('explicit launch adapter defaults to full-access/default; no generic RPC',()=>{const p=parseAction('thread.launch',{projectId:'app',title:'work',modelSelection:{instanceId:'codex',model:'model'},workspaceStrategy:{type:'root'},text:'task'});const wire=p.spec.encode(p.input);assert.equal(wire.runtimeMode,'full-access');assert.equal(wire.interactionMode,'default');assert.equal(p.spec.method,'orchestration.launchThread');assert.throws(()=>parseAction('arbitrary.rpc',{}));assert.throws(()=>parseAction('thread.launch',{...p.input,runtimeMode:'auto',type:'anything'}));});
test('native runtime modes reach dispatch unchanged; omission keeps legacy full-access and invalid modes never send',async()=>{
 const inputs={
  'thread.launch':{projectId:'app',title:'work',modelSelection:{instanceId:'codex',model:'model'},workspaceStrategy:{type:'root'}},
  'delegated_task.request':{parentThreadId:'thread',parentRunId:'run',parentNodeId:'node',task:'task',modelSelection:{instanceId:'codex',model:'model'}},
  'thread.runtime-mode.set':{threadId:'thread'},
 };
 for(const [action,input] of Object.entries(inputs)) {
  const s=setup();if(!s.env.actions.includes(action))s.env.actions.push(action);
  const l=await s.grant(),a=adapter(),d=dispatcher(s,a);
  for(const [i,mode] of [undefined,'approval-required','auto-accept-edits','auto','full-access'].entries()) {
   await d.dispatch(s.caller,l.leaseId,{operationId:`mode-${i}`,action,input:{...input,...(mode===undefined?{}:{runtimeMode:mode})}});
   assert.equal(a.calls.at(-1).payload.runtimeMode,mode??'full-access',action);
   if(action!=='thread.runtime-mode.set')assert.equal(a.calls.at(-1).payload.interactionMode,'default');
  }
  const before=a.calls.length;
  for(const runtimeMode of ['sandbox',null,1])await assert.rejects(d.dispatch(s.caller,l.leaseId,{operationId:'invalid',action,input:{...input,runtimeMode}}));
  assert.equal(a.calls.length,before);
 }
});
test('approval, dismissal and deletion map to exact V2 commands; stop fails closed',()=>{for(const [action,type,input] of [['runtime-request.approve','runtime-request.respond',{threadId:'t',requestId:'r',decision:'acceptForSession'}],['thread.user-input.dismiss','thread.user-input.dismiss',{threadId:'t',requestId:'r'}],['thread.delete','thread.delete',{threadId:'t'}]]){const p=parseAction(action,input);assert.equal(p.spec.encode(p.input).type,type);}assert.throws(()=>parseAction('thread.session.stop',{threadId:'t'}));});
test('send mapping retains stable server command/message ids and dedupes concurrency',async()=>{const s=setup(),l=await s.grant(),a=adapter(),d=dispatcher(s,a);const results=await Promise.all([d.dispatch(s.caller,l.leaseId,send),d.dispatch(s.caller,l.leaseId,send)]);assert.equal(a.calls.length,1);assert.equal(a.calls[0].payload.commandId,a.calls[0].payload.messageId);assert.notEqual(a.calls[0].payload.commandId,'req1');assert.ok(results.some(r=>r.state==='completed'));await d.dispatch(s.caller,l.leaseId,send);assert.equal(a.calls.length,1);await assert.rejects(d.dispatch(s.caller,l.leaseId,{...send,input:{...send.input,text:'different'}}),/operation_conflict/);});
test('lease rechecked after asynchronous target resolution',async()=>{const s=setup(),l=await s.grant(),a=adapter();a.projectForThread=async()=>{s.advance(3600000);return 'app';};await assert.rejects(dispatcher(s,a).dispatch(s.caller,l.leaseId,send));assert.equal(a.calls.length,0);});
test('revocation during preflight blocks outbound',async()=>{const s=setup(),l=await s.grant(),a=adapter();a.projectForThread=async()=>{s.gate.revoke(l.leaseId,l.credentialId);return 'app';};await assert.rejects(dispatcher(s,a).dispatch(s.caller,l.leaseId,send));assert.equal(a.calls.length,0);});
test('cross-project target is denied before invocation',async()=>{const s=setup(),l=await s.grant(),a=adapter();a.projectForThread=async()=> 'secret';await assert.rejects(dispatcher(s,a).dispatch(s.caller,l.leaseId,send));assert.equal(a.calls.length,0);});
test('lost response closes lease and persists uncertainty across restart; no retry',async()=>{const dir=mkdtempSync(join(tmpdir(),'t3-lease-'));try{const path=join(dir,'journal'),s=setup(),l=await s.grant(),a=adapter();a.invoke=async()=>{a.calls.push(1);throw new Error('network lost');};let j=new FileJournal(path),d=dispatcher(s,a,j);await assert.rejects(d.dispatch(s.caller,l.leaseId,send),/reconciliation_required/);assert.throws(()=>s.gate.status(l.leaseId),/lease_closed/);j.close();j=new FileJournal(path);const fresh=setup(),newLease=await fresh.grant();d=dispatcher(fresh,a,j);const result=await d.dispatch(fresh.caller,newLease.leaseId,send);assert.equal(result.state,'uncertain');assert.equal(a.calls.length,1);await d.reconcile(fresh.caller,newLease.leaseId,'req1');assert.equal(a.calls.length,1);j.close();}finally{rmSync(dir,{recursive:true});}});
test('create cannot be blindly retried after ambiguous result',async()=>{const s=setup(),l=await s.grant(),a=adapter(),journal=memoryJournal();a.invoke=async()=>{a.calls.push(1);throw new Error('lost');};const d=dispatcher(s,a,journal),input={projectId:'app',title:'task',modelSelection:{instanceId:'codex',model:'model'},workspaceStrategy:{type:'root'}};await assert.rejects(d.dispatch(s.caller,l.leaseId,{operationId:'create1',action:'thread.launch',input}));assert.equal(a.calls.length,1);});
test('audit failure closes authorization and prevents outbound',async()=>{const s=setup(),l=await s.grant();s.gate.audit=()=>{s.gate.close();throw new Error('audit_failed');};let invoked=false;assert.throws(()=>s.gate.dispatch(s.caller,l.leaseId,s.target,()=>invoked=true,'op'));assert.equal(invoked,false);});
test('separate SQLite handles reserve the same launch exactly once',async()=>{const dir=mkdtempSync(join(tmpdir(),'t3-cas-'));try{const s=setup(),l=await s.grant(),a=adapter(),j1=new FileJournal(join(dir,'journal')),j2=new FileJournal(join(dir,'journal'));const d1=dispatcher(s,a,j1),d2=dispatcher(s,a,j2),op={operationId:'create1',action:'thread.launch',input:{projectId:'app',title:'task',modelSelection:{instanceId:'codex',model:'model'},workspaceStrategy:{type:'root'}}};const results=await Promise.all([d1.dispatch(s.caller,l.leaseId,op),d2.dispatch(s.caller,l.leaseId,op)]);assert.equal(a.calls.length,1);assert.ok(results.some(r=>r.state==='completed'));j1.close();j2.close();}finally{rmSync(dir,{recursive:true});}});
test('unapproved workspace launch and metadata paths never reach outbound',async()=>{for(const action of ['thread.launch','thread.metadata.update']) {const s=setup();s.env.actions=[action];const l=await s.grant(),a=adapter(),d=dispatcher(s,a);const input=action==='thread.launch'?{projectId:'app',title:'task',modelSelection:{instanceId:'codex',model:'model'},workspaceStrategy:{type:'existing_worktree',worktreePath:'/unapproved/private'}}:{threadId:'thread',worktreePath:'/unapproved/private'};await assert.rejects(d.dispatch(s.caller,l.leaseId,{operationId:'op',action,input}));assert.equal(a.calls.length,0);}});
test('worktree roots explicitly approved are accepted; a new worktree is forwarded to T3 as is',async()=>{const s=setup();s.env.actions=['thread.launch'];s.env.projects[0].workspaceRoots=['/workspace/app','/worktrees/app'];const l=await s.grant(),a=adapter(),d=dispatcher(s,a),input={projectId:'app',title:'task',modelSelection:{instanceId:'codex',model:'model'},workspaceStrategy:{type:'existing_worktree',worktreePath:'/worktrees/app'}};await d.dispatch(s.caller,l.leaseId,{operationId:'op',action:'thread.launch',input});assert.equal(a.calls.length,1);await d.dispatch(s.caller,l.leaseId,{operationId:'op2',action:'thread.launch',input:{...input,workspaceStrategy:{type:'worktree',baseRef:'main',startFromOrigin:true}}});assert.equal(a.calls.length,2);assert.deepEqual(a.calls[1].payload.workspaceStrategy,{type:'worktree',baseRef:'main',startFromOrigin:true});await assert.rejects(d.dispatch(s.caller,l.leaseId,{operationId:'op3',action:'thread.launch',input:{...input,workspaceStrategy:{type:'existing_worktree',worktreePath:'/worktrees/other'}}}));assert.equal(a.calls.length,2);});
test('reconcile denies a new lease limited to another project/action',async()=>{const s=setup(),l=await s.grant(),a=adapter(),j=memoryJournal(),d=dispatcher(s,a,j);let reconciled=0;a.reconcile=async()=>{reconciled++;return {found:true};};await d.dispatch(s.caller,l.leaseId,send);s.gate.revoke(l.leaseId,l.credentialId);s.env.projects=s.env.projects.filter(p=>p.id==='t3');s.env.actions=['run.interrupt'];s.auth.credential.counter=1;const r=s.gate.request(s.caller,s.scope),c=s.gate.challenge(r.requestId,'https://approval.example.test'),next=await s.gate.approve(r.requestId,{response:s.auth.assertion(c,{counter:2}),origin:'https://approval.example.test'});await assert.rejects(d.reconcile(s.caller,next.leaseId,'req1'));assert.equal(reconciled,0);});
test('journal reservation failure closes leases before outbound',async()=>{const s=setup(),l=await s.grant(),a=adapter(),j=memoryJournal();j.reserve=()=>{throw new Error('disk full');};await assert.rejects(dispatcher(s,a,j).dispatch(s.caller,l.leaseId,send),/journal_failed/);assert.equal(a.calls.length,0);assert.throws(()=>s.gate.status(l.leaseId));});
test('reconcile rejects environment/destination changes before any observation',async()=>{for(const delta of [{environmentId:'other'},{destination:'other'}]) {const s=setup(),l=await s.grant(),a=adapter(),j=memoryJournal(),d=dispatcher(s,a,j);let read=0;a.reconcile=async()=>{read++;return {found:true};};await d.dispatch(s.caller,l.leaseId,send);s.gate.revoke(l.leaseId,l.credentialId);Object.assign(s.env,delta);const r=s.gate.request(s.caller,s.scope),c=s.gate.challenge(r.requestId,'https://approval.example.test'),next=await s.gate.approve(r.requestId,{response:s.auth.assertion(c,{counter:2}),origin:'https://approval.example.test'});await assert.rejects(d.reconcile(s.caller,next.leaseId,'req1'));assert.equal(read,0);}});
test('reconcile rejects a raw snapshot or leaked content, rechecks expiry after read',async()=>{for(const kind of ['leak','expiry']) {const s=setup(),l=await s.grant(),a=adapter(),d=dispatcher(s,a);await d.dispatch(s.caller,l.leaseId,send);a.reconcile=async()=>{if(kind==='expiry')s.advance(3600000);return kind==='leak'?{found:true,messages:['secret']}:{found:true};};await assert.rejects(d.reconcile(s.caller,l.leaseId,'req1'));}});
test('cached operation status also requires its original target scope',async()=>{const s=setup(),l=await s.grant(),a=adapter(),d=dispatcher(s,a);await d.dispatch(s.caller,l.leaseId,send);s.gate.revoke(l.leaseId,l.credentialId);s.env.projects=s.env.projects.filter(p=>p.id==='t3');const r=s.gate.request(s.caller,s.scope),c=s.gate.challenge(r.requestId,'https://approval.example.test'),next=await s.gate.approve(r.requestId,{response:s.auth.assertion(c,{counter:2}),origin:'https://approval.example.test'});await assert.rejects(d.dispatch(s.caller,next.leaseId,send));assert.equal(a.calls.length,1);});
test('workspace needs execution-domain verification; lexical traversal cannot bypass it',async()=>{for(const kind of ['missing','denied','traversal']){const s=setup();s.env.actions=['thread.metadata.update'];const l=await s.grant(),a=adapter();if(kind==='missing')delete a.verifyWorkspace;else a.verifyWorkspace=async()=>false;const input={threadId:'thread',worktreePath:kind==='traversal'?'/workspace/link/../app':'/workspace/app'};await assert.rejects(dispatcher(s,a).dispatch(s.caller,l.leaseId,{operationId:'op',action:'thread.metadata.update',input}));assert.equal(a.calls.length,0);}});
import { StagingRpcTransport } from '../src/escrita/transport-staging.mjs';
import { NativeRpcError } from '../src/escrita/native.mjs';
class FakeSocket extends EventTarget {
 readyState=1;url='wss://isolated-control.example.test/ws?orchestrationProtocol=2';sent=[];
 send(data){this.sent.push(JSON.parse(data));}
 receive(frame){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(frame)}));}
 close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
}
const inspectableJournal=()=>{const m=new Map();return {records:m,get:k=>m.get(k),put:(k,v)=>m.set(k,v),reserve:(k,v)=>{if(m.has(k))return false;m.set(k,v);return true;}};};
const untilSent=async(socket,n)=>{for(let i=0;i<200&&socket.sent.length<n;i++)await new Promise(r=>setTimeout(r,1));assert.equal(socket.sent.length,n);};
const TYPED={_tag:'OrchestrationV2DispatchCommandError',commandId:'c',commandType:'message.dispatch',message:'This thread still needs attention. Resolve or interrupt it first, then try again.',detail:'This thread still needs attention. Resolve or interrupt it first, then try again.',cause:{_tag:'Fail',error:{nested:'defect must not be copied'}}};
// Production incident (06/10/2026, Sirius): T3 answered four commands with a typed
// OrchestrationV2DispatchCommandError (its receipts say `rejected`); the connector treated each as a lost
// transport, marked the operation uncertain and ended every OAuth session (manual Reconnect + passkey).
// A typed answer proves T3 received the command, not that it had no effect: the operation stays
// uncertain (never resent), but the transport is healthy and no session or lease ends.
const TYPED_LAUNCH={_tag:'OrchestrationV2ThreadLaunchError',commandId:'c',projectId:'app',message:'Failed to launch thread',cause:{_tag:'Die',defect:'x'}};
const launch={operationId:'launch1',action:'thread.launch',input:{projectId:'app',title:'work',modelSelection:{instanceId:'codex',model:'model'},workspaceStrategy:{type:'root'}}};
test('typed T3 answer over the real transport: uncertain with T3 error, socket and lease kept, nothing resent, replay and reconcile carry the error',async()=>{
 for(const [op,typed,receipt] of [[send,TYPED,{sequence:11}],[launch,TYPED_LAUNCH,{threadId:'t2',projection:{},resumed:false}]]) {
  const s=setup(),l=await s.grant(),socket=new FakeSocket();let failures=0;
  const transport=new StagingRpcTransport({socket,onFailure:()=>failures++});
  const a=adapter();a.invoke=(m,p,o)=>transport.invoke(m,p,o);
  const journal=inspectableJournal(),d=dispatcher(s,a,journal);
  const p=d.dispatch(s.caller,l.leaseId,op);
  await untilSent(socket,1);
  socket.receive({_tag:'Exit',requestId:socket.sent[0].id,exit:{_tag:'Failure',cause:[{_tag:'Fail',error:typed}]}});
  await assert.rejects(p,e=>e.message==='reconciliation_required'&&e.native.code===typed._tag&&e.native.message===typed.message&&!('cause' in e.native));
  assert.equal(failures,0,'the socket is healthy: T3 answered');
  assert.equal(transport.available,true);
  assert.equal(s.gate.status(l.leaseId).active,true,'a typed answer costs no lease (and no OAuth session)');
  const record=[...journal.records.values()][0];
  assert.equal(record.state,'uncertain');assert.equal(record.error.code,typed._tag);assert.equal(record.receipt,undefined);
  assert.deepEqual(await d.dispatch(s.caller,l.leaseId,op),{state:'uncertain',operationId:op.operationId,reconciliationRequired:true,error:record.error});
  assert.equal(socket.sent.length,1,'a replay never resends');
  const r=await d.reconcile(s.caller,l.leaseId,op.operationId);
  assert.equal(r.state,'uncertain');assert.deepEqual(r.error,record.error);
  const next=d.dispatch(s.caller,l.leaseId,{...op,operationId:'again',input:op.action==='thread.send'?{...op.input,clientRequestId:'again'}:op.input});
  await untilSent(socket,2);
  socket.receive({_tag:'Exit',requestId:socket.sent[1].id,exit:{_tag:'Success',value:receipt}});
  assert.equal((await next).state,'completed');
 }
});
test('untyped failure frame over the real transport still fails closed: uncertain, lease ended, nothing resent',async()=>{
 const s=setup(),l=await s.grant(),socket=new FakeSocket();let failures=0;
 const transport=new StagingRpcTransport({socket,onFailure:()=>failures++});
 const a=adapter();a.invoke=(m,p,o)=>transport.invoke(m,p,o);
 const journal=inspectableJournal(),d=dispatcher(s,a,journal);
 const p=d.dispatch(s.caller,l.leaseId,send);
 await untilSent(socket,1);
 socket.receive({_tag:'Exit',requestId:socket.sent[0].id,exit:{_tag:'Failure',cause:[{_tag:'Die',defect:'boom'}]}});
 await assert.rejects(p,e=>e.message==='reconciliation_required'&&e.native===undefined);
 assert.equal(failures,1);assert.throws(()=>s.gate.status(l.leaseId),/lease_closed/);
 assert.equal([...journal.records.values()][0].state,'uncertain');
 await assert.rejects(d.dispatch(s.caller,l.leaseId,send));assert.equal(socket.sent.length,1);
});
test('typed answer during preflight (before the send) is a rejection and costs no lease',async()=>{
 const s=setup(),l=await s.grant(),a=adapter(),journal=inspectableJournal(),d=dispatcher(s,a,journal);
 a.invoke=async()=>{throw new NativeRpcError('OrchestrationV2DispatchCommandError','x',{});};
 // thread.send never reaches a native preflight; emulate the only other typed source before the send: resolveGrant.
 const d2=new Dispatcher({gate:s.gate,adapter:a,journal,environmentId:s.env.environmentId,destination:s.env.destination,resolveGrant:async()=>{throw new NativeRpcError('OrchestrationV2GetShellSnapshotError','shell unavailable',{});}});
 await assert.rejects(d2.dispatch(s.caller,l.leaseId,send),e=>e.native?.code==='OrchestrationV2GetShellSnapshotError');
 assert.equal([...journal.records.values()][0].state,'rejected');assert.equal(s.gate.status(l.leaseId).active,true);
});
test('typed T3 error persists in the file journal and is replayed after a restart without resending',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'t3-typed-'));
 try {
  const path=join(dir,'journal'),s=setup(),l=await s.grant(),a=adapter();
  a.invoke=async()=>{throw new NativeRpcError('OrchestrationV2DispatchCommandError','This thread still needs attention.',{commandType:'message.dispatch'});};
  let journal=new FileJournal(path),d=dispatcher(s,a,journal);
  await assert.rejects(d.dispatch(s.caller,l.leaseId,send),/reconciliation_required/);
  journal.close();journal=new FileJournal(path);
  const b=adapter(),d2=dispatcher(s,b,journal);
  const replay=await d2.dispatch(s.caller,l.leaseId,send);
  assert.equal(replay.state,'uncertain');assert.equal(replay.reconciliationRequired,true);assert.equal(replay.error.code,'OrchestrationV2DispatchCommandError');assert.equal(b.calls.length,0);
  journal.close();
 } finally {rmSync(dir,{recursive:true,force:true});}
});
