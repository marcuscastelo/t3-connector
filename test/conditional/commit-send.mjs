// Another process of the same caller with a valid lease: reserves, sends and completes
// thread.send under the given operationId on the shared FileJournal. Prints the result.
import {FileJournal} from '../../src/escrita/journal.mjs';
import {Dispatcher} from '../../src/escrita/adapters.mjs';
import {identidadeCanal,exigirIdentidade} from '../../src/escrita/identidade.mjs';

const [path,operationId,text]=process.argv.slice(2);
const journal=new FileJournal(path),identity=identidadeCanal({organization:'org',tunnelId:'tunnel_fixture'}),caller=exigirIdentidade(identity);
const grant={environmentId:'e',destination:'t3://e',actions:['thread.send'],projects:[{id:'app',directory:'/w/app'}]};
const gate={status:()=>({active:true,scope:{caller,environments:[grant]}}),check(){},close(){},audit(){},dispatch:async(_i,_l,_t,invoke)=>invoke()};
const d=new Dispatcher({journal,gate,environmentId:'e',destination:'t3://e',adapter:{projectForThread:async()=>'app',invoke:async()=>({sequence:1}),receipt:r=>r}});
const r=await d.dispatch(identity,'lease',{action:'thread.send',operationId,input:{threadId:'thread',clientRequestId:operationId,text,delivery:'start_immediately'}});
console.log(JSON.stringify(r));
journal.close();
