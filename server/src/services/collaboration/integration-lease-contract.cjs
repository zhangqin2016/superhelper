"use strict";
const fail=()=>{throw Object.assign(Error('COLLAB_INTEGRATION_INVALID'),{code:'COLLAB_INTEGRATION_INVALID'});};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
function leaseInput(value,action){
  const allowed=['workspaceId','taskId','deliveryId'];
  if(action!=='get')allowed.push('expectedHead','expectedRevision');
  if(['renew','release'].includes(action))allowed.push('leaseId','generation');
  if(!['get','claim','renew','release'].includes(action)||!value||typeof value!=='object'||Array.isArray(value)
    ||Object.keys(value).some(key=>!allowed.includes(key))||['workspaceId','taskId','deliveryId'].some(key=>!id(value[key])))fail();
  if(action!=='get'&&(!/^[a-f0-9]{40}$/.test(value.expectedHead||'')||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<0||value.expectedRevision>=Number.MAX_SAFE_INTEGER))fail();
  if(['renew','release'].includes(action)&&(!id(value.leaseId)||!Number.isSafeInteger(value.generation)||value.generation<1||value.generation>=Number.MAX_SAFE_INTEGER))fail();
  return Object.fromEntries(allowed.map(key=>[key,value[key]]));
}
module.exports={leaseInput};
