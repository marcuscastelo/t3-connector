import { z } from 'zod';
// Effect RPC framing from installed T3 8ed276c2 client-runtime/rpc/session.test.ts.
// This module DOES NOT connect, pair, read a token, authenticate, or publish a route.
// A future isolated bootstrap must supply the authenticated, already-open socket.
const receipt=z.union([z.object({sequence:z.number().int().nonnegative()}).strict(),z.object({threadId:z.string().min(1),projection:z.object({}).passthrough(),resumed:z.boolean()}).strict()]);
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
 invoke(method,payload) {
  if(!['orchestration.dispatchCommand','orchestration.launchThread'].includes(method)) throw new Error('rpc_unavailable');
  if(this.#closed || this.socket.readyState!==1) throw new Error('control_socket_closed');
  if(this.#pending.size>=this.maxPending) throw new Error('too_many_dispatches');
  const id=String(this.#next++);
  // send is synchronous. No readiness wait or reconnect can outlive the gate check.
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>this.fail(),this.timeoutMs);
   this.#pending.set(id,{resolve,reject,timer,method});
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
   if(frame.exit?._tag!=='Success') {this.fail();return;}
   const result=receipt.parse(frame.exit.value);
   if(pending.method==='orchestration.launchThread' && !('threadId' in result))throw new Error();
   if(pending.method==='orchestration.dispatchCommand' && !('sequence' in result))throw new Error();
   this.#pending.delete(frame.requestId);clearTimeout(pending.timer);pending.resolve(result);
  } catch {this.fail();}
 }
 fail() {
  if(this.#closed)return;this.#closed=true;
  try {this.onFailure();} catch {}
  for(const p of this.#pending.values()){clearTimeout(p.timer);p.reject(new Error('control_transport_uncertain'));}
  this.#pending.clear();
 }
 receipt(result) {return 'threadId' in result?{threadId:result.threadId,resumed:result.resumed}:{sequence:result.sequence};}
 get available() {return !this.#closed&&this.socket.readyState===1;}
 close() {this.fail();this.socket.close();}
}
