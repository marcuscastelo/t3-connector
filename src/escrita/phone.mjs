import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const opaque=()=>randomBytes(32).toString('base64url');
const hash=s=>createHash('sha256').update(s).digest();
const root=new URL('../../',import.meta.url);
// Resolve pelo Node: no runtime instalado as dependências ficam fora do pacote.
const navegador=join(dirname(dirname(createRequire(import.meta.url).resolve('@simplewebauthn/browser'))),'dist/bundle/index.umd.min.js');
const assets=new Map([
 ['/', ['text/html; charset=utf-8',readFileSync(new URL('web/aprovacao.html',root))]],
 ['/app.js',['text/javascript; charset=utf-8',readFileSync(new URL('web/app.js',root))]],
 ['/passkeys.js',['text/javascript; charset=utf-8',readFileSync(navegador)]],
]);
async function body(req) {
 let size=0,parts=[];
 for await(const chunk of req) {size+=chunk.length;if(size>65536) throw new Error('body_too_large');parts.push(chunk);}
 return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
// No listener is started here. Deployment must supply a verified private HTTPS route.
export function phoneHandler({gate,passkeys,origin,verifyPrivateRoute,enrollmentTicket,verifyEnrollment,allowLocalhost=false,clock=()=>Date.now()}) {
 const u=new URL(origin);
 if((u.protocol!=='https:' && !(allowLocalhost && u.protocol==='http:' && u.hostname==='localhost')) || !verifyPrivateRoute) throw new Error('private_https_required');
 const sessions=new Map(),enrollments=new Map(),rates=new Map();
 let bootstrap=enrollmentTicket?{hash:hash(enrollmentTicket.value),deadline:clock()+enrollmentTicket.ttlMs}:null;
 let enrollmentBusy=false;
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  try {
   if(!await verifyPrivateRoute(req)) return json(403,{error:'private_route_required'});
   const ip=req.socket.remoteAddress;
   for(const [k,v] of rates) if(v.until<clock()) rates.delete(k);
   if(rates.size>1000) throw new Error('rate_limited');
   const rate=rates.get(ip)||{count:0,until:clock()+60000};rates.set(ip,rate);
   if(++rate.count>60) return json(429,{error:'rate_limited'});
   for(const [k,v] of sessions) if(v.deadline<=clock()) sessions.delete(k);
   for(const [k,v] of enrollments) if(v.deadline<=clock()) enrollments.delete(k);
   const url=new URL(req.url,origin);
   if(req.method==='GET' && assets.has(url.pathname)) {const [type,data]=assets.get(url.pathname);res.writeHead(200,{'Content-Type':type});return res.end(data);}
   if(req.method!=='POST' || req.headers.origin!==origin || req.headers['content-type']!=='application/json') return json(403,{error:'origin_or_method_invalid'});
   const p=await body(req), match=/^\/requests\/([A-Za-z0-9_-]{43})\/(view|options|approve)$/.exec(url.pathname);
   if(match) {
    const [,requestId,action]=match;
    if(action==='view') return json(200,gate.view(requestId));
    if(action==='options') {
     // Fail enrollment before consuming this request's challenge.
     if(!passkeys.credentials.size) throw new Error('enrollment_required');
     return json(200,await passkeys.options(gate.challenge(requestId,origin)));
    }
    const status=await gate.approve(requestId,{response:p.response,origin:req.headers.origin});
    const sid=opaque();sessions.set(sid,{leaseId:status.leaseId,credentialId:status.credentialId,deadline:clock()+3600000});
    res.setHeader('Set-Cookie',`__Host-t3-approval=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600`);
    return json(200,status);
   }
   if(['/status','/revoke'].includes(url.pathname)) {
    const sid=/(?:^|; )__Host-t3-approval=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie||'')?.[1], session=sessions.get(sid);
    if(!session||session.deadline<=clock()) return json(401,{error:'session_invalid'});
    if(url.pathname==='/status') return json(200,gate.status(session.leaseId));
    gate.revoke(session.leaseId,session.credentialId);sessions.delete(sid);
    res.setHeader('Set-Cookie','__Host-t3-approval=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
    return json(200,{active:false});
   }
   if(url.pathname==='/enrollment/options') {
    if(passkeys.credentials.size||enrollmentBusy||enrollments.size) throw new Error('enrollment_denied');
    enrollmentBusy=true;
    try {
     if(verifyEnrollment) { if(!await verifyEnrollment(req)) throw new Error('enrollment_denied'); }
     else {if(!bootstrap||bootstrap.deadline<=clock()||typeof p.ticket!=='string'||!timingSafeEqual(hash(p.ticket),bootstrap.hash)) throw new Error('enrollment_denied');bootstrap=null;}
    } finally {enrollmentBusy=false;}
    const registrationId=opaque(),challenge=opaque();
    enrollments.set(registrationId,{challenge,deadline:clock()+120000});
    return json(200,{registrationId,options:await passkeys.registrationOptions(challenge,randomBytes(32))});
   }
   if(url.pathname==='/enrollment/finish') {
    const enrollment=enrollments.get(p.registrationId);enrollments.delete(p.registrationId);
    if(!enrollment||enrollment.deadline<=clock()||passkeys.credentials.size) throw new Error('enrollment_denied');
    await passkeys.register(p.response,enrollment.challenge);return json(200,{enrolled:true});
   }
   return json(404,{error:'not_found'});
  } catch(error) {
   // Only stable codes; never echo WebAuthn response, bootstrap input or adapter error.
   const code=/^[a-z_]+$/.test(error.message)?error.message:'verification_failed';
   return json(400,{error:code});
  }
 };
}
