"use strict";
const {createHash}=require('node:crypto');
const {leaseInput}=require('./integration-lease-contract.cjs');
const fail=()=>{throw Object.assign(Error('COLLAB_PUBLICATION_INVALID'),{code:'COLLAB_PUBLICATION_INVALID'});};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))fail();}
function publicationInput(value){
  exact(value,['workspaceId','taskId','deliveryId','expectedHead','expectedRevision','leaseId','generation','publicationId','objectId','baselineCommit','deliveryCommit','tree','git','validation']);
  const {publicationId,objectId,baselineCommit,deliveryCommit,tree,git,validation,...lease}=value;
  const bound=leaseInput(lease,'renew');
  exact(git,['version','format','ref','commit','prerequisites','sha256','sizeBytes']);
  const workspaceHash=createHash('sha256').update(JSON.stringify(bound.workspaceId)).digest('hex');
  if(!id(publicationId)||!id(objectId)||![baselineCommit,deliveryCommit,tree,git.commit].every(oid)
    ||git.version!==1||git.format!=='git-bundle-v2'||typeof git.ref!=='string'||!new RegExp(`^refs/workspaces/${workspaceHash}/candidates/[a-f0-9]{64}$`).test(git.ref)
    ||!digest(git.sha256)||!Number.isSafeInteger(git.sizeBytes)||git.sizeBytes<1||git.sizeBytes>256*1024*1024
    ||!Array.isArray(git.prerequisites)||git.prerequisites.length>2||new Set(git.prerequisites).size!==git.prerequisites.length
    ||git.prerequisites.some(commit=>![bound.expectedHead,baselineCommit].includes(commit))
    ||git.prerequisites.length&&!git.prerequisites.includes(bound.expectedHead)||git.commit===bound.expectedHead)fail();
  exact(validation,['commit','policyId','evidenceHash']);
  if(validation.commit!==git.commit||typeof validation.policyId!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(validation.policyId)||!digest(validation.evidenceHash))fail();
  return {...bound,publicationId,objectId,baselineCommit,deliveryCommit,tree,git:{...git,prerequisites:[...git.prerequisites].sort()},validation:{...validation}};
}
module.exports={publicationInput};
