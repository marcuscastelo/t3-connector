import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACTIONS,Dispatcher,parseAction } from '../src/escrita/adapters.mjs';
import { setup,memoryJournal } from './escrita-fixtures.mjs';
import { fixtures } from './escrita-acoes-fixtures.mjs';
const contract=readFileSync(new URL('../reference/packages_contracts_src_orchestrationV2.ts',import.meta.url),'utf8');
function requiredFields(type) {
 const start=contract.indexOf(`    type: Schema.Literal("${type}"),`,contract.indexOf('export const OrchestrationV2Command ='));
 assert.ok(start!==-1,`type present in installed contract: ${type}`);
 const end=contract.indexOf('\n  }),',start),block=contract.slice(start,end);
 const required=[...block.matchAll(/^    (\w+): (?!Schema.optional)(.+)$/gm)].map(m=>m[1]);
 if(block.includes('...OrchestrationV2CreationFields'))required.push('createdBy','creationSource');
 if(block.includes('...ThreadPullRequestKey.fields'))required.push('host','repository','number');
 return required;
}
test('handwritten fixtures account for every exposed adapter, without implying API parity',()=>assert.deepEqual(fixtures.map(f=>f.action).sort(),[...ACTIONS].sort()));
for(const fixture of fixtures) {
 test(`adapter ${fixture.action}: actual outbound, contract essentials, malformed input, preapproval and revocation`,async()=>{
  const s=setup();s.env.actions=[fixture.action];const l=await s.grant(),calls=[];
  const adapter={verifyWorkspace:async()=>true,projectForThread:async()=> 'app',invoke:(method,payload)=>{calls.push({method,payload});return Promise.resolve(method==='orchestration.launchThread'?{threadId:payload.threadId,resumed:false}:{sequence:7});},receipt:r=>r};
  const d=new Dispatcher({gate:s.gate,adapter,journal:memoryJournal(),environmentId:s.env.environmentId,destination:s.env.destination});
  const op={operationId:'fixture-op',action:fixture.action,input:fixture.input};
  await assert.rejects(d.dispatch(s.caller,'fake-lease',op));assert.equal(calls.length,0);
  await assert.rejects(d.dispatch(s.caller,l.leaseId,{...op,input:{...fixture.input,type:'server.secret.issue'}}));assert.equal(calls.length,0);
  const result=await d.dispatch(s.caller,l.leaseId,op);assert.equal(result.state,'completed');assert.equal(calls.length,1);
  const {payload,method}=calls[0];
  if(fixture.expected) {assert.equal(method,'orchestration.dispatchCommand');assert.equal(payload.type,fixture.expected);for(const field of requiredFields(fixture.expected))assert.ok(field in payload,`installed contract requires ${field}`);}
  else {assert.equal(method,'orchestration.launchThread');for(const field of ['commandId','projectId','title','modelSelection','runtimeMode','interactionMode','workspaceStrategy'])assert.ok(field in payload);}
  s.gate.revoke(l.leaseId,l.credentialId);
  await assert.rejects(d.dispatch(s.caller,l.leaseId,{...op,operationId:'after-revoke',input:fixture.action==='thread.send'?{...fixture.input,clientRequestId:'after-revoke'}:fixture.input}));assert.equal(calls.length,1);
 });
}
test('cross-project merge target rejected independently of source',async()=>{const s=setup();s.env.actions=['thread.merge_back'];const l=await s.grant(),calls=[];const d=new Dispatcher({gate:s.gate,journal:memoryJournal(),environmentId:s.env.environmentId,destination:s.env.destination,adapter:{projectForThread:async id=>id==='source'?'app':'secret',invoke:()=>calls.push(1)}});await assert.rejects(d.dispatch(s.caller,l.leaseId,{operationId:'op',action:'thread.merge_back',input:{sourceThreadId:'source',targetThreadId:'target',sourcePoint:{type:'latest_stable'}}}));assert.equal(calls.length,0);});
