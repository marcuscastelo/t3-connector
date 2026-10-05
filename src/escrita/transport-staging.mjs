import { z } from 'zod';
import { NativeRpcError } from './native.mjs';
// Effect RPC framing from installed T3 8ed276c2 client-runtime/rpc/session.test.ts.
// This module DOES NOT connect, pair, read a token, authenticate, or publish a route.
// A future isolated bootstrap must supply the authenticated, already-open socket.
const receipt=z.union([z.object({sequence:z.number().int().nonnegative()}).strict(),z.object({threadId:z.string().min(1),projection:z.object({}).passthrough(),resumed:z.boolean()}).strict()]);
// projects.mutate answers with the Project (contracts project.ts:136-152); the archived shell
// snapshot is a read (orchestrationV2.ts:2881). Each method has its own result shape.
const project=z.object({id:z.string().min(1),deletedAt:z.string().nullable()}).passthrough();
const archived=z.object({snapshotSequence:z.number().int().nonnegative(),threads:z.array(z.object({}).passthrough())}).passthrough();
const RESULTS={
 'orchestration.dispatchCommand':r=>{const v=receipt.parse(r);if(!('sequence' in v))throw new Error();return v;},
 'orchestration.launchThread':r=>{const v=receipt.parse(r);if(!('threadId' in v))throw new Error();return v;},
 'projects.mutate':r=>project.parse(r),
 'orchestration.getArchivedShellSnapshot':r=>archived.parse(r),
};
// Native-tool RPCs (see native.mjs). T3 validates their payloads; the result must be an object
// (scheduledTasks.delete answers {id}).
const object=z.object({}).passthrough();
for(const m of ['projects.createNew','sourceControl.cloneRepository','server.getSettings','server.updateSettings','orchestration.searchThreads','vcs.listRefs','scheduledTasks.list','scheduledTasks.upsert','scheduledTasks.delete','scheduledTasks.runNow']) RESULTS[m]=r=>object.parse(r);
export class StagingRpcTransport {
 #pending=new Map(); #next=1; #closed=false;
 constructor({socket,onFailure,timeoutMs=10000,maxPending=64,allowLoopback=false}) {
  if(!onFailure || socket.readyState!==1) throw new Error('control_socket_not_ready');
  const url=new URL(socket.url);
  if((url.protocol!=='wss:' && !(allowLoopback && url.protocol==='ws:' && url.hostname==='127.0.0.1')) || url.pathname!=='/ws' || url.searchParams.get('orchestrationProtocol')!=='2') throw new Error('control_socket_invalid');
  Object.assign(this,{socket,onFailure,timeoutMs,maxPending});
  socket.addEventListener('message',event=>this.#receive(event.data));
  socket.addEventListener('close',()=>this.fail());socket.addEventListener('error',()=>this.fail());
 }
 // nativeErrors: a typed T3 failure (Exit Failure, cause Fail with a tagged error) rejects that call
 // with NativeRpcError and keeps the socket; without it any failure is uncertain (fail closed).
 invoke(method,payload,{nativeErrors=false}={}) {
  if(!RESULTS[method]) throw new Error('rpc_unavailable');
  if(this.#closed || this.socket.readyState!==1) throw new Error('control_socket_closed');
  if(this.#pending.size>=this.maxPending) throw new Error('too_many_dispatches');
  const id=String(this.#next++);
  // send is synchronous. No readiness wait or reconnect can outlive the gate check.
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>this.fail(),this.timeoutMs);
   this.#pending.set(id,{resolve,reject,timer,method,nativeErrors});
   try {this.socket.send(JSON.stringify({_tag:'Request',id,tag:method,payload,headers:[]}));}
   catch {this.fail();}
  });
 }
 #receive(data) {
  try {
   if(typeof data!=='string' || data.length>2*1024*1024) throw new Error();
   const frame=JSON.parse(data);
   if(frame._tag==='Ping') {this.socket.send(JSON.stringify({_tag:'Pong'}));return;}
   if(frame._tag!=='Exit' || typeof frame.requestId!=='string') throw new Error();
   const pending=this.#pending.get(frame.requestId);
   if(!pending) return; // A late/duplicate response never causes a new invocation.
   if(frame.exit?._tag!=='Success') {
    const error=pending.nativeErrors&&frame.exit?._tag==='Failure'&&Array.isArray(frame.exit.cause)&&frame.exit.cause.length===1&&frame.exit.cause[0]?._tag==='Fail'?frame.exit.cause[0].error:null;
    if(error&&typeof error._tag==='string') {
     const {_tag,message,...fields}=error;
     this.#pending.delete(frame.requestId);clearTimeout(pending.timer);
     pending.reject(new NativeRpcError(_tag,typeof message==='string'?message.slice(0,2000):'',Object.fromEntries(Object.entries(fields).filter(([,v])=>['string','number','boolean'].includes(typeof v)))));
     return;
    }
    this.fail();return;
   }
   const result=RESULTS[pending.method](frame.exit.value);
   this.#pending.delete(frame.requestId);clearTimeout(pending.timer);pending.resolve(result);
  } catch {this.fail();}
 }
 fail() {
  if(this.#closed)return;this.#closed=true;
  try {this.onFailure();} catch {}
  for(const p of this.#pending.values()){clearTimeout(p.timer);p.reject(new Error('control_transport_uncertain'));}
  this.#pending.clear();
 }
 receipt(result) {return projectReceipt(result)??('threadId' in result?{threadId:result.threadId,resumed:result.resumed}:{sequence:result.sequence});}
 get available() {return !this.#closed&&this.socket.readyState===1;}
 close() {this.fail();this.socket.close();}
}

/** Receipt of a project mutation: its id and deletedAt; never an invented sequence or count. */
export const projectReceipt=r=>('id' in r && 'deletedAt' in r)?{projectId:r.id,deletedAt:r.deletedAt}:null;
