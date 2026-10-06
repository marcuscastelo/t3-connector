import { z } from 'zod';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, grantDoAmbiente } from './gate.mjs';
import { exigirIdentidade } from './identidade.mjs';
import { PROJECT_ACTIONS, PROJECT_SCHEMAS, isProjectAction, guardProjectDelete, lockProject } from './project-admin.mjs';
import { NATIVE_WRITES, NATIVE_WRITE_ACTIONS, NativeToolError, NativeRpcError } from './native.mjs';
const str=z.string().trim().min(1).max(1024), id=str;
const model=z.object({instanceId:str.describe('Exact ID of the provider instance configured in the chosen environment, as listed by the read tool t3_providers (instanceId); keep case, underscores and hyphens, for example claudeAgent_custom.'),model:str.describe('Exact model ID for that instance (models[].slug in t3_providers), including custom models, for example claude-opus-5-5. The connector has no model enum or allowlist; availability is decided by T3 in that environment.'),options:z.array(z.object({id:str,value:z.union([z.string(),z.boolean()])}).strict()).optional()}).strict();
const runtimeMode=z.enum(['approval-required','auto-accept-edits','auto','full-access']).default('full-access').describe('T3 execution mode; omitted preserves the connector default full-access. Supported modes are decided by the selected provider in T3.');
const base={threadId:id};
const specs=new Map();
function command(action,type,fields={},fixed={},refs=['threadId']) {
 specs.set(action,{schema:z.object({...base,...fields}).strict(),refs,method:'orchestration.dispatchCommand',encode:p=>({type,commandId:randomUUID(),...p,...fixed})});
}
for(const suffix of ['archive','unarchive','delete','settle','pin','unpin','unsnooze','mark-unread']) command(`thread.${suffix}`,`thread.${suffix}`,{},suffix==='unsnooze'?{reason:'user'}:{});
command('thread.unsettle','thread.unsettle',{}, {reason:'user'});
command('thread.snooze','thread.snooze',{snoozedUntil:z.iso.datetime()});
command('thread.auto-settle.set','thread.auto-settle.set',{enabled:z.boolean()});
for(const suffix of ['pin.reorder','active.reorder']) command(`thread.${suffix}`,`thread.${suffix}`,{orderKey:str});
command('thread.visit','thread.visit',{visitedAt:z.iso.datetime()});
command('thread.title','thread.metadata.update',{title:str});
command('thread.runtime-mode.set','thread.runtime-mode.set',{runtimeMode});
command('thread.interaction-mode.set','thread.interaction-mode.set',{interactionMode:z.enum(['default','plan'])});
command('thread.model-selection.set','thread.model-selection.set',{modelSelection:model});
command('provider.switch','provider.switch',{modelSelection:model});
command('provider-session.detach','provider-session.detach',{providerSessionId:id,reason:str.optional()});
command('run.interrupt','run.interrupt',{runId:id,reason:str.optional(),holdQueue:z.boolean().optional()});
command('prepared-run.release','prepared-run.release',{runId:id});
command('queue.resume','queue.resume');
command('queued-run.cancel','queued-run.cancel',{runId:id});
command('queued-run.reorder','queued-run.reorder',{runId:id,beforeRunId:id.nullable()});
command('queued-run.edit','queued-run.edit',{runId:id,text:z.string().max(100000)});
command('queued-message.promote-to-steer','queued-message.promote-to-steer',{queuedRunId:id,targetRunId:id});
command('runtime-request.approve','runtime-request.respond',{requestId:id,decision:z.enum(['accept','acceptForSession','acceptAlways','decline','cancel'])});
command('runtime-request.answer','runtime-request.respond',{requestId:id,answers:z.record(z.string(),z.json())});
command('thread.user-input.dismiss','thread.user-input.dismiss',{requestId:id});
command('checkpoint.rollback','checkpoint.rollback',{scopeId:id,checkpointId:id,restoreFiles:z.boolean().optional()});
const workspace=z.discriminatedUnion('type',[
 z.object({type:z.literal('root'),branch:str.optional()}).strict(),
 z.object({type:z.literal('existing_worktree'),worktreePath:str,branch:str.optional()}).strict(),
 z.object({type:z.literal('worktree'),baseRef:str,branch:str.optional(),startFromOrigin:z.boolean().optional()}).strict()]);
specs.set('thread.launch',{method:'orchestration.launchThread',refs:[],schema:z.object({projectId:id,title:str,modelSelection:model,workspaceStrategy:workspace,runtimeMode,text:z.string().max(100000).optional()}).strict(),encode:p=>{const {text,...rest}=p;return {...rest,commandId:randomUUID(),threadId:randomUUID(),interactionMode:'default',...(text!==undefined?{initialMessage:{messageId:randomUUID(),text,attachments:[]}}:{})};}});
// One branch per mode: tools/list carries conditional requirements, not just runtime refinements.
export const SEND_DESCRIPTIONS=Object.freeze({
 start_immediately:'Starts a new run when there is no active run to preserve. Does not correct or interrupt a current run. If a run is active, T3 may turn this into a queued message: read t3_thread first; to correct the current run use steer_active with targetRunId.',
 steer_active:'Corrects the architecture, requirements or direction of the current run while it executes, without waiting for it to finish and without restarting it. Requires targetRunId of the active run obtained from t3_thread; if it finished, changed or does not accept steering, reassess and never fall back to a queue automatically. Example: use the existing API instead of building another backend.',
 restart_active:'Interrupts the active run identified by targetRunId and starts another one with the new message. Requires intent to interrupt/restart; may abandon work in progress and does not undo effects or files already changed. Example: stop this approach and start over.',
 queue_after_active:'Exceptional: follow-up work that must only run after the current run; does not change the current run and may arrive too late to correct architecture/requirements. Almost never use it in conversation. Requires deferUntilActiveCompletes=true and an explicit request to defer; with no active run it may start immediately. Example: when the implementation is done, do a separate review.',
});
export const SEND_DESCRIPTION='Sends an instruction to the thread. thread.send does NOT answer a pending runtime request: read t3_thread.pendingRequests[].nextAction and use runtime-request.answer for user_input or runtime-request.approve for approval with its requestId. A send can be queued behind a run waiting for user_input and leave it blocked. Correction or requirement change for the work in progress: steer_active + targetRunId (see t3_thread). No active run to preserve: start_immediately. Explicit interrupt/restart: restart_active + targetRunId. queue_after_active only for an explicit request for later work, with deferUntilActiveCompletes=true; never to correct the current run. There is no default mode and no automatic fallback in the connector.';
const sendBase={threadId:id,text:z.string().min(1).max(100000),clientRequestId:id};
const targetRunId=z.string({error:'targetRunId required: read t3_thread and pass the active run for steer_active or restart_active'}).trim().min(1,'targetRunId required: pass the active run').max(1024).describe('Required for steer_active and restart_active: ID of the active run of the same thread/environment, obtained from t3_thread. Do not use the threadId or the ID of a finished run.');
const sendSchema=z.discriminatedUnion('delivery',[
 z.object({...sendBase,delivery:z.literal('steer_active').describe(SEND_DESCRIPTIONS.steer_active),targetRunId}).strict(),
 z.object({...sendBase,delivery:z.literal('start_immediately').describe(SEND_DESCRIPTIONS.start_immediately)}).strict(),
 z.object({...sendBase,delivery:z.literal('restart_active').describe(SEND_DESCRIPTIONS.restart_active),targetRunId}).strict(),
 z.object({...sendBase,delivery:z.literal('queue_after_active').describe(SEND_DESCRIPTIONS.queue_after_active),deferUntilActiveCompletes:z.literal(true,{error:'queue_after_active requires explicit intent: pass deferUntilActiveCompletes=true only if deferring was explicitly requested; to correct the current run use steer_active + targetRunId'}).describe('Confirms an explicit request to run only after the current run. Never infer true from a correction, a conversation follow-up or reluctance to interrupt.')}).strict(),
]).describe(SEND_DESCRIPTION);
specs.set('thread.send',{method:'orchestration.dispatchCommand',refs:['threadId'],schema:sendSchema,encode:p=>({type:'message.dispatch',createdBy:'user',creationSource:'mcp',commandId:p.clientRequestId,messageId:p.clientRequestId,threadId:p.threadId,text:p.text,attachments:[],dispatchMode:{type:p.delivery,...(p.targetRunId?{targetRunId:p.targetRunId}:{})}})});

command('thread.metadata.update','thread.metadata.update',{title:str.optional(),regenerateTitle:z.boolean().optional(),branch:str.nullable().optional(),worktreePath:str.nullable().optional(),expectedWorktreePath:str.nullable().optional(),expectedEmpty:z.boolean().optional()});
command('thread.pull-request.link','thread.pull-request.link',{host:str,repository:str,number:z.number().int().positive(),url:z.url(),source:z.enum(['manual','created','agent','stack','stack-dismissed'])});
command('thread.pull-request.unlink','thread.pull-request.unlink',{host:str,repository:str,number:z.number().int().positive()});
const sourcePoint=z.discriminatedUnion('type',[z.object({type:z.literal('latest_stable')}).strict(),z.object({type:z.literal('run'),runId:id}).strict(),z.object({type:z.literal('checkpoint'),checkpointId:id}).strict()]);
specs.set('thread.fork',{method:'orchestration.dispatchCommand',refs:['sourceThreadId'],schema:z.object({sourceThreadId:id,sourcePoint,title:str.optional()}).strict(),encode:p=>({type:'thread.fork',commandId:randomUUID(),targetThreadId:randomUUID(),createdBy:'user',creationSource:'mcp',...p})});
specs.set('thread.merge_back',{method:'orchestration.dispatchCommand',refs:['sourceThreadId','targetThreadId'],schema:z.object({sourceThreadId:id,targetThreadId:id,sourcePoint}).strict(),encode:p=>({type:'thread.merge_back',commandId:randomUUID(),createdBy:'user',creationSource:'mcp',...p})});
specs.set('delegated_task.request',{method:'orchestration.dispatchCommand',refs:['parentThreadId'],schema:z.object({parentThreadId:id,parentRunId:id,parentNodeId:id,task:str,title:str.optional(),modelSelection:model,runtimeMode,completionWake:z.enum(['always','settled_only']).optional()}).strict(),encode:p=>({type:'delegated_task.request',commandId:randomUUID(),createdBy:'user',creationSource:'mcp',interactionMode:'default',...p})});
for(const [action,fields] of [
 ['delegated_task.wake-policy',{completionWake:z.enum(['always','settled_only'])}],
 ['delegated_task.completion-delivery.acknowledge',{observedByRunId:id.nullable()}],
 ['delegated_task.completion-delivery.dispose',{}]]) {
 specs.set(action,{method:'orchestration.dispatchCommand',refs:['parentThreadId'],schema:z.object({parentThreadId:id,taskId:id,...fields}).strict(),encode:p=>({type:action,commandId:randomUUID(),...p})});
}
export const ACTIONS=Object.freeze([...specs.keys()]);
export const INVENTORY=Object.freeze([...specs].map(([action,s])=>({action,rpc:s.method,status:'mock-only'})));
// Project actions are opt-in (OAuth all + explicit flag): outside ACTIONS, so existing catalogs,
// configs and consents never gain them by default.
for(const action of PROJECT_ACTIONS) specs.set(action,{method:'projects.mutate',refs:[],schema:PROJECT_SCHEMAS[action],encode:p=>({type:'project.delete',commandId:randomUUID(),projectId:p.projectId,force:action==='project.delete-force'})});
// Native-tool wrappers (native.mjs): opt-in too; payload built right before the send.
for(const action of NATIVE_WRITE_ACTIONS) specs.set(action,{native:true,refs:NATIVE_WRITES[action].refs??[],schema:NATIVE_WRITES[action].schema,build:NATIVE_WRITES[action].build,result:NATIVE_WRITES[action].result});
export const ALL_ACTIONS=Object.freeze([...ACTIONS,...PROJECT_ACTIONS,...NATIVE_WRITE_ACTIONS]);
export function schemaForAction(action) {const s=specs.get(action);if(!s)throw new Error('action_unavailable');return s.schema;}
export function parseAction(action,input) {
 const s=specs.get(action);if(!s) throw new Error('action_unavailable');
 const result=s.schema.safeParse(input);
 if(!result.success) {
  // Safe codes survive the private HTTP relay; never serialize rejected message text.
  if(action==='thread.send') {
   if(['steer_active','restart_active'].includes(input?.delivery)&&(!input.targetRunId||typeof input.targetRunId!=='string'||!input.targetRunId.trim()))throw new Error('target_run_id_required');
   if(input?.delivery==='queue_after_active'&&input.deferUntilActiveCompletes!==true)throw new Error('queue_explicit_intent_required');
  }
  throw result.error;
 }
 return {spec:s,input:result.data};
}
const RECUSAS=/^(thread_not_found|scope_denied|lease_closed|ambiente_[a-z_]+|workspace_[a-z_]+|project_[a-z_]+)$/;
// Writes that create a thread in a project, serialized with project deletes of this connector.
const PROJECT_SCOPED=new Set(['thread.launch','thread.fork',...PROJECT_ACTIONS]);
// v2: environment e destino lógico (t3://<environmentId>) estáveis; caller sem boot.
export const chaveOperacao=({environmentId,destination,caller,operationId})=>digest(['v2',environmentId,destination,caller,operationId]);
// The journal is retained across restarts. An uncertain result is never resubmitted.
export class Dispatcher {
 constructor({gate,adapter,journal,environmentId,destination,resolveGrant,validateTarget,authorizeRecorded}) {
  if(!journal.reserve)throw new Error('atomic_journal_required');
  Object.assign(this,{gate,adapter,journal,environmentId,destination,resolveGrant,validateTarget,authorizeRecorded});
 }
 #store(method,...args) {try{return this.journal[method](...args);}catch{this.gate.close();throw new Error('journal_failed');}}
 #key(caller,operationId) {return chaveOperacao({environmentId:this.environmentId,destination:this.destination,caller,operationId});}
 async #workspace(grant,projectIds,action,input) {
  const roots=grant.projects.filter(p=>projectIds.includes(p.id)).flatMap(p=>p.workspaceRoots??[p.directory]).map(p=>resolve(p));
  let path;
  if(action==='thread.launch' && input.workspaceStrategy.type==='existing_worktree')path=input.workspaceStrategy.worktreePath;
  // workspaceStrategy worktree ({baseRef, branch?, startFromOrigin?}) is forwarded as is: T3 creates the
  // worktree from the project root (OrchestrationV2ThreadLaunchWorkspaceStrategy, 8ed276c2).
  if(action==='thread.metadata.update' && input.worktreePath!==undefined && input.worktreePath!==null)path=input.worktreePath;
  if(path!==undefined) {
   if(!path.startsWith('/') || resolve(path)!==path || !roots.includes(path))throw new Error('workspace_scope_denied');
   // Filesystem canonicalization must run in the execution domain, not the gateway.
   if(!this.adapter.verifyWorkspace || !await this.adapter.verifyWorkspace(path,roots))throw new Error('workspace_verification_required');
  }
 }

 async dispatch(identity,leaseId,{operationId,action,input}) {
  id.parse(operationId);const caller=exigirIdentidade(identity);
  const parsed=parseAction(action,input), key=this.#key(caller,operationId), hash=digest([action,parsed.input]);
  if(action==='thread.send' && parsed.input.clientRequestId!==operationId) throw new Error('request_id_mismatch');
  // Initial auth before lookup/dedupe; final auth happens immediately before dispatch.
  const status=this.gate.status(leaseId);
  if(status.scope.caller!==caller || !status.active) throw new Error('lease_closed');
  let grant=grantDoAmbiente(status.scope,{environmentId:this.environmentId,destination:this.destination});
  if(!grant) throw new Error('ambiente_fora_da_lease');
  if(!grant.actions.includes(action)) throw new Error('scope_denied');
  const initial={hash,state:'preparing',action,operationId,environmentId:this.environmentId,destination:this.destination};
  const owned=this.#store('reserve',key,initial);
  const old=owned?null:this.#store('get',key);
  if(old) {if(old.hash!==hash) throw new Error('operation_conflict');if(old.target)(this.authorizeRecorded??((target)=>this.gate.check(identity,leaseId,target)))(old.target);return {state:old.state,operationId,reconciliationRequired:!['completed','failed'].includes(old.state),...((isProjectAction(action)||parsed.spec.native)&&old.receipt?{receipt:old.receipt,...(old.postCheck??{})}:{}),...(old.error?{error:old.error}:{})};}
  if(!owned)throw new Error('journal_failed');
  let release=null;
  try {
   if(this.resolveGrant) grant=await this.resolveGrant(grant);
   const projects=new Set(parsed.input.projectId?[parsed.input.projectId]:[]);
   for(const ref of parsed.spec.refs) {const p=await this.adapter.projectForThread(parsed.input[ref]);if(!p) throw new Error('thread_not_found');projects.add(p);}
   if(PROJECT_SCOPED.has(action)) release=await lockProject(JSON.stringify([this.environmentId,[...projects].sort()]));
   await this.#workspace(grant,[...projects],action,parsed.input);
   const target={environmentId:this.environmentId,destination:this.destination,projectIds:[...projects],action};
   // Stable commandId: T3 replays the receipt of a command it already committed.
   const h=key.slice(0,32), stableId=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
   let method=parsed.spec.method, payload=parsed.spec.native?null:parsed.spec.encode(parsed.input);
   if(action==='thread.send'||isProjectAction(action)) { payload.commandId=stableId; if(action==='thread.send')payload.messageId=payload.commandId; }
   // Conexão do environment aberta ainda em 'preparing' (falha aqui não enviou nada) e antes
   // da checagem final: entre a checagem e o envio não há await.
   if(this.adapter.prepare) await this.adapter.prepare();
   // Fresh full count (active + archived). The native force:false refusal still applies.
   if(this.validateTarget) await this.validateTarget({target,input:parsed.input,spec:parsed.spec,validateWorkspace:g=>this.#workspace(g,[...projects],action,parsed.input)});
   // Last read before the send: a count taken before the target validation could be stale.
   // The native force:false refusal still applies; the cross-client window remains T3's.
   if(isProjectAction(action)) guardProjectDelete(action,parsed.input,await this.#occupancy(parsed.input.projectId));
   // Native wrappers read what the native handler reads (e.g. the existing task) last, then build.
   if(parsed.spec.native) {
    if(!this.adapter.native) throw new Error('native_unavailable');
    ({method,payload}=await parsed.spec.build({input:parsed.input,native:this.adapter.native,commandId:stableId}));
   }
   const payloadIds={commandId:payload.commandId,threadId:payload.threadId,messageId:payload.messageId};
   this.#store('put',key,{...initial,state:'uncertain',target,payloadIds});
   // Typed errors for every method: a tagged Fail is T3 answering, not the transport failing (see catch).
   const result=await this.gate.dispatch(identity,leaseId,{environmentId:this.environmentId,destination:this.destination,projectIds:[...projects],action},()=>this.adapter.invoke(method,payload,{nativeErrors:true}),operationId);
   const done={...initial,state:'completed',target,payloadIds,receipt:parsed.spec.native?await this.#nativeResult(parsed.spec,{raw:result,method,payload,input:parsed.input}):this.adapter.receipt(result)};
   this.#store('put',key,done);
   if(!isProjectAction(action)) return {state:'completed',operationId,receipt:done.receipt};
   // The post-check is evidence: kept with the record so a replay returns it too.
   const postCheck=await this.#afterDelete(parsed.input.projectId,operationId);
   this.#store('put',key,{...done,postCheck});
   return {state:'completed',operationId,receipt:done.receipt,...postCheck};
  } catch(error) {
   const record=this.#store('get',key);
   // A typed refusal decided before the send (NativeToolError, or a typed answer to a preflight read)
   // is `rejected`: nothing was sent. A native wrapper's typed answer stays `failed` (T3 refused; as
   // reviewed for 0.11.0). Neither reconciles nor fails closed.
   if(error instanceof NativeToolError || (error instanceof NativeRpcError && (record.state==='preparing' || parsed.spec.native))) {
    this.#store('put',key,{...record,state:record.state==='preparing'?'rejected':'failed',error:error.native});
    throw error;
   }
   // A typed answer from T3 to a sent canonical action. T3 received the command, keeps a receipt
   // under this commandId and answered a typed error; whether it refused before any effect or
   // failed after a commit (e.g. the post-commit steps of queue.resume, or a launch whose thread
   // exists) cannot be told from the error, so the operation stays uncertain and is never resent.
   // The transport is healthy and the connector is in sync with T3, so sessions and leases survive;
   // ending every OAuth session is reserved to a lost transport or a failed journal. Before, this
   // answer was treated as a lost transport and cost ChatGPT a Reconnect + passkey (06/10/2026).
   if(error instanceof NativeRpcError) {
    this.#store('put',key,{...record,state:'uncertain',error:error.native});
    throw Object.assign(new Error('reconciliation_required'),{native:error.native});
   }
   if(record.state!=='preparing') this.gate.close();
   // No blind retry even if transport or audit failed. Reconciliation is read-only.
   this.#store('put',key,{...record,state:record.state==='preparing'?'rejected':'uncertain'});
   // Recusa antes do envio devolve o motivo conhecido (nada foi enviado); o resto é genérico.
   if(record.state==='preparing') throw new Error(RECUSAS.test(error.message)?error.message:'dispatch_rejected');
   throw new Error('reconciliation_required');
  } finally {release?.();}
 }
 // The native result is a projection of what T3 answered (plus a read for createNew). It cannot
 // fail the completed operation: on a projection failure the raw answer is kept.
 async #nativeResult(spec,args) {
  if(!spec.result) return args.raw;
  try {return await spec.result({...args,native:this.adapter.native});} catch {return {raw:args.raw,resultUnavailable:true};}
 }
 async #occupancy(projectId) {
  if(!this.adapter.occupancy) throw new Error('project_count_unavailable');
  try {return await this.adapter.occupancy(projectId);} catch {throw new Error('project_count_incomplete');}
 }
 // Another client can still create a thread in the project while it is deleted (backend limit):
 // report live threads left linked to it instead of claiming a clean delete. Never throws.
 async #afterDelete(projectId,operationId) {
  let count;
  try {count=await this.adapter.occupancy(projectId);} catch {return {postCheck:'unavailable'};}
  if(!count?.complete) return {postCheck:'incomplete'};
  if(count.total>0) {
   try {this.gate.audit({event:'project_delete_live_threads',operationId,projectId,liveThreads:count.total});} catch {}
   return {postCheck:'live_threads_remain',liveThreadsAfterDelete:count.total};
  }
  return {postCheck:'clean',liveThreadsAfterDelete:0};
 }
 async reconcile(identity,leaseId,operationId) {
  const caller=exigirIdentidade(identity),record=this.#store('get',this.#key(caller,operationId));
  if(!record) throw new Error('operation_unknown');
  if(!record.target)throw new Error('reconciliation_target_unknown');
  this.gate.check(identity,leaseId,record.target);
  const observation=z.object({found:z.boolean(),sequence:z.number().int().nonnegative().optional(),threadId:z.string().optional(),state:z.enum(['running','completed','failed','unknown']).optional()}).strict().parse(await this.adapter.reconcile(record));
  this.gate.check(identity,leaseId,record.target);
  this.gate.audit({event:'reconciled',operationId,leaseId,caller,target:record.target});
  return {operationId,state:record.state,observation,...(record.error?{error:record.error}:{})};
 }
}
