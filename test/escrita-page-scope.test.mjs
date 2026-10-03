import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
test('página mostra cada environment, seus projetos, roots e ações como texto',async()=>{
 const nodes=new Map();const get=id=>{if(!nodes.has(id))nodes.set(id,{hidden:true,textContent:'',children:[],append(child){this.children.push(child);}});return nodes.get(id);};
 const scope={scopeVersion:2,runtimeMode:'full-access',caller:'verified',environments:[
  {alias:'local',environmentId:'env-p',destination:'t3://env-p',projects:[{id:'app',name:'app',directory:'/Users/dev/app',workspaceRoots:['/Users/dev/app','/worktrees/app']}],actions:['thread.launch'],readProjectIds:['app']},
  {alias:'remoto',environmentId:'env-s',destination:'t3://env-s',projects:[{id:'app',name:'app',directory:'/home/dev/app',workspaceRoots:['/home/dev/app']}],actions:['thread.send','thread.settle'],readProjectIds:['app']}]};
 const context={document:{getElementById:get,createElement:()=>({textContent:''})},location:{hash:'#request=r'},URLSearchParams,window:{isSecureContext:true,PublicKeyCredential:function(){}},fetch:async()=>({ok:true,json:async()=>({scope,scopeHash:'hash'})}),setInterval:()=>{},Date,SimpleWebAuthnBrowser:{}};
 runInNewContext(readFileSync(new URL('../web/app.js',import.meta.url),'utf8'),context);
 for(let i=0;i<8;i++)await Promise.resolve();
 assert.match(get('environment').textContent,/local · env-p.*remoto · env-s/);
 const projetos=get('projects').children.map(c=>c.textContent);
 assert.equal(projetos.length,2);
 assert.match(projetos[0],/^\[local\].*\/worktrees\/app/);
 assert.match(projetos[1],/^\[remoto\].*\/home\/dev\/app/);
 assert.match(get('actions').children[1].textContent,/^\[remoto\] 2 actions: thread.send, thread.settle/);
 assert.equal(get('approve').hidden,false);
});
