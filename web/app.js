'use strict';
const el=id=>document.getElementById(id);
const api=async(path,data={})=>{const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),credentials:'same-origin'});const v=await r.json();if(!r.ok)throw new Error(v.error);return v;};
let requestId=new URLSearchParams(location.hash.slice(1)).get('request');
const say=text=>el('status').textContent=text;
let expiry=0;
function active(status){expiry=status.expiresAt;el('approve').hidden=true;el('revoke').hidden=!status.active;say(status.active?'Authorized ('+(status.scope?.environments??[]).map(e=>e.alias).join(', ')+'). Server deadline: '+new Date(expiry).toLocaleString():'Authorization ended.');}
async function main(){
 if(!window.isSecureContext||!window.PublicKeyCredential)throw new Error('This browser must support passkeys over HTTPS.');
 if(location.hash==='#enroll'){el('enroll').hidden=false;say('Check the screen lock and the passkey provider of your device.');return;}
 if(!requestId)requestId=(await api('/local/request')).requestId;
 if(requestId){const v=await api(`/requests/${encodeURIComponent(requestId)}/view`);const envs=v.scope.environments;
  el('environment').textContent=`Environments: ${envs.map(e=>`${e.alias} · ${e.environmentId}`).join(' | ')}`;el('caller').textContent=`Caller: ${v.scope.caller}\nDestinations: ${envs.map(e=>e.destination).join(', ')}`;
  for(const e of envs)for(const p of e.projects){const li=document.createElement('li');li.textContent=`[${e.alias}] ${p.name} · ${p.id} · ${p.directory} · Workspaces: ${(p.workspaceRoots??[p.directory]).join(', ')}`;el('projects').append(li);}
  for(const e of envs){const li=document.createElement('li');li.textContent=`[${e.alias}] ${e.actions.length} actions: ${e.actions.join(', ')}`;el('actions').append(li);}
  el('reading').textContent=`Reads during the authorization: ${envs.map(e=>`[${e.alias}] ${e.readProjectIds.length} project(s)`).join('; ')}. IDs from one environment are not valid in another.`;
  el('fingerprint').textContent=`Scope: ${v.scopeHash}`;el('scope').hidden=false;el('approve').hidden=false;say('Review the environments, projects and actions before approving.');
 }else active(await api('/status'));
}
el('approve').onclick=async()=>{el('approve').disabled=true;try{const optionsJSON=await api(`/requests/${requestId}/options`);const response=await SimpleWebAuthnBrowser.startAuthentication({optionsJSON});active(await api(`/requests/${requestId}/approve`,{response}));}catch(e){say(`Not authorized: ${e.message}. To try again, create a new request.`);}};
el('revoke').onclick=async()=>{try{await api('/revoke');el('revoke').hidden=true;say('Revoked. Work already dispatched continues.');}catch(e){say(e.message);}};
el('register').onclick=async()=>{el('register').disabled=true;try{const ticket=el('ticket').value;el('ticket').value='';const v=await api('/enrollment/options',{ticket});const response=await SimpleWebAuthnBrowser.startRegistration({optionsJSON:v.options});await api('/enrollment/finish',{registrationId:v.registrationId,response});say('Passkey registered. Now create an approval request.');}catch(e){say('Registration not completed: '+e.message);}};
setInterval(async()=>{if(!expiry)return;try{active(await api('/status'));}catch{expiry=0;el('revoke').hidden=true;say('Authorization ended or unavailable.');}},15000);
main().catch(e=>say(e.message));
