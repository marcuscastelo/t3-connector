import { Gate } from '../src/escrita/gate.mjs';
import { Passkeys } from '../src/escrita/webauthn.mjs';
import { generateKeyPairSync, createHash, sign, randomBytes } from 'node:crypto';
import { encodeCBOR } from '@levischuck/tiny-cbor';
import { identidadeMTLS } from '../src/escrita/identidade.mjs';
export const ORIGIN='https://approval.example.test',RPID='approval.example.test';
export function identity(subject='usuario', fingerprint='AA:BB') {
 return identidadeMTLS({socket:{encrypted:true,authorized:true,getPeerCertificate:()=>({fingerprint256:fingerprint})}},new Map([[fingerprint,subject]]));
}
const b64=data=>Buffer.from(data).toString('base64url');
export function authenticator({rpID=RPID}={}) {
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}), jwk=publicKey.export({format:'jwk'}), credentialId=randomBytes(32);
 const cose=new Map([[1,2],[3,-7],[-1,1],[-2,new Uint8Array(Buffer.from(jwk.x,'base64url'))],[-3,new Uint8Array(Buffer.from(jwk.y,'base64url'))]]);
 const credential={id:b64(credentialId),publicKey:new Uint8Array(encodeCBOR(cose)),counter:0,transports:['internal']};
 function data(flags,counter) {const bytes=Buffer.alloc(37);createHash('sha256').update(rpID).digest().copy(bytes);bytes[32]=flags;bytes.writeUInt32BE(counter,33);return bytes;}
 function client(challenge,origin,type,context={}) {return Buffer.from(JSON.stringify({type,challenge,origin,crossOrigin:false,...context}));}
 return {credential,
 assertion(challenge,{origin=ORIGIN,uv=true,counter=1,badSignature=false,up=true,context={}}={}) {
  const c=client(challenge,origin,'webauthn.get',context),auth=data((uv?4:0)+(up?1:0),counter),sig=sign('sha256',Buffer.concat([auth,createHash('sha256').update(c).digest()]),privateKey);
  if(badSignature)sig[10]^=1;
  return {id:credential.id,rawId:credential.id,type:'public-key',clientExtensionResults:{},response:{clientDataJSON:b64(c),authenticatorData:b64(auth),signature:b64(sig)}};
 },
 registration(challenge,{origin=ORIGIN,uv=true,up=true,context={}}={}) {
  const length=Buffer.alloc(2);length.writeUInt16BE(credentialId.length);
  const auth=Buffer.concat([data(64+(uv?4:0)+(up?1:0),0),Buffer.alloc(16),length,credentialId,Buffer.from(credential.publicKey)]);
  return {id:credential.id,rawId:credential.id,type:'public-key',clientExtensionResults:{},response:{clientDataJSON:b64(client(challenge,origin,'webauthn.create',context)),attestationObject:b64(encodeCBOR(new Map([['fmt','none'],['attStmt',new Map()],['authData',new Uint8Array(auth)]]))),transports:['internal']}};
 }};
}
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
