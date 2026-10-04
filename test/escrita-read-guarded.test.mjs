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
