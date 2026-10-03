import { ACTIONS } from './adapters.mjs';
// Inventário vem do plano de controle (servidor T3 de cada environment), nunca de input
// do modelo. O snapshot congela os projetos de agora; projetos novos exigem nova aprovação.
export function grantFromInventory({alias,environmentId,label,destination,projects,actions=ACTIONS,readProjectIds}) {
 if(!alias||!environmentId||!label||!destination||!projects?.length||!actions.length) throw new Error('inventory_invalid');
 const ids=new Set();
 const inventory=projects.map(p=>{
  if(!p.id||!p.name||!p.directory||ids.has(p.id)) throw new Error('inventory_invalid');
  ids.add(p.id);return {id:p.id,name:p.name,directory:p.directory,workspaceRoots:[...new Set([p.directory,...(p.workspaceRoots??[])])]};
 }).sort((a,b)=>a.id.localeCompare(b.id));
 const leitura=readProjectIds??[...ids];
 if(actions.some(a=>!ACTIONS.includes(a))||leitura.some(p=>!ids.has(p)))throw new Error('inventory_invalid');
 return {alias,environmentId,label,destination,projects:inventory,actions:[...new Set(actions)].sort(),readProjectIds:[...new Set(leitura)].sort()};
}
export function escopoDosGrants(grants) {
 if(!grants.length) throw new Error('inventory_invalid');
 return {scopeVersion:2,runtimeMode:'full-access',environments:[...grants].sort((a,b)=>a.alias.localeCompare(b.alias))};
}
