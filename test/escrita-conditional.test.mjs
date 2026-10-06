import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {controller} from '../src/escrita/controller.mjs';
import {criarPonteEscrita} from '../src/escrita/ponte-mcp.mjs';
import {conditionalSend,evaluatePrecondition,sameModel,manifestKey,CONDITIONAL_TOOL} from '../src/escrita/conditional.mjs';
import {ACTIONS} from '../src/escrita/adapters.mjs';
import {sessionWrites} from '../src/oauth/session-writes.mjs';
import {SessionAuthority} from '../src/oauth/session-authority.mjs';
import {consentAll} from '../src/oauth/project-policy.mjs';
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

async function leaseHarness(t3,{acoes=['thread.send','thread.model-selection.set','run.interrupt'],projetos}={}) {
 const s=setup(),audit=[],journal={...memoryJournal(),audit:e=>audit.push(e)};
 const conexao={registro:{alias:'local',environmentId:'env-p',destination:'t3://env-p',acoes},
  inventario:async()=>projetos??[{id:'app',name:'app',directory:'/w/app'},{id:'other',name:'other',directory:'/w/other'}],
  cliente:t3.cliente,adapter:t3.adapter,fechar(){}};
 const c=controller({conexoes:[conexao],passkeys:s.passkeys,journal,organization:'my-org',tunnelId:'tunnel_fixture'});
 let counter=0;
 const aprovar=async()=>{const r=await c.relay(c.capability,{op:'request'});const ch=c.gate.challenge(r.requestId,ORIGIN);return c.gate.approve(r.requestId,{response:s.auth.assertion(ch,{counter:++counter}),origin:ORIGIN});};
 const lease=await aprovar();
 const call=(input,{leaseId=lease.leaseId,operationId=input.clientRequestId}={})=>c.relay(c.capability,{op:'conditional-send',ambiente:'local',leaseId,operationId,input});
 return {c,s,journal,audit,lease,aprovar,call};
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
 assert.deepEqual(r.steps.map(s=>[s.action,s.state]),[['thread.model-selection.set','completed']]);
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

test('uncertain send: fails closed, never resent; retry under a new lease replays uncertain',async()=>{
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
 assert.equal(replay.state,'uncertain');assert.equal(replay.replayed,true);
 assert.deepEqual(t3.calls,['thread.model-selection.set','message.dispatch']);
});

// Engine-level cases with a controlled clock and host.
function engineHost(t3,{journal=memoryJournal(),dispatchLog=[]}={}) {
 return {caller:'caller',environment:{environmentId:'e',destination:'t3://e'},journal,audit(){},failClosed(){},authorize(){},
  observe:async()=>structuredClone((await t3.shell()).threads[0]),readThread:async()=>({runs:t3.runs}),
  dispatch:async(action,operationId,input)=>{dispatchLog.push(operationId);await t3.adapter.invoke('x',action==='thread.send'?{type:'message.dispatch',messageId:operationId,dispatchMode:{type:input.delivery}}:{type:action,modelSelection:input.modelSelection});return {state:'completed',receipt:{sequence:1}};}};
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
