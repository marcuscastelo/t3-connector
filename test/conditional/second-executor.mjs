// Child process for the cross-process conditional send regression: one executor of a
// conditional send over a FileJournal shared with another process. `first` pauses in
// adapter.prepare after the Dispatcher reserved <id>:send, until the parent says continue.
import {FileJournal} from '../../src/escrita/journal.mjs';
import {conditionalSend} from '../../src/escrita/conditional.mjs';
import {Dispatcher} from '../../src/escrita/adapters.mjs';
import {identidadeCanal,exigirIdentidade} from '../../src/escrita/identidade.mjs';

const [path,role]=process.argv.slice(2);
const identity=identidadeCanal({organization:'org',tunnelId:'tunnel_fixture'}),caller=exigirIdentidade(identity);
const journal=new FileJournal(path);
const grant={environmentId:'e',destination:'t3://e',actions:['thread.send'],projects:[{id:'app',directory:'/w/app'}]};
const gate={status:()=>({active:true,scope:{caller,environments:[grant]}}),check(){},close(){},audit(){},dispatch:async(_i,_l,_t,invoke)=>invoke()};
const adapter={projectForThread:async()=>'app',
 prepare:async()=>{if(role==='first'){process.send({event:'preparing'});await new Promise(r=>process.once('message',r));}},
 invoke:async()=>{process.send({event:'sent'});return {sequence:1};},receipt:r=>r};
const d=new Dispatcher({gate,adapter,journal,environmentId:'e',destination:'t3://e'});
const host={caller,environment:{environmentId:'e',destination:'t3://e'},journal,authorize(){},audit(){},failClosed(){},
 observe:async()=>({projectId:'app',latestRunId:'r1',status:'completed',activeRunId:null}),
 dispatch:(action,operationId,input)=>d.dispatch(identity,'lease',{action,operationId,input})};
const input={threadId:'t',clientRequestId:'same',afterRunId:'r1',text:'once'};
const result=await conditionalSend(host,'same',input);
process.send({event:'result',result});
if(role==='second'){await new Promise(r=>process.once('message',r));process.send({event:'replay',result:await conditionalSend(host,'same',input)});}
journal.close();process.disconnect();
