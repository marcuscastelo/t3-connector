import test from 'node:test';
import {fork,execFileSync} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {controller} from '../src/escrita/controller.mjs';
import {FileJournal} from '../src/escrita/journal.mjs';
import {Dispatcher} from '../src/escrita/adapters.mjs';
import {identidadeCanal,exigirIdentidade} from '../src/escrita/identidade.mjs';
import {criarPonteEscrita} from '../src/escrita/ponte-mcp.mjs';
import {conditionalSend,evaluatePrecondition,sameModel,manifestKey,CONDITIONAL_TOOL,conditionalSchema} from '../src/escrita/conditional.mjs';
const conditionalSchemaParse=i=>conditionalSchema.parse(i);
import {ACTIONS,chaveOperacao,parseAction} from '../src/escrita/adapters.mjs';
import {digest} from '../src/escrita/gate.mjs';
import {sessionWrites} from '../src/oauth/session-writes.mjs';
import {SessionAuthority} from '../src/oauth/session-authority.mjs';
import {consentAll} from '../src/oauth/project-policy.mjs';
import {grantFromInventory,escopoDosGrants} from '../src/escrita/scope.mjs';
import {setup,memoryJournal,ORIGIN,providersFor} from './escrita-fixtures.mjs';

const OPUS={instanceId:'claudeAgent',model:'claude-opus-5-5'};
const FAST={instanceId:'claudeAgent',model:'claude-opus-5-5',options:[{id:'fastMode',value:true}]};

// A T3 thread that follows the V2 rules the precondition depends on: model-selection.set changes
// the thread's model; message.dispatch start_immediately starts a run when none is active and
// otherwise queues it (CommandPolicy start_immediately → queue_after_active).
function fakeT3({status='completed',active=null,model=OPUS}={}) {
 const t3={calls:[],shellReads:0,runs:[{id:'r1',status:active==='r1'?'running':status,userMessageId:'m1',modelSelection:model}],
  thread:{id:'thread',projectId:'app',title:'t',latestRunId:'r1',status:active==='r1'?'running':status,activeRunId:active,modelSelection:model},
  hooks:{}};
 t3.startRun=(id,{userMessageId=`m-${id}`,modelSelection=t3.thread.modelSelection}={})=>{
  if(t3.thread.activeRunId){t3.runs.push({id,status:'queued',userMessageId,modelSelection});return;}
  t3.runs.push({id,status:'running',userMessageId,modelSelection});
  Object.assign(t3.thread,{latestRunId:id,status:'running',activeRunId:id});
 };
 t3.endRun=(final='completed')=>{const id=t3.thread.activeRunId;t3.runs.find(r=>r.id===id).status=final;Object.assign(t3.thread,{status:final,activeRunId:null});};
 t3.shell=async()=>{t3.shellReads++;await t3.hooks.shell?.(t3.shellReads);return structuredClone({projects:[{id:'app',title:'app',workspaceRoot:'/w/app'},{id:'other',title:'other',workspaceRoot:'/w/other'}],threads:[t3.thread,{id:'foreign',projectId:'other',latestRunId:'x',status:'completed',activeRunId:null}]});};
 t3.adapter={
  prepare:async()=>{await t3.hooks.prepare?.();},
  providers:async()=>providersFor(FAST),
  projectForThread:async id=>({thread:'app',foreign:'other'})[id],
  invoke:async(method,payload)=>{
   t3.calls.push(payload.type);
   await t3.hooks.invoke?.(payload);
   if(payload.type==='thread.model-selection.set'&&!t3.hooks.ignoreModel)t3.thread.modelSelection=payload.modelSelection;
   if(payload.type==='message.dispatch'){
    assert.deepEqual(payload.dispatchMode,{type:'start_immediately'});
    t3.startRun(`run-${t3.runs.length+1}`,{userMessageId:payload.messageId});
   }
   return {sequence:t3.calls.length};
  },
  receipt:r=>({sequence:r.sequence}),
  reconcile:async r=>({found:r.state==='completed',state:'unknown'}),
 };
 t3.cliente=async()=>({shell:t3.shell,threadCompleto:async()=>structuredClone({runs:t3.runs})});
 return t3;
}

async function leaseHarness(t3,{acoes=['thread.send','thread.model-selection.set','run.interrupt'],projetos,journal:base=memoryJournal()}={}) {
 const s=setup(),audit=[],journal={...base,audit:e=>audit.push(e)};
 const inventory={projetos};
 const conexao={registro:{alias:'local',environmentId:'env-p',destination:'t3://env-p',acoes},
  inventario:async()=>inventory.projetos??[{id:'app',name:'app',directory:'/w/app'},{id:'other',name:'other',directory:'/w/other'}],
  cliente:t3.cliente,adapter:t3.adapter,fechar(){}};
 const c=controller({conexoes:[conexao],passkeys:s.passkeys,journal,organization:'my-org',tunnelId:'tunnel_fixture'});
 let counter=0;
 const aprovar=async()=>{const r=await c.relay(c.capability,{op:'request'});const ch=c.gate.challenge(r.requestId,ORIGIN);return c.gate.approve(r.requestId,{response:s.auth.assertion(ch,{counter:++counter}),origin:ORIGIN});};
 const lease=await aprovar();
 const call=(input,{leaseId=lease.leaseId,operationId=input.clientRequestId}={})=>c.relay(c.capability,{op:'conditional-send',ambiente:'local',leaseId,operationId,input});
 return {c,s,journal,audit,lease,aprovar,call,inventory};
}
const req=(over={})=>({threadId:'thread',clientRequestId:'cs-1',afterRunId:'r1',modelSelection:FAST,text:'review the diff',...over});

test('canonical: after run r1 ended, applies Fast Mode then starts a run with it, auditable',async()=>{
 const t3=fakeT3(),h=await leaseHarness(t3);
 const r=await h.call(req());
 assert.equal(r.state,'completed');assert.deepEqual(r.ambiente,{alias:'local',environmentId:'env-p'});
 assert.deepEqual(t3.calls,['thread.model-selection.set','message.dispatch']);
 assert.deepEqual(r.steps.map(s=>[s.action,s.operationId,s.state]),[['thread.model-selection.set','cs-1:model-selection','completed'],['thread.send','cs-1:send','completed']]);
 assert.equal(r.delivery.deliveredAs,'started');assert.equal(r.delivery.runModelMatches,true);
 assert.deepEqual(r.observations.map(o=>[o.phase,o.verdict]),[['before_first_step','met'],['before_send','met']]);
 assert.equal(r.replayed,false);assert.equal(r.attempts,1);
 // Each step is an ordinary journaled write: reconcilable by its own operationId.
 const rec=await h.c.relay(h.c.capability,{op:'reconcile',ambiente:'local',leaseId:h.lease.leaseId,operationId:'cs-1:send'});
 assert.equal(rec.state,'completed');
 assert.ok(h.audit.some(e=>e.event==='dispatch'&&e.action==='thread.model-selection.set'));
 assert.ok(h.audit.some(e=>e.event==='conditional_send'&&e.state==='completed'&&e.steps.length===2));
});

test('without modelSelection only the send is dispatched and model.set is not required in the lease',async()=>{
 const t3=fakeT3(),h=await leaseHarness(t3,{acoes:['thread.send']});
 const r=await h.call(req({modelSelection:undefined}));
 assert.equal(r.state,'completed');assert.deepEqual(t3.calls,['message.dispatch']);
 const t4=fakeT3(),h4=await leaseHarness(t4,{acoes:['thread.send']});
 await assert.rejects(h4.call(req()),/scope_denied/);assert.deepEqual(t4.calls,[]);
});

test('idempotent retry replays the recorded result without a second send; a different input conflicts',async()=>{
 const t3=fakeT3(),h=await leaseHarness(t3);
 const first=await h.call(req());
 t3.endRun();// even with the thread idle again, the same request never sends twice
 const again=await h.call(req());
 assert.equal(again.replayed,true);assert.equal(again.state,'completed');assert.deepEqual(again.steps,first.steps);
 assert.deepEqual(t3.calls,['thread.model-selection.set','message.dispatch']);
 await assert.rejects(h.call(req({text:'other text'})),/operation_conflict/);
 await assert.rejects(h.call(req(),{operationId:'other-op'}),/request_id_mismatch/);
 assert.equal(t3.calls.length,2);
});

test('race: concurrent duplicate requests share one execution and one result',async()=>{
 const t3=fakeT3(),h=await leaseHarness(t3);
 const [a,b]=await Promise.all([h.call(req()),h.call(req())]);
 assert.deepEqual(a,b);assert.deepEqual(t3.calls,['thread.model-selection.set','message.dispatch']);
});

test('run still active: precondition_pending sends nothing; the same request completes once the run ends',async()=>{
 const t3=fakeT3({active:'r1'}),h=await leaseHarness(t3);
 const pending=await h.call(req());
 assert.equal(pending.state,'precondition_pending');assert.equal(pending.observations.at(-1).reason,'run_active');
 assert.match(pending.nextAction,/same clientRequestId/);assert.deepEqual(t3.calls,[]);
 t3.endRun();
 const done=await h.call(req());
 assert.equal(done.state,'completed');assert.equal(done.attempts,2);assert.equal(done.replayed,false);
 assert.deepEqual(t3.calls,['thread.model-selection.set','message.dispatch']);
});

test('run changed: another active run or a newer finished run fails the precondition, terminal, nothing sent',async()=>{
 for(const [prepare,reason] of [[t3=>{t3.endRun();t3.startRun('r2');},'other_run_active'],[t3=>{t3.endRun();t3.startRun('r2');t3.endRun();},'run_superseded']]) {
  const t3=fakeT3({active:'r1'}),h=await leaseHarness(t3);prepare(t3);
  const r=await h.call(req());
  assert.equal(r.state,'precondition_failed');assert.equal(r.reason,reason);assert.deepEqual(t3.calls,[]);
  if(t3.thread.activeRunId)t3.endRun();
  const replay=await h.call(req());// terminal: never re-evaluated into a send
  assert.equal(replay.state,'precondition_failed');assert.equal(replay.replayed,true);assert.deepEqual(t3.calls,[]);
 }
});

test('race between steps: a run started after the model change refuses the send instead of queueing',async()=>{
 const t3=fakeT3(),h=await leaseHarness(t3);
 t3.hooks.invoke=p=>{if(p.type==='thread.model-selection.set')t3.startRun('r-other');};
 const r=await h.call(req());
 assert.equal(r.state,'failed');assert.equal(r.failedStep,'thread.send');assert.equal(r.reason,'precondition_other_run_active');assert.equal(r.sent,false);
 // The send step is durably closed as refused before the answer says it was not sent.
 assert.deepEqual(r.steps.map(s=>[s.action,s.state,!!s.closed]),[['thread.model-selection.set','completed',false],['thread.send','rejected',true]]);
 assert.deepEqual(t3.calls,['thread.model-selection.set']);
 assert.match(r.nextAction,/remain applied/);
});

test('race inside T3: a run that appears after the last check is reported as queued, never hidden',async()=>{
 const t3=fakeT3(),h=await leaseHarness(t3);
 t3.hooks.invoke=p=>{if(p.type==='message.dispatch')t3.startRun('r-other');};
 const r=await h.call(req());
 assert.equal(r.state,'completed');assert.equal(r.delivery.deliveredAs,'queued_behind_active');assert.equal(r.delivery.runStatus,'queued');
 assert.equal(r.delivery.messageId,t3.runs.at(-1).userMessageId);
});

test('unsupported model option: refused at the model step with the exact reason, nothing sent',async()=>{
 const t3=fakeT3(),h=await leaseHarness(t3);
 const r=await h.call(req({modelSelection:{...OPUS,options:[{id:'reasoningEffort',value:'high'}]}}));
 assert.equal(r.state,'failed');assert.equal(r.failedStep,'thread.model-selection.set');assert.equal(r.reason,'model_option_unsupported');
 assert.match(r.detail,/option "reasoningEffort" is not offered.*Offered options: "fastMode" \(boolean\)/);
 assert.deepEqual(t3.calls,[]);assert.equal(h.c.gate.status(h.lease.leaseId).active,true);
});

test('step refused before sending: failed at that step, lease intact, later steps not sent',async()=>{
 const t3=fakeT3(),h=await leaseHarness(t3);
 t3.hooks.prepare=()=>{throw new Error('boom');};
 const r=await h.call(req());
 assert.equal(r.state,'failed');assert.equal(r.failedStep,'thread.model-selection.set');assert.equal(r.reason,'dispatch_rejected');
 assert.deepEqual(t3.calls,[]);assert.equal(h.c.gate.status(h.lease.leaseId).active,true);
 delete t3.hooks.prepare;
 const replay=await h.call(req());// terminal failure is replayed, not retried under the same id
 assert.equal(replay.state,'failed');assert.equal(replay.replayed,true);assert.deepEqual(t3.calls,[]);
});

test('scope: a thread outside the lease projects is refused before any step',async()=>{
 const t3=fakeT3(),h=await leaseHarness(t3,{projetos:[{id:'app',name:'app',directory:'/w/app'}]});
 await assert.rejects(h.call(req({threadId:'foreign'})),/thread_not_found|scope_denied/);
 assert.deepEqual(t3.calls,[]);
});

test('uncertain send: fails closed, never resent; retry under a new lease re-reads it as uncertain',async()=>{
 const t3=fakeT3(),h=await leaseHarness(t3);
 t3.hooks.invoke=p=>{if(p.type==='message.dispatch')throw new Error('socket closed');};
 const r=await h.call(req());
 assert.equal(r.state,'uncertain');assert.equal(r.failedStep,'thread.send');assert.match(r.nextAction,/reconcile/);
 assert.deepEqual(r.steps.map(s=>s.state),['completed','uncertain']);
 assert.throws(()=>h.c.gate.status(h.lease.leaseId),/lease_closed/,'uncertain send closes the lease');
 await assert.rejects(h.call(req()),/lease_closed/);
 delete t3.hooks.invoke;
 const lease=await h.aprovar();
 const replay=await h.call(req(),{leaseId:lease.leaseId});
 // uncertain is not final: the retry re-reads the step's journal (still uncertain) and never resends.
 assert.equal(replay.state,'uncertain');assert.equal(replay.failedOperationId,'cs-1:send');assert.match(replay.nextAction,/reconcile cs-1:send/);
 assert.deepEqual(t3.calls,['thread.model-selection.set','message.dispatch']);
});

// Serializes like FileJournal: a failed put leaves the stored record as it was.
function durableJournal() {
 const m=new Map();
 return {keys:()=>[...m.keys()],delete:k=>m.delete(k),get:k=>m.has(k)?JSON.parse(m.get(k)):undefined,reserve:(k,v)=>{if(m.has(k))return false;m.set(k,JSON.stringify(v));return true;},put:(k,v)=>{if(!m.has(k))throw new Error('operation_not_reserved');m.set(k,JSON.stringify(v));}};
}
// The Dispatcher commits a step before the manifest records it. An interruption in between must
// not make the resumed request deny a send that T3 already received.
for(const modelSelection of [FAST,undefined])test(`interrupted after a step committed but before the manifest saved it (${modelSelection?'with':'without'} model): resume reports the durable step, never 'nothing sent'`,async()=>{
 const t3=fakeT3(),mem=durableJournal();let interrupt=true;
 const journal={...mem,put(k,v){if(interrupt&&v.kind==='thread.conditional-send'&&v.steps.some(x=>x.action==='thread.send'&&x.state==='completed')){interrupt=false;throw new Error('interrupted');}return mem.put(k,v);}};
 const h=await leaseHarness(t3,{journal});
 await assert.rejects(h.call(req({modelSelection})),/journal_failed/);
 assert.equal(t3.calls.filter(c=>c==='message.dispatch').length,1);
 const lease=await h.aprovar();// the journal failure closed the lease
 const resumed=await h.call(req({modelSelection}),{leaseId:lease.leaseId});
 assert.equal(resumed.state,'completed');
 assert.equal(resumed.steps.find(x=>x.action==='thread.send').state,'completed');
 assert.ok(!('sent' in resumed)||resumed.sent!==false);
 assert.equal(t3.calls.filter(c=>c==='message.dispatch').length,1,'never sent twice');
 const rec=await h.c.relay(h.c.capability,{op:'reconcile',ambiente:'local',leaseId:lease.leaseId,operationId:'cs-1:send'});
 assert.equal(rec.state,'completed');
});

test('a separate write that reused a step operationId is a conflict, never adopted as the step',async()=>{
 const t3=fakeT3(),h=await leaseHarness(t3);
 await h.c.relay(h.c.capability,{op:'dispatch',ambiente:'local',leaseId:h.lease.leaseId,action:'thread.send',operationId:'cs-1:send',input:{threadId:'thread',clientRequestId:'cs-1:send',text:'something else',delivery:'start_immediately'}});
 await assert.rejects(h.call(req({modelSelection:undefined})),/operation_conflict/);
 assert.equal(t3.calls.length,1);
});

test('interrupted after the model step committed: resume adopts it and does not apply it twice',async()=>{
 const t3=fakeT3(),mem=durableJournal();let interrupt=true;
 const journal={...mem,put(k,v){if(interrupt&&v.kind==='thread.conditional-send'&&v.steps.some(x=>x.action==='thread.model-selection.set')){interrupt=false;throw new Error('interrupted');}return mem.put(k,v);}};
 const h=await leaseHarness(t3,{journal});
 await assert.rejects(h.call(req()),/journal_failed/);
 assert.deepEqual(t3.calls,['thread.model-selection.set']);
 const lease=await h.aprovar();
 const resumed=await h.call(req(),{leaseId:lease.leaseId});
 assert.equal(resumed.state,'completed');
 assert.deepEqual(t3.calls,['thread.model-selection.set','message.dispatch']);
 assert.deepEqual(resumed.steps.map(x=>[x.operationId,x.state]),[['cs-1:model-selection','completed'],['cs-1:send','completed']]);
});

test('replay under a narrower lease: a request of a project no longer granted is scope_denied, nothing revealed',async()=>{
 for(const first of [{},{active:'r1'}]) {
  const t3=fakeT3(first),h=await leaseHarness(t3);
  const original=await h.call(req());
  assert.equal(original.state,first.active?'precondition_pending':'completed');
  h.c.gate.revoke(h.lease.leaseId,h.lease.credentialId);
  h.inventory.projetos=[{id:'other',name:'other',directory:'/w/other'}];
  const narrow=await h.aprovar();
  await assert.rejects(h.call(req(),{leaseId:narrow.leaseId}),/scope_denied/);
  if(!first.active)await assert.rejects(h.c.relay(h.c.capability,{op:'reconcile',ambiente:'local',leaseId:narrow.leaseId,operationId:'cs-1:model-selection'}),/scope_denied/);
 }
});

test('OAuth restricted: replay requires the project in this session grant, not only the caller',async()=>{
 const t3=fakeT3(),authority=new SessionAuthority(),registro={alias:'local',environmentId:'env-p',destination:'t3://env-p',acoes:['thread.send','thread.model-selection.set']};
 const grant=ids=>escopoDosGrants([grantFromInventory({alias:'local',environmentId:'env-p',label:'local',destination:'t3://env-p',actions:registro.acoes,projects:ids.map(id=>({id,name:id,directory:`/w/${id}`}))})]);
 const sub='local:abcdefghijkl',wide=authority.create({sub,clientId:'c',credentialId:'k',scope:'connector:write',resource:'r',grants:grant(['app','other'])});
 const w=sessionWrites({conexoes:[{registro,cliente:t3.cliente,adapter:t3.adapter}],journal:{...memoryJournal(),audit(){}},authority,issuer:'https://as.example'});
 assert.equal((await w.conditional({sid:wide,sub},{environment:'local',operationId:'cs-1',input:req({modelSelection:undefined})})).state,'completed');
 const narrow=authority.create({sub,clientId:'c',credentialId:'k',scope:'connector:write',resource:'r',grants:grant(['other'])});
 await assert.rejects(w.conditional({sid:narrow,sub},{environment:'local',operationId:'cs-1',input:req({modelSelection:undefined})}),/scope_denied/);
 assert.equal((await w.conditional({sid:wide,sub},{environment:'local',operationId:'cs-1',input:req({modelSelection:undefined})})).replayed,true);
});

test('race: a concurrent call with the same clientRequestId but another input is a conflict, not a shared result',async()=>{
 const t3=fakeT3();let release;const gate=new Promise(r=>{release=r;});
 const host=engineHost(t3),observe=host.observe;host.observe=async id=>{await gate;return observe(id);};
 const a=conditionalSend(host,'same',req({clientRequestId:'same',modelSelection:undefined,text:'first'}),clock());
 await assert.rejects(conditionalSend(host,'same',req({clientRequestId:'same',modelSelection:undefined,text:'DIFFERENT'}),clock()),/operation_conflict/);
 const denied={...host,authorize(){throw new Error('lease_closed');}};
 await assert.rejects(conditionalSend(denied,'same',req({clientRequestId:'same',modelSelection:undefined,text:'first'}),clock()),/lease_closed/);
 const joined=conditionalSend(host,'same',req({clientRequestId:'same',modelSelection:undefined,text:'first'}),clock());
 release();
 const [ra,rb]=await Promise.all([a,joined]);
 assert.deepEqual(ra,rb);assert.deepEqual(t3.calls,['message.dispatch']);
});

test('race: a joined call whose session no longer covers the project gets scope_denied, not the shared result',async()=>{
 const t3=fakeT3();let release;const gate=new Promise(r=>{release=r;});
 const host=engineHost(t3),observe=host.observe;host.observe=async id=>{await gate;return observe(id);};
 const a=conditionalSend(host,'p',req({clientRequestId:'p',modelSelection:undefined}),clock());
 const narrow={...host,authorize(_actions,projectId){if(projectId==='app')throw new Error('scope_denied');}};
 const b=conditionalSend(narrow,'p',req({clientRequestId:'p',modelSelection:undefined}),clock());
 release();
 assert.equal((await a).state,'completed');await assert.rejects(b,/scope_denied/);
});

// A step's state comes from the Dispatcher journal: `preparing` (an executor may still send) and
// `uncertain` are never reported as "not sent", and a replay re-reads them instead of freezing.
test('a step another write holds in preparing is uncertain, not failed/sent:false; the replay follows the journal',async()=>{
 const t3=fakeT3(),h=await leaseHarness(t3,{journal:durableJournal()});
 let release,ready;const paused=new Promise(r=>{release=r;}),preparing=new Promise(r=>{ready=r;});
 t3.hooks.prepare=async()=>{ready();await paused;};
 const input=req({modelSelection:undefined});
 const ordinary=h.c.relay(h.c.capability,{op:'dispatch',ambiente:'local',leaseId:h.lease.leaseId,action:'thread.send',operationId:'cs-1:send',input:{threadId:'thread',clientRequestId:'cs-1:send',text:input.text,delivery:'start_immediately'}});
 await preparing;
 const during=await h.call(input);
 assert.equal(during.state,'uncertain');assert.equal(during.reason,'step_in_progress');assert.equal(during.failedOperationId,'cs-1:send');
 assert.ok(!('sent' in during));assert.doesNotMatch(during.nextAction,/not sent|nothing was sent/);
 release();assert.equal((await ordinary).state,'completed');
 const after=await h.call(input);
 assert.equal(after.state,'completed');assert.equal(after.steps.find(x=>x.action==='thread.send').state,'completed');
 assert.equal(t3.calls.filter(x=>x==='message.dispatch').length,1);
});

test('cross-process: a second executor never answers failed/sent:false while the first can still send',{timeout:20000},async t=>{
 const db=join(mkdtempSync(join(tmpdir(),'t3-conditional-')),'journal.sqlite'),sends=[],children=[];
 t.after(()=>{for(const c of children)c.kill();});
 const launch=role=>{const c=fork(new URL('./conditional/second-executor.mjs',import.meta.url),[db,role],{stdio:['ignore','ignore','inherit','ipc']});children.push(c);c.on('message',m=>{if(m.event==='sent')sends.push(role);});return c;};
 const event=(c,name)=>new Promise(r=>{const f=m=>{if(m.event===name){c.off('message',f);r(m);}};c.on('message',f);});
 const first=launch('first');await event(first,'preparing');
 const second=launch('second'),secondResult=(await event(second,'result')).result;
 assert.equal(secondResult.state,'uncertain');assert.equal(secondResult.reason,'step_in_progress');assert.ok(!('sent' in secondResult));
 const firstDone=event(first,'result');first.send('continue');assert.equal((await firstDone).result.state,'completed');
 const replay=event(second,'replay');second.send('replay');
 assert.equal((await replay).result.state,'completed');
 assert.deepEqual(sends,['first']);
});

test('a result recorded before the step appeared in the journal is not replayed as final',async()=>{
 const t3=fakeT3({active:'r1'}),j=durableJournal(),h=await leaseHarness(t3,{journal:j});
 t3.endRun();t3.startRun('r2');
 const input=req({modelSelection:undefined}),first=await h.call(input);
 assert.equal(first.state,'precondition_failed');
 t3.endRun();
 // Without the closing record (a manifest from before it existed), a later write can send.
 j.delete(chaveOperacao({environmentId:'env-p',destination:'t3://env-p',caller:exigirIdentidade(h.c.identity),operationId:'cs-1:send'}));
 await h.c.relay(h.c.capability,{op:'dispatch',ambiente:'local',leaseId:h.lease.leaseId,action:'thread.send',operationId:'cs-1:send',input:{threadId:'thread',clientRequestId:'cs-1:send',text:input.text,delivery:'start_immediately'}});
 const replay=await h.call(input);
 assert.equal(replay.state,'uncertain');assert.equal(replay.reason,'step_changed_after_result');assert.match(replay.nextAction,/reconcile/);
 assert.equal(t3.calls.filter(x=>x==='message.dispatch').length,1);
});

test('a send that reached T3 but whose completion could not be journaled is uncertain, not "not sent"',async()=>{
 const t3=fakeT3(),mem=durableJournal();
 const journal={...mem,put(k,v){if(v.action==='thread.send'&&v.state==='completed')throw new Error('disk');return mem.put(k,v);}};
 const h=await leaseHarness(t3,{journal});
 const r=await h.call(req({modelSelection:undefined}));
 assert.equal(r.state,'uncertain');assert.equal(r.failedOperationId,'cs-1:send');assert.ok(!('sent' in r));
 assert.equal(t3.calls.filter(x=>x==='message.dispatch').length,1);
});

// "Not sent" is said only of a step whose write-journal record is a refusal, the Dispatcher's or
// one the conditional reserved atomically before answering: no later write can send under it.
const ordinarySend=(h,input,leaseId=h.lease.leaseId)=>h.c.relay(h.c.capability,{op:'dispatch',ambiente:'local',leaseId,action:'thread.send',operationId:`${input.clientRequestId}:send`,input:{threadId:'thread',clientRequestId:`${input.clientRequestId}:send`,text:input.text,delivery:'start_immediately'}});

test('after "not sent" (model not reflected), a write under the step id can never send; the replay stays true',async()=>{
 const t3=fakeT3(),h=await leaseHarness(t3,{journal:durableJournal()});
 t3.hooks.ignoreModel=true;
 const input=req(),first=await h.call(input);
 assert.equal(first.state,'failed');assert.equal(first.reason,'model_selection_not_applied');assert.equal(first.sent,false);
 assert.equal(first.steps.find(x=>x.operationId==='cs-1:send').state,'rejected');
 const ordinary=await ordinarySend(h,input);
 assert.equal(ordinary.state,'rejected');assert.equal(t3.calls.filter(x=>x==='message.dispatch').length,0);
 const replay=await h.call(input);
 assert.equal(replay.state,'failed');assert.equal(replay.sent,false);assert.equal(replay.replayed,true);
});

test('after precondition_failed, a write under the step ids can never send',async()=>{
 const t3=fakeT3({active:'r1'}),h=await leaseHarness(t3,{journal:durableJournal()});
 t3.endRun();t3.startRun('r2');
 const input=req({modelSelection:undefined}),first=await h.call(input);
 assert.equal(first.state,'precondition_failed');
 t3.endRun();
 assert.equal((await ordinarySend(h,input)).state,'rejected');
 assert.equal(t3.calls.filter(x=>x==='message.dispatch').length,0);
 assert.equal((await h.call(input)).state,'precondition_failed');
});

test('a final answer whose steps changed is rebuilt from the current steps, never from the old answer',async()=>{
 const t3=fakeT3(),j=durableJournal(),h=await leaseHarness(t3,{journal:j});
 t3.hooks.ignoreModel=true;
 const input=req(),first=await h.call(input);
 assert.equal(first.sent,false);
 // A manifest written before the send step was closed (as at 1708a32): no record under <id>:send.
 const sendKey=chaveOperacao({environmentId:'env-p',destination:'t3://env-p',caller:exigirIdentidade(h.c.identity),operationId:'cs-1:send'});
 j.delete(sendKey);
 assert.equal((await ordinarySend(h,input)).state,'completed');
 const replay=await h.call(input);
 assert.equal(replay.state,'uncertain');assert.equal(replay.reason,'step_changed_after_result');
 for(const k of ['sent','detail','failedStep'])assert.ok(!(k in replay),k);
 assert.equal(replay.steps.find(x=>x.operationId==='cs-1:send').state,'completed');
 assert.doesNotMatch(replay.nextAction,/not sent|nothing was sent/);
});

test('a refusal before any reservation says nothing about the step, even if another process sends under it meanwhile',async()=>{
 const path=join(mkdtempSync(join(tmpdir(),'t3-conditional-')),'journal.sqlite'),journal=new FileJournal(path);
 const identity=identidadeCanal({organization:'org',tunnelId:'tunnel_fixture'}),caller=exigirIdentidade(identity),environment={environmentId:'e',destination:'t3://e'};
 const sendKey=chaveOperacao({...environment,caller,operationId:'race:send'});
 let armed=false,interleaved=false;
 // The other process commits right after this call's read of <id>:send, before it answers.
 const shared={reserve:(...a)=>journal.reserve(...a),put:(...a)=>journal.put(...a),get(k){const snapshot=journal.get(k);
  if(armed&&!interleaved&&k===sendKey){interleaved=true;execFileSync(process.execPath,[new URL('./conditional/commit-send.mjs',import.meta.url).pathname,path,'race:send','once']);}
  return snapshot;}};
 const closed=new Dispatcher({journal,environmentId:'e',destination:'t3://e',adapter:{},gate:{status:()=>({active:false,scope:{caller}})}});
 const host={caller,environment,journal:shared,authorize(){},audit(){},failClosed(){},
  observe:async()=>({projectId:'app',latestRunId:'r1',status:'completed',activeRunId:null}),
  dispatch:(action,operationId,input)=>{armed=true;return closed.dispatch(identity,'expired',{action,operationId,input});}};
 const input={threadId:'thread',clientRequestId:'race',afterRunId:'r1',text:'once'};
 const outcome=await conditionalSend(host,'race',input).then(r=>r,e=>({error:e.message}));
 assert.equal(journal.get(sendKey).state,'completed');
 assert.ok(outcome.error||outcome.sent!==false,JSON.stringify(outcome));
 if(!outcome.error)assert.notEqual(outcome.state,'failed');
 // The same request, once it can read the journal again, reports the send that happened.
 host.journal=journal;host.dispatch=async()=>{throw new Error('must_not_dispatch');};
 assert.equal((await conditionalSend(host,'race',input)).state,'completed');
 journal.close();
});

test('a refusal recorded only in an older manifest is not proof: the step is closed atomically first',async()=>{
 const t3=fakeT3(),j=durableJournal(),h=await leaseHarness(t3,{journal:j});
 const caller=exigirIdentidade(h.c.identity),input=req({modelSelection:undefined});
 const key=manifestKey({environmentId:'env-p',destination:'t3://env-p',caller,clientRequestId:'cs-1'});
 // As written before refusals were closed in the journal: an executing manifest whose send step
 // says rejected (a refusal before any reservation), with no record under <id>:send.
 j.reserve(key,{kind:'thread.conditional-send',hash:digest(['thread.conditional-send',conditionalSchemaParse(input)]),operationId:'cs-1',threadId:'thread',afterRunId:'r1',projectId:'app',state:'executing',attempts:1,observations:[],steps:[{action:'thread.send',operationId:'cs-1:send',state:'rejected',error:'lease_closed'}]});
 const r=await h.call(input);
 // Whatever it answers must hold afterwards: "not sent" only if no later write can send under it.
 const later=await ordinarySend(h,input);
 if(r.sent===false)assert.equal(later.state,'rejected');
 assert.ok(t3.calls.filter(x=>x==='message.dispatch').length<=1);
});

// Engine-level cases with a controlled clock and host.
function engineHost(t3,{journal=memoryJournal(),dispatchLog=[]}={}) {
 return {caller:'caller',environment:{environmentId:'e',destination:'t3://e'},journal,audit(){},failClosed(){},authorize(){},
  observe:async()=>structuredClone((await t3.shell()).threads[0]),readThread:async()=>({runs:t3.runs}),
  // Same contract as the Dispatcher: a completed step is journaled under its operationId.
  dispatch:async(action,operationId,input)=>{
   dispatchLog.push(operationId);
   await t3.adapter.invoke('x',action==='thread.send'?{type:'message.dispatch',messageId:operationId,dispatchMode:{type:input.delivery}}:{type:action,modelSelection:input.modelSelection});
   const key=chaveOperacao({environmentId:'e',destination:'t3://e',caller:'caller',operationId}),record={hash:digest([action,parseAction(action,input).input]),action,state:'completed',receipt:{sequence:1},payloadIds:{messageId:operationId}};
   if(!journal.reserve(key,record))journal.put(key,record);
   return {state:'completed',receipt:{sequence:1}};
  }};
}
const clock=()=>{let t=0;return {now:()=>t,sleep:async ms=>{t+=ms;}};};

test('waitMs: waits for the run to end, then completes; times out as pending without sending',async()=>{
 const t3=fakeT3({active:'r1'});
 t3.hooks.shell=n=>{if(n===3)t3.endRun();};
 const r=await conditionalSend(engineHost(t3),'w-1',req({clientRequestId:'w-1',waitMs:5000}),clock());
 assert.equal(r.state,'completed');assert.deepEqual(r.observations.map(o=>o.verdict).slice(0,3),['pending','pending','met']);
 const t4=fakeT3({active:'r1'});
 const p=await conditionalSend(engineHost(t4),'w-2',req({clientRequestId:'w-2',waitMs:1200}),clock());
 assert.equal(p.state,'precondition_pending');assert.equal(p.observations.length,3);assert.deepEqual(t4.calls,[]);
});

test('model not reflected by the thread before the send: failed model_selection_not_applied, no send',async()=>{
 const t3=fakeT3();t3.hooks.ignoreModel=true;
 const r=await conditionalSend(engineHost(t3),'m-1',req({clientRequestId:'m-1'}),clock());
 assert.equal(r.state,'failed');assert.equal(r.reason,'model_selection_not_applied');assert.deepEqual(t3.calls,['thread.model-selection.set']);
});

test('interrupted after the first step: retry resumes at the send and does not redo the model step',async()=>{
 const t3=fakeT3(),journal=memoryJournal(),dispatchLog=[];
 const host=engineHost(t3,{journal,dispatchLog});
 let reads=0;const observe=host.observe;host.observe=async id=>{if(++reads===2)throw new Error('ambiente_indisponivel');return observe(id);};
 await assert.rejects(conditionalSend(host,'i-1',req({clientRequestId:'i-1'}),clock()),/ambiente_indisponivel/);
 assert.equal(journal.get(manifestKey({...host.environment,caller:'caller',clientRequestId:'i-1'})).state,'executing');
 const r=await conditionalSend(host,'i-1',req({clientRequestId:'i-1'}),clock());
 assert.equal(r.state,'completed');assert.equal(r.attempts,2);
 assert.deepEqual(dispatchLog,['i-1:model-selection','i-1:send']);
});

test('journal failure fails closed',async()=>{
 const t3=fakeT3();let closed=0;
 const host={...engineHost(t3),journal:{reserve(){throw new Error('disk');},get(){},put(){}},failClosed(){closed++;}};
 await assert.rejects(conditionalSend(host,'j-1',req({clientRequestId:'j-1'}),clock()),/journal_failed/);
 assert.equal(closed,1);assert.deepEqual(t3.calls,[]);
});

test('precondition and model comparison rules',()=>{
 const base={latestRunId:'r1',status:'completed',activeRunId:null};
 assert.equal(evaluatePrecondition(base,'r1').verdict,'met');
 assert.equal(evaluatePrecondition({...base,status:'running',activeRunId:'r1'},'r1').verdict,'pending');
 assert.equal(evaluatePrecondition({...base,status:'cancelled',activeRunId:'r1',activityRunStatus:'running',latestRunId:'q'},'r1').verdict,'pending');
 assert.equal(evaluatePrecondition({...base,latestRunId:null,status:'idle'},'r1').reason,'run_unknown');
 assert.equal(evaluatePrecondition({...base,activityRunStatus:'waiting',status:'cancelled',latestRunId:'q'},'r1').reason,'other_run_active');
 assert.ok(sameModel({...FAST,options:[{id:'b',value:1},{id:'a',value:2}]},{...FAST,options:[{id:'a',value:2},{id:'b',value:1}]}));
 assert.ok(!sameModel(FAST,OPUS));
});

test('write bridge exposes the conditional tool with strict schema and routes it to the relay',async()=>{
 const pedidos=[];
 const server=criarPonteEscrita({relay:async r=>{pedidos.push(r);return {ambiente:{alias:'local'},state:'completed'};},aliases:['local'],approvalOrigin:'http://localhost:7433'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);
 const client=new Client({name:'t',version:'1'});await client.connect(a);
 try {
  const tool=(await client.listTools()).tools.find(t=>t.name===CONDITIONAL_TOOL);
  assert.ok(tool.inputSchema.required.includes('environment'));assert.equal(tool.inputSchema.properties.input.additionalProperties,false);
  assert.match(tool.description,/never turns it into a queued message silently/);
  const ok=await client.callTool({name:CONDITIONAL_TOOL,arguments:{leaseId:'l',environment:'local',operationId:'cs',input:req({clientRequestId:'cs'})}});
  assert.equal(ok.isError,undefined);assert.equal(pedidos[0].op,'conditional-send');
  const bad=await client.callTool({name:CONDITIONAL_TOOL,arguments:{leaseId:'l',environment:'local',operationId:'cs',input:{...req(),delivery:'queue_after_active'}}});
  assert.equal(bad.isError,true);assert.equal(pedidos.length,1);
 } finally {await client.close();await server.close();}
});

test('OAuth all: same contract through the session dispatch, steps checked per step',async()=>{
 const t3=fakeT3(),authority=new SessionAuthority(),r={alias:'local',environmentId:'env-p',destination:'t3://env-p',acoes:ACTIONS};
 const sub='local:testSubject001',sid=authority.create({sub,clientId:'c',credentialId:'k',scope:'connector:write',resource:'r',grants:consentAll([r])});
 const w=sessionWrites({conexoes:[{registro:r,cliente:t3.cliente,adapter:t3.adapter}],journal:{...memoryJournal(),audit(){}},authority,issuer:'https://as.example',projectPolicy:'all'});
 const out=await w.conditional({sid,sub},{environment:'local',operationId:'cs-1',input:req()});
 assert.equal(out.state,'completed');assert.deepEqual(out.environment,{alias:'local',environmentId:'env-p'});
 assert.deepEqual(t3.calls,['thread.model-selection.set','message.dispatch']);
 const replay=await w.conditional({sid,sub},{environment:'local',operationId:'cs-1',input:req()});
 assert.equal(replay.replayed,true);assert.equal(t3.calls.length,2);
 const other=authority.create({sub:'local:otherSubject002',clientId:'c',credentialId:'k2',scope:'connector:write',resource:'r',grants:consentAll([r])});
 // Another subject has its own key space: the same clientRequestId is a different request.
 t3.endRun();
 const theirs=await w.conditional({sid:other,sub:'local:otherSubject002'},{environment:'local',operationId:'cs-1',input:req({afterRunId:t3.thread.latestRunId})});
 assert.equal(theirs.replayed,false);assert.equal(theirs.state,'completed');
});
