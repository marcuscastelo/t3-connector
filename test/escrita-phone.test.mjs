import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { phoneHandler } from '../src/escrita/phone.mjs';
import { Passkeys } from '../src/escrita/webauthn.mjs';
import { setup,ORIGIN,RPID,authenticator } from './escrita-fixtures.mjs';
async function request(handler,path,{method='POST',origin=ORIGIN,data={},cookie,privateRoute=true,raw}={}) {
 const req=Readable.from([Buffer.from(raw??JSON.stringify(data))]);
 Object.assign(req,{url:path,method,headers:{origin,'content-type':'application/json',cookie},socket:{remoteAddress:'127.0.0.1'},privateRoute});
 const headers={};let code,body;
 const res={setHeader:(k,v)=>headers[k]=v,writeHead:(status,h)=>{code=status;Object.assign(headers,h);},end:v=>body=Buffer.isBuffer(v)?v.toString():v};
 await handler(req,res);return {code,headers,body,json:headers['Content-Type']==='application/json'?JSON.parse(body):null};
}
function handler(s) {return phoneHandler({gate:s.gate,passkeys:s.passkeys,origin:ORIGIN,verifyPrivateRoute:async req=>req.privateRoute});}
test('phone shows exact scope, performs real assertion, sets secure session, revokes',async()=>{const s=setup(),h=handler(s),r=s.gate.request(s.caller,s.scope),prefix=`/requests/${r.requestId}`;
 const view=await request(h,prefix+'/view');assert.equal(view.code,200);assert.deepEqual(view.json.scope.environments[0].projects,s.env.projects);
 const options=await request(h,prefix+'/options');assert.equal(options.json.userVerification,'required');
 const granted=await request(h,prefix+'/approve',{data:{response:s.auth.assertion(options.json.challenge)}});assert.equal(granted.code,200);assert.match(granted.headers['Set-Cookie'],/HttpOnly; Secure; SameSite=Strict/);
 const cookie=granted.headers['Set-Cookie'].split(';')[0];assert.equal((await request(h,'/status',{cookie})).json.active,true);
 assert.equal((await request(h,'/revoke',{cookie})).code,200);assert.throws(()=>s.gate.check(s.caller,granted.json.leaseId,s.target));assert.equal((await request(h,'/status',{cookie})).code,401);
});
test('wrong origin, private route and unauthenticated revoke rejected',async()=>{const s=setup(),h=handler(s),r=s.gate.request(s.caller,s.scope);for(const options of [{origin:'https://evil.test'},{privateRoute:false}]) assert.equal((await request(h,`/requests/${r.requestId}/options`,options)).code,403);assert.equal((await request(h,'/revoke')).code,401);assert.equal((await request(h,'/status',{method:'GET'})).code,403);});
test('replayed approval cannot recreate a lease; status after restart closed',async()=>{const s=setup(),h=handler(s),r=s.gate.request(s.caller,s.scope),prefix=`/requests/${r.requestId}`,options=await request(h,prefix+'/options'),data={response:s.auth.assertion(options.json.challenge)};const first=await request(h,prefix+'/approve',{data});assert.equal(first.code,200);assert.equal((await request(h,prefix+'/approve',{data})).code,400);const restarted=handler(setup());assert.equal((await request(restarted,'/status',{cookie:first.headers['Set-Cookie'].split(';')[0]})).code,401);});
test('body limits, rate limits and no secret echo',async()=>{const h=handler(setup());const response=await request(h,'/status',{raw:'x'.repeat(70000)});assert.equal(response.code,400);assert.equal(response.json.error,'body_too_large');assert.ok(!response.body.includes('xxxx'));let last;for(let i=0;i<61;i++)last=await request(h,'/status');assert.equal(last.code,429);});
test('page and scripts served locally with CSP and no-store',async()=>{const h=handler(setup());for(const path of ['/','/app.js','/passkeys.js']){const r=await request(h,path,{method:'GET'});assert.equal(r.code,200);assert.equal(r.headers['Cache-Control'],'no-store');assert.match(r.headers['Content-Security-Policy'],/frame-ancestors 'none'/);}const html=await request(h,'/',{method:'GET'});assert.match(html.body,/Revoke new commands/);assert.match(html.body,/60 minutes/);});
test('private enrollment ticket single-use; actual registration and no lease',async()=>{const s=setup(),auth=authenticator(),credentials=new Map(),passkeys=new Passkeys({origin:ORIGIN,rpID:RPID,credentials,saveCredential:async()=>{}}),ticket='fixture-private-bootstrap-ticket';const h=phoneHandler({gate:s.gate,passkeys,origin:ORIGIN,verifyPrivateRoute:async()=>true,enrollmentTicket:{value:ticket,ttlMs:120000}});
 assert.equal((await request(h,'/enrollment/options',{data:{ticket:'wrong'}})).code,400);
 const options=await request(h,'/enrollment/options',{data:{ticket}});assert.equal(options.code,200);assert.equal((await request(h,'/enrollment/options',{data:{ticket}})).code,400);
 const data={registrationId:options.json.registrationId,response:auth.registration(options.json.options.challenge)};
 assert.equal((await request(h,'/enrollment/finish',{data})).code,200);assert.equal((await request(h,'/enrollment/finish',{data})).code,400);assert.equal(credentials.size,1);assert.equal((await request(h,'/status')).code,401);
});
test('localhost exception is explicit and never accepts HTTP LAN or remote hosts',()=>{
 const common={credentials:new Map(),saveCredential:async()=>{}};
 assert.throws(()=>new Passkeys({...common,origin:'http://localhost:7432',rpID:'localhost'}));
 assert.throws(()=>new Passkeys({...common,origin:'http://evil.test:7432',rpID:'evil.test',allowLocalhost:true}));
 assert.throws(()=>new Passkeys({...common,origin:'http://192.0.2.10:7432',rpID:'192.0.2.10',allowLocalhost:true}));
 assert.doesNotThrow(()=>new Passkeys({...common,origin:'http://localhost:7432',rpID:'localhost',allowLocalhost:true}));
 const s=setup();assert.throws(()=>phoneHandler({gate:s.gate,passkeys:s.passkeys,origin:'http://localhost:7432',verifyPrivateRoute:()=>true}));
});
test('native enrollment requires success, serializes pending OS confirmations and verifies actual localhost UV',async()=>{
 const origin='http://localhost:7432',s=setup(),auth=authenticator({rpID:'localhost'}),credentials=new Map();
 const passkeys=new Passkeys({origin,rpID:'localhost',allowLocalhost:true,credentials,saveCredential:async()=>{}});
 let allow=false,calls=0,release;
 const h=phoneHandler({gate:s.gate,passkeys,origin,allowLocalhost:true,verifyPrivateRoute:()=>true,verifyEnrollment:async()=>{calls++;if(!allow)return false;return await new Promise(r=>release=r);}});
 assert.equal((await request(h,'/enrollment/options',{origin:'http://evil.test'})).code,403);assert.equal(calls,0);
 assert.equal((await request(h,'/enrollment/options',{origin})).code,400);allow=true;
 const pending=request(h,'/enrollment/options',{origin});await new Promise(r=>setImmediate(r));
 assert.equal((await request(h,'/enrollment/options',{origin})).code,400);assert.equal(calls,2);release(true);
 const options=await pending;assert.equal(options.code,200);assert.equal(options.json.options.authenticatorSelection.userVerification,'required');
 assert.equal((await request(h,'/enrollment/options',{origin})).code,400);
 const data={registrationId:options.json.registrationId,response:auth.registration(options.json.options.challenge,{origin})};
 assert.equal((await request(h,'/enrollment/finish',{origin,data})).code,200);assert.equal(credentials.size,1);
 assert.equal((await request(h,'/status',{origin})).code,401);assert.equal((await request(h,'/enrollment/finish',{origin,data})).code,400);
});
