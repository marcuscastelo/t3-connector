import { Gate } from '../src/escrita/gate.mjs';
import { Passkeys } from '../src/escrita/webauthn.mjs';
import { authenticator as softwareAuthenticator } from 'mcp-connector-kit/testing';
import { identidadeMTLS } from '../src/escrita/identidade.mjs';
export const ORIGIN='https://approval.example.test',RPID='approval.example.test';
export function identity(subject='usuario', fingerprint='AA:BB') {
 return identidadeMTLS({socket:{encrypted:true,authorized:true,getPeerCertificate:()=>({fingerprint256:fingerprint})}},new Map([[fingerprint,subject]]));
}
export const authenticator=({rpID=RPID}={})=>softwareAuthenticator({rpID,origin:rpID===RPID?ORIGIN:`https://${rpID}`});
export function memoryJournal() {const m=new Map();return {get:k=>m.get(k),put:(k,v)=>m.set(k,v),reserve:(k,v)=>{if(m.has(k))return false;m.set(k,v);return true;}};}
export function setup() {
 let now=0,wallOffset=1000;const auth=authenticator(),audit=[],caller=identity();
 const passkeys=new Passkeys({origin:ORIGIN,rpID:RPID,credentials:new Map([[auth.credential.id,auth.credential]]),saveCredential:async()=>{}});
 const gate=new Gate({clock:()=>now,wall:()=>wallOffset+now,audit:e=>audit.push(e),verify:p=>passkeys.verify(p)});
 const env={alias:'local',environmentId:'local',label:'Local',destination:'t3://isolated-control',projects:[{id:'app',name:'app',directory:'/workspace/app'},{id:'t3',name:'t3',directory:'/workspace/t3'}],actions:['thread.launch','thread.send','run.interrupt','thread.delete','runtime-request.approve'],readProjectIds:['app']};
 const scope={scopeVersion:2,runtimeMode:'full-access',environments:[env]};
 async function grant(){const r=gate.request(caller,scope),challenge=gate.challenge(r.requestId,ORIGIN);return gate.approve(r.requestId,{response:auth.assertion(challenge),origin:ORIGIN});}
 const target={environmentId:env.environmentId,destination:env.destination,projectIds:['app'],action:'thread.send'};
 return {gate,passkeys,auth,audit,caller,scope,env,grant,target,advance:ms=>now+=ms,moveWall:ms=>wallOffset+=ms};
}
// server.getConfig providers offering exactly the given selections (ServerProvider shape of T3
// 8ed276c2): a string option value becomes a select descriptor, a boolean one a boolean descriptor.
export function providersFor(...selections) {
 const porInstancia=new Map();
 for(const {instanceId,model,options=[]} of selections) {
  const p=porInstancia.get(instanceId)??{instanceId,driver:'codex',enabled:true,installed:true,status:'ready',models:[]};porInstancia.set(instanceId,p);
  p.models.push({slug:model,name:model,isCustom:false,capabilities:{optionDescriptors:options.map(o=>typeof o.value==='boolean'?{id:o.id,label:o.id,type:'boolean'}:{id:o.id,label:o.id,type:'select',options:[{id:o.value,label:o.value}]})}});
 }
 return [...porInstancia.values()];
}
