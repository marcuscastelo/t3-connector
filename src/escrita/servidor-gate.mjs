// Gate de aprovação (página com passkey, lease em memória) e relay privado de escrita.
// Escuta só em 127.0.0.1, Host localhost:<porta>. Um processo novo começa sem lease.
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,mkdirSync,renameSync,lstatSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {Passkeys} from './webauthn.mjs';
import {phoneHandler} from './phone.mjs';
import {FileJournal} from './journal.mjs';
import {controller} from './controller.mjs';
import {criarConexaoEscrita} from './conexao.mjs';

function diretorioPrivado(dir) {
 mkdirSync(dir,{recursive:true,mode:0o700});
 const s=lstatSync(dir);
 if(s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077))throw new Error('estado_permissions_invalid');
}

export async function iniciarGate(config,{log=console.log}={}) {
 const {porta,estado,canal}=config,origin=`http://localhost:${porta}`;
 diretorioPrivado(estado);
 const store=join(estado,'credentials.json');
 if(!existsSync(store))throw new Error(`passkey não cadastrada: ${store} ausente`);
 if(lstatSync(store).mode&0o077)throw new Error('credential_store_permissions_invalid');
 const credentials=new Map(JSON.parse(readFileSync(store,'utf8')).map(c=>[c.id,{...c,publicKey:Buffer.from(c.publicKey,'base64url')}]));
 const passkeys=new Passkeys({origin,rpID:'localhost',allowLocalhost:true,...config.passkey,credentials,saveCredential:async c=>{
  const next=new Map(credentials);next.set(c.id,c);const temp=join(estado,'credentials.next');
  writeFileSync(temp,JSON.stringify([...next.values()].map(v=>({...v,publicKey:Buffer.from(v.publicKey).toString('base64url')}))),{mode:0o600});renameSync(temp,store);
 }});
 const conexoes=config.ambientes.map(r=>criarConexaoEscrita(r));
 const journal=new FileJournal(join(estado,'write-journal.sqlite'));
 const control=controller({conexoes,passkeys,journal,...canal});
 // Capability do relay rotaciona a cada boot e nunca chega ao modelo nem ao plugin.
 writeFileSync(join(estado,'relay-capability'),control.capability,{mode:0o600});
 const handler=phoneHandler({gate:control.gate,passkeys,origin,allowLocalhost:true,verifyPrivateRoute:req=>req.headers.host===`localhost:${porta}`&&['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)});
 const server=createServer(async(req,res)=>{
  if(req.headers.host!==`localhost:${porta}`){res.writeHead(403);return res.end();}
  if(req.method==='POST'&&['/relay','/local/request'].includes(req.url)){
   res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
   try{
    if(req.url==='/local/request'){
     if(req.headers.origin!==origin||req.headers['content-type']!=='application/json')throw new Error('origin_invalid');
     const r=await control.relay(control.capability,{op:'request'});res.writeHead(200);return res.end(JSON.stringify(r));
    }
    if(req.headers['content-type']!=='application/json')throw new Error('content_type_invalid');
    let parts=[],size=0;for await(const c of req){size+=c.length;if(size>131072)throw new Error('body_too_large');parts.push(c);}
    const request=JSON.parse(Buffer.concat(parts).toString('utf8'));
    const result=await control.relay(req.headers['x-t3-private-relay'],request);res.writeHead(200);res.end(JSON.stringify(result));
   }catch(error){res.writeHead(403);res.end(JSON.stringify({error:/^[a-z_]+$/.test(error.message)?error.message:'relay_rejected'}));}
   return;
  }
  await handler(req,res);
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(porta,'127.0.0.1',resolve);});
 log(`T3 Connector (write): aprovação em ${origin}/; ambientes ${config.ambientes.map(a=>a.alias).join(', ')}; canal ${canal.tunnelId}; sem lease inicial.`);
 const fechar=()=>{control.fechar();server.close();journal.close();};
 return {server,control,fechar,origin};
}
