import test from 'node:test';
import assert from 'node:assert/strict';
import {leituraProtegida,clienteFiltrado} from '../src/escrita/read-guarded.mjs';

const cliente={shell:async()=>({projects:[{id:'one',title:'one',workspaceRoot:'/one'},{id:'two',title:'two',workspaceRoot:'/two'},{id:'future',title:'f',workspaceRoot:'/f'}],threads:[{id:'t',projectId:'one',title:'t',status:'completed',latestRunId:'r'},{id:'hidden',projectId:'future',title:'h',status:'completed',latestRunId:'r'}]}),thread:async()=>({projection:{messages:[],runs:[]}})};
const ambiente={alias:'remoto',environmentId:'env-s'};
const grant={readProjectIds:['one','two']};

test('leitura exige lease válida antes e depois e filtra projetos fora do grant',async()=>{
 const r=await leituraProtegida({verificar:()=>grant,cliente,ambiente,operation:'t3_projetos',input:{}});
 assert.deepEqual(JSON.parse(r.content[0].text).projects.map(p=>p.projectId),['one','two']);
 await assert.rejects(leituraProtegida({verificar:()=>{throw new Error('lease_closed');},cliente,ambiente,operation:'t3_projetos',input:{}}),/lease_closed/);
 await assert.rejects(leituraProtegida({verificar:()=>grant,cliente,ambiente,operation:'t3_threads',input:{projectId:'future'}}),/scope_denied/);
});

test('lease vencida durante a leitura não devolve o que já foi buscado',async()=>{
 let n=0;
 await assert.rejects(leituraProtegida({verificar:()=>{if(++n>1)throw new Error('lease_closed');return grant;},cliente,ambiente,operation:'t3_projetos',input:{}}),/lease_closed/);
});

test('cliente filtrado não lê thread de projeto fora do grant',async()=>{
 const f=clienteFiltrado(cliente,new Set(['one']));
 assert.deepEqual((await f.shell()).threads.map(t=>t.id),['t']);
 await assert.rejects(f.thread('hidden'),/thread_not_found/);
});

test('leitura sob lease: t3_thread com settlementContractVersion lê o snapshot completo com a mesma ACL',async()=>{
 const projection={thread:{id:'t'},runs:[{id:'r',ordinal:1,status:'completed'}],runtimeRequests:[],messages:[],turnItems:[],providerSessions:[]};
 const completo={...cliente,thread:async()=>({projection,hasMoreHistory:false}),threadCompleto:async id=>{if(id!=='t')throw new Error('unexpected');return {snapshotSequence:3,projection};}};
 const f=clienteFiltrado(completo,new Set(['one']));
 await assert.rejects(f.threadCompleto('hidden'),/thread_not_found/);
 const r=await leituraProtegida({verificar:()=>grant,cliente:completo,ambiente,operation:'t3_thread',input:{threadId:'t',settlementContractVersion:1}});
 const s=JSON.parse(r.content[0].text).settlement;
 assert.equal(s.complete,true);
 assert.equal(s.expectedRunId,'r');
 assert.equal(s.eligibleMechanically,true);
});
