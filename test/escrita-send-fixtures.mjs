// Conversational intent fixtures: no model call and no text heuristics in production.
const base={threadId:'thread',clientRequestId:'op',text:'instruction'};
export const sendCases=[
 {intent:'corrigir arquitetura do run atual',input:{...base,delivery:'steer_active',targetRunId:'run-current'},wire:{type:'steer_active',targetRunId:'run-current'}},
 {intent:'mudar requisito durante implementação',input:{...base,delivery:'steer_active',targetRunId:'run-current'},wire:{type:'steer_active',targetRunId:'run-current'}},
 {intent:'nova tarefa sem run ativo',input:{...base,delivery:'start_immediately'},wire:{type:'start_immediately'}},
 {intent:'parar e recomeçar explicitamente',input:{...base,delivery:'restart_active',targetRunId:'run-current'},wire:{type:'restart_active',targetRunId:'run-current'}},
 {intent:'revisão posterior explicitamente adiada',input:{...base,delivery:'queue_after_active',deferUntilActiveCompletes:true},wire:{type:'queue_after_active'}},
];
export const unsafeSendCases=[
 {input:{...base,delivery:'queue_after_active',text:'Corrija a arquitetura: reutilize a API existente'},error:'queue_explicit_intent_required'},
 {input:{...base,delivery:'queue_after_active',deferUntilActiveCompletes:false},error:'queue_explicit_intent_required'},
 ...['steer_active','restart_active'].flatMap(delivery=>[undefined,'','   '].map(targetRunId=>({input:{...base,delivery,...(targetRunId!==undefined?{targetRunId}:{})},error:'target_run_id_required'}))),
];
