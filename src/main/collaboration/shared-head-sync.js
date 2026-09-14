"use strict";
const {createHash}=require('node:crypto');
const {createSharedGit}=require('./shared-git');
const {createSharedGitTransport,parseSharedGitDescriptor,createTaskGitTransport,parseGitDescriptor}=require('./task-git-transport');
const fail=code=>Object.assign(Error(`COLLAB_SHARED_SYNC_${code}`),{code:`COLLAB_SHARED_SYNC_${code}`});
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function publication(value,input,accountId){
  if(!value||value.workspaceId!==input.workspaceId||value.conversationId!==input.conversationId||value.ownerUserId!==accountId
    ||!['id','taskId','deliveryId','objectId'].every(key=>id(value[key]))||value.publicationId!==value.id
    ||!['expectedHead','baselineCommit','deliveryCommit','tree'].every(key=>oid(value[key]))
    ||!Number.isSafeInteger(value.revision)||value.revision<1||value.revision>=Number.MAX_SAFE_INTEGER||value.expectedRevision!==value.revision-1
    ||(value.parentPublicationId!==null&&!id(value.parentPublicationId)))throw fail('METADATA_INVALID');
  const parsed=parseSharedGitDescriptor(value.git),git=Object.fromEntries(['version','format','ref','commit','prerequisites','sha256','sizeBytes'].map(key=>[key,parsed[key]])),validation=value.validation;
  if(!git.ref.startsWith(`refs/workspaces/${hash(input.workspaceId)}/candidates/`)||git.commit===value.expectedHead
    ||git.prerequisites.length>2||git.prerequisites.some(commit=>![value.expectedHead,value.baselineCommit].includes(commit))
    ||(git.prerequisites.length>0?(!value.parentPublicationId||!git.prerequisites.includes(value.expectedHead)):value.parentPublicationId!==null)
    ||!validation||validation.commit!==git.commit||typeof validation.policyId!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(validation.policyId)
    ||typeof validation.evidenceHash!=='string'||!/^[a-f0-9]{64}$/.test(validation.evidenceHash))throw fail('METADATA_INVALID');
  return {id:value.id,workspaceId:value.workspaceId,conversationId:value.conversationId,ownerUserId:value.ownerUserId,
    taskId:value.taskId,deliveryId:value.deliveryId,objectId:value.objectId,expectedHead:value.expectedHead,expectedRevision:value.expectedRevision,
    revision:value.revision,baselineCommit:value.baselineCommit,deliveryCommit:value.deliveryCommit,tree:value.tree,git,
    validation:{commit:validation.commit,policyId:validation.policyId,evidenceHash:validation.evidenceHash},parentPublicationId:value.parentPublicationId};
}

/** Main-only acquisition of a verified server snapshot, never a lease grant.
 * Immutable packs may be cached; authority, metadata and exact Git structure
 * are rechecked before shared-head CAS. Private W and pending candidates stay
 * untouched. A publisher must still acquire server qualification and use CAS. */
function createSharedHeadSync({taskGit,client,sharedFiles,accountId,deviceId,assertActive,authorize}){
  if(typeof assertActive!=='function'||typeof authorize!=='function')throw TypeError('Shared head acquisition requires fresh guards');
  const shared=createSharedGit(taskGit),transport=createSharedGitTransport(taskGit);
  return Object.freeze({async acquire({input,baseline}){
    const active=()=>assertActive();
    const authorized=async()=>{active();if(await authorize(input)!==true)throw fail('ACCESS_DENIED');active();};
    await authorized();
    const {git,repository}=await taskGit.ensure(),headRef=`refs/workspaces/${hash(input.workspaceId)}/head`;
    const expectedHead=await git(['rev-parse','--verify',headRef]).catch(()=>null),previous=await shared.remoteState(input.workspaceId);
    active();
    const scope={deviceId,workspaceId:input.workspaceId,taskId:input.taskId,deliveryId:input.deliveryId};
    const readTarget=async()=>{
      const target=await client.getIntegrationTarget(scope);active();
      if(!target||target.workspaceId!==input.workspaceId||!oid(target.headCommit)||!Number.isSafeInteger(target.revision)||target.revision<0||target.revision>=Number.MAX_SAFE_INTEGER)throw fail('METADATA_INVALID');
      if(target.initialized===false)throw fail('BASELINE_UNAVAILABLE');
      return {commit:target.headCommit,revision:target.revision,baselineReady:target.baselineReady===true};
    };
    const target=await readTarget();
    if(previous&&target.revision<previous.revision)throw Object.assign(Error('Remote head regressed'),{code:'COLLAB_SHARED_GIT_REMOTE_REGRESSED'});
    let revision,publicationId=null,publicationDepth=0;
    if(target.revision===0){
      if(target.baselineReady){
        const download=await sharedFiles.downloadBaseline({conversationId:input.conversationId,workspaceId:input.workspaceId});active();
        if(download?.ok!==true)throw fail('PACKAGE_UNAVAILABLE');
        const value=download.baseline;
        if(!value||value.workspaceId!==input.workspaceId||value.conversationId!==input.conversationId||value.ownerUserId!==accountId
          ||!id(value.sourceTaskId)||!id(value.objectId))throw fail('METADATA_INVALID');
        const descriptor=parseGitDescriptor(value.git);
        if(descriptor.commit!==target.commit||descriptor.prerequisites.length||!descriptor.ref.endsWith('/baseline'))throw fail('METADATA_INVALID');
        revision=await createTaskGitTransport(taskGit).importBundle({packagePath:download.packagePath,descriptor});active();
        if(await git(['rev-list','--parents','-n','1',revision.commit])!==revision.commit)throw fail('ANCESTRY_INVALID');
        await taskGit.inspectTree(revision.commit);active();
      }else{
        if(baseline?.commit!==target.commit||baseline.repository!==repository||!await taskGit.hasRevision(baseline))throw fail('BASELINE_UNAVAILABLE');
        revision=baseline;
      }
    }else{
      const chain=[],seen=new Set();let requested;
      do{
        const result=await client.getIntegrationPublication({deviceId,workspaceId:input.workspaceId,...(requested?{publicationId:requested}:{})});active();
        if(result?.workspaceId!==input.workspaceId)throw fail('METADATA_INVALID');
        const value=publication(result.publication,input,accountId),child=chain.at(-1);
        if(requested&&value.id!==requested||seen.has(value.id)||chain.length>=64)throw fail('CHAIN_INVALID');
        if(!child&&(value.git.commit!==target.commit||value.revision!==target.revision))throw fail('HEAD_CHANGED');
        if(child&&(child.expectedHead!==value.git.commit||child.expectedRevision!==value.revision))throw fail('CHAIN_INVALID');
        chain.push(value);seen.add(value.id);requested=value.parentPublicationId;
      }while(requested);
      for(const value of [...chain].reverse()){
        active();const download=await sharedFiles.download({conversationId:input.conversationId,workspaceId:input.workspaceId,publicationId:value.id});active();
        if(download?.ok!==true)throw fail('PACKAGE_UNAVAILABLE');
        if(JSON.stringify(publication(download.publication,input,accountId))!==JSON.stringify(value))throw fail('METADATA_CHANGED');
        const imported=await transport.importBundle({packagePath:download.packagePath,descriptor:value.git});active();
        if(await git(['rev-parse',`${imported.commit}^{tree}`])!==value.tree
          ||await git(['rev-list','--parents','-n','1',imported.commit])!==`${imported.commit} ${value.expectedHead} ${value.deliveryCommit}`
          ||await git(['rev-list','--parents','-n','1',value.deliveryCommit])!==`${value.deliveryCommit} ${value.baselineCommit}`)throw fail('ANCESTRY_INVALID');
        await taskGit.inspectTree(imported.commit);active();revision=imported;
      }
      publicationId=chain[0].id;
      publicationDepth=chain.length;
      // Recheck the complete server dependency chain even if its bytes were
      // cached or an earlier download overlapped administrative retirement.
      const current=await client.getIntegrationPublication({deviceId,workspaceId:input.workspaceId});active();
      if(current?.workspaceId!==input.workspaceId||JSON.stringify(publication(current.publication,input,accountId))!==JSON.stringify(chain[0]))throw fail('HEAD_CHANGED');
    }
    await authorized();
    if(JSON.stringify(await readTarget())!==JSON.stringify(target))throw fail('HEAD_CHANGED');
    const head=await shared.reconcileRemote({workspaceId:input.workspaceId,revision,remoteRevision:target.revision,publicationId,
      expectedHead,expectedRemoteState:previous?.object||null,assertCurrent:active});
    return {...head,publicationDepth};
  }});
}
module.exports={createSharedHeadSync};
