"use strict";
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {createTaskRecords}=require('./task-records');
const {createSharedHeadSync}=require('./shared-head-sync');
const {createSharedGitTransport,parseSharedGitDescriptor}=require('./task-git-transport');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=code=>Object.assign(Error(`COLLAB_REMOTE_PUBLICATION_${code}`),{code:`COLLAB_REMOTE_PUBLICATION_${code}`});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const receipt=value=>({workspaceId:value.workspaceId,publicationId:value.id,headCommit:value.git.commit,revision:value.revision});

/** One native attempt, with persisted publication and retired-upload identity.
 * Local completion requires a freshly read committed server publication. A
 * renewal response or historical lease receipt never proves publication. */
function createRemotePublication({store,taskGit,client,transfers,deviceId,input,intentId,assertActive,assertAccountActive,authorize,clock=()=>performance.now()}){
  const records=createTaskRecords({store,assertActive}),scope={deviceId,workspaceId:input.workspaceId,taskId:input.taskId,deliveryId:input.deliveryId};
  let held=null,deadline=0,lost=false,closed=false,timer=null,renewing=null,closing=null,publicationDepth=0;
  const assertCurrent=()=>{if(closed||lost||held&&clock()>=deadline)throw fail('FENCED');};
  const active=()=>{assertActive();assertCurrent();};
  const authorized=async()=>{active();if(await authorize(input)!==true)throw fail('ACCESS_DENIED');active();};
  const save=(id,patch)=>{active();return records.put(id,{...records.get(id),...patch,id,conversationId:input.conversationId,intentId,updatedAt:store.now()});};
  const sync=createSharedHeadSync({taskGit,client,sharedFiles:transfers.sharedFiles,accountId:store.accountId,deviceId,assertActive:active,authorize});
  function acceptLease(value,request,start){
    if(typeof request.leaseId!=='string'||!Number.isSafeInteger(request.generation)||request.generation<1
      ||!value||value.workspaceId!==input.workspaceId||value.headCommit!==request.expectedHead||value.revision!==request.expectedRevision
      ||value.lease?.id!==request.leaseId||value.generation!==request.generation||value.lease.deviceId!==deviceId
      ||value.lease.taskId!==input.taskId||value.lease.deliveryId!==input.deliveryId||value.lease.active!==true
      ||!Number.isFinite(value.serverTime)||!Number.isFinite(value.lease.expiresAt))throw fail('FENCED');
    const remaining=value.lease.expiresAt-value.serverTime-(clock()-start)-100;
    if(remaining<=0||remaining>30000)throw fail('FENCED');
    deadline=clock()+remaining;held=request;
  }
  function stopTimer(){if(timer)clearInterval(timer);timer=null;}
  async function renew(){
    active();if(!held)return;
    const request={...held,clientCommandId:randomUUID()},start=clock();
    try{const value=await client.renewIntegration(request);active();acceptLease(value,held,start);}catch(error){lost=true;throw error;}
  }
  function startTimer(){timer=setInterval(()=>{
    if(renewing||closed||!held)return;
    renewing=renew().catch(()=>{lost=true;}).finally(()=>{renewing=null;});
  },5000);timer.unref?.();}
  const attemptId=(candidate,validation)=>`remote-publication:${hash([intentId,candidate.commit,validation.evidenceHash])}`;
  function matches(value,request){
    return value&&value.id===request.publicationId&&value.publicationId===request.publicationId&&value.ownerUserId===store.accountId
      &&value.conversationId===input.conversationId&&value.workspaceId===input.workspaceId&&value.taskId===input.taskId&&value.deliveryId===input.deliveryId
      &&value.objectId===request.objectId&&value.expectedHead===request.expectedHead&&value.expectedRevision===request.expectedRevision
      &&value.revision===request.expectedRevision+1&&value.baselineCommit===request.baselineCommit&&value.deliveryCommit===request.deliveryCommit
      &&value.tree===request.tree&&same(value.git,request.git)&&same(value.validation,request.validation);
  }
  async function confirm(attempt){
    const result=await client.getIntegrationPublication({deviceId,workspaceId:input.workspaceId,publicationId:attempt.request.publicationId});active();
    if(!matches(result?.publication,attempt.request))throw fail('RECEIPT_INVALID');
    const confirmed=receipt(result.publication);
    save(attempt.id,{state:'confirmed',receipt:confirmed});return confirmed;
  }
  async function restoreBaseline(target){
    const id=`remote-baseline:${hash(intentId)}`,prior=records.get(id);
    if(prior&&(prior.kind!=='remote-baseline-resolution'||prior.intentId!==intentId))throw fail('JOURNAL_INVALID');
    const matching=prior?.headCommit===target.headCommit;
    if(matching&&prior.state==='unavailable')throw fail('BASELINE_UNAVAILABLE');
    const request=matching&&prior.request||{...scope,expectedHead:target.headCommit,expectedRevision:0,clientCommandId:randomUUID(),
      ...(matching&&prior.nextCursor?{afterTaskId:prior.nextCursor}:{})};
    if(Object.entries(scope).some(([key,value])=>request[key]!==value)||request.expectedHead!==target.headCommit||request.expectedRevision!==0)throw fail('JOURNAL_INVALID');
    save(id,{kind:'remote-baseline-resolution',headCommit:target.headCommit,request,state:'resolving'});
    const result=await client.resolveIntegrationBaseline(request);active();
    if(!result||result.workspaceId!==input.workspaceId||result.headCommit!==target.headCommit||typeof result.ready!=='boolean'
      ||result.nextCursor!==null&&(typeof result.nextCursor!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(result.nextCursor))
      ||result.ready&&result.nextCursor!==null||result.nextCursor&&result.nextCursor===request.afterTaskId)throw fail('BASELINE_INVALID');
    save(id,{request:null,nextCursor:result.nextCursor,state:result.ready?'ready':result.nextCursor?'pending':'unavailable'});
    if(!result.ready)throw fail(result.nextCursor?'BASELINE_PENDING':'BASELINE_UNAVAILABLE');
  }
  return Object.freeze({assertCurrent,
    async recover(journal){
      await authorized();if(!journal?.candidate||!journal.validation)return null;
      const attempt=records.get(attemptId(journal.candidate,journal.validation));
      if(attempt&&(attempt.kind!=='remote-publication'||attempt.intentId!==intentId||attempt.candidateCommit!==journal.candidate.commit))throw fail('JOURNAL_INVALID');
      if(!attempt?.request)return null;
      if(attempt.request.git?.commit!==journal.candidate.commit||attempt.request.validation?.policyId!==journal.validation.policyId
        ||attempt.request.validation?.evidenceHash!==journal.validation.evidenceHash)throw fail('JOURNAL_INVALID');
      try{return await confirm(attempt);}catch(error){if(error.code==='COLLAB_INTEGRATION_PUBLICATION_UNAVAILABLE')return null;throw error;}
    },
    async acquire(baseline){
      await authorized();const id=`remote-lease:${hash(intentId)}`;
      for(let tries=0;tries<2;tries++){
        let target=await client.getIntegrationTarget(scope);active();
        if(!target||target.workspaceId!==input.workspaceId||!Number.isSafeInteger(target.revision)||target.revision<0||!/^[a-f0-9]{40}$/.test(target.headCommit||''))throw fail('TARGET_INVALID');
        if(target.initialized===true&&target.revision===0&&target.baselineReady===false){
          await restoreBaseline(target);
          const fresh=await client.getIntegrationTarget(scope);active();
          if(fresh?.workspaceId!==target.workspaceId||fresh.headCommit!==target.headCommit||fresh.revision!==0||fresh.baselineReady!==true)throw fail('HEAD_CHANGED');
          target=fresh;
        }
        const prior=records.get(id),expected={expectedHead:target.headCommit,expectedRevision:target.revision};
        const request=prior?.request&&prior.request.deviceId===deviceId&&prior.request.expectedHead===expected.expectedHead&&prior.request.expectedRevision===expected.expectedRevision
          ?prior.request:{...scope,...expected,clientCommandId:randomUUID()};
        save(id,{kind:'remote-integration-lease',request});
        const claimed=await client.claimIntegration(request);active();
        const start=clock(),fresh=await client.getIntegrationTarget(scope);active();
        try{acceptLease(fresh,{...scope,...expected,leaseId:claimed?.lease?.id,generation:claimed?.generation},start);}
        catch(error){save(id,{request:null});if(tries===1)throw error;continue;}
        startTimer();
        const head=await sync.acquire({input,baseline});active();
        if(head.commit!==held.expectedHead||head.remoteRevision!==held.expectedRevision)throw fail('HEAD_CHANGED');
        publicationDepth=head.publicationDepth;
        return head;
      }
      throw fail('FENCED');
    },
    canonical:baseline=>sync.acquire({input,baseline}),
    async publish(candidate,validation){
      await authorized();if(!held||candidate.head!==held.expectedHead||candidate.baseline!==input.baselineCommit||candidate.delivery!==input.deliveryCommit
        ||validation?.ok!==true||validation.commit!==candidate.commit)throw fail('CANDIDATE_INVALID');
      const id=attemptId(candidate,validation);let attempt=records.get(id);
      if(!attempt){
        await taskGit.ensure();active();
        const directory=fs.mkdtempSync(path.join(taskGit.rootPath,'remote-publication-'));
        attempt=save(id,{kind:'remote-publication',state:'preparing',candidateCommit:candidate.commit,directory});
      }
      if(attempt.kind!=='remote-publication'||attempt.candidateCommit!==candidate.commit||typeof attempt.directory!=='string'||path.dirname(attempt.directory)!==taskGit.rootPath)throw fail('JOURNAL_INVALID');
      async function preparePackage(){
        active();if(attempt.transferId||attempt.objectId||attempt.request)throw fail('JOURNAL_INVALID');
        const stat=file=>{try{return fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
        let directory=attempt.directory,packagePath=path.join(directory,'candidate.bundle');
        const folder=stat(directory);
        if(folder&&(!folder.isDirectory()||folder.isSymbolicLink()||fs.realpathSync(directory)!==directory))throw fail('JOURNAL_INVALID');
        const file=folder&&stat(packagePath);
        if(file&&(!file.isFile()||file.isSymbolicLink()||file.nlink!==1))throw fail('JOURNAL_INVALID');
        const previous=attempt.descriptor&&parseSharedGitDescriptor(attempt.descriptor);
        if(previous&&(previous.commit!==candidate.commit||previous.ref!==candidate.ref))throw fail('JOURNAL_INVALID');
        if(previous&&file&&attempt.state!=='preparing')return packagePath;
        // Only an upload-free attempt may change its pack representation. Git
        // can repack the same commit into different bytes after maintenance.
        await taskGit.ensure();active();
        if(!folder||file){directory=fs.mkdtempSync(path.join(taskGit.rootPath,'remote-publication-'));packagePath=path.join(directory,'candidate.bundle');}
        attempt=save(id,{directory,state:'preparing'});
        const prerequisites=previous?previous.prerequisites:held.expectedRevision>0&&publicationDepth<64?[held.expectedHead]:[];
        const exported=await createSharedGitTransport(taskGit).exportBundle({revision:candidate,prerequisites,destination:packagePath});active();
        attempt=save(id,{descriptor:exported.descriptor,state:'prepared'});return packagePath;
      }
      for(let replacement=0;replacement<2;replacement++){
        if(!attempt.transferId){
          const packagePath=await preparePackage();active();
          const transfer=await transfers.taskFiles.prepareUpload({conversationId:input.conversationId,inputPath:packagePath,originalName:'shared.bundle',expectedPlaintextSha256:attempt.descriptor.sha256});active();
          if(transfer?.ok!==true)throw fail('UPLOAD_UNAVAILABLE');attempt=save(id,{transferId:transfer.id,state:'uploading'});
        }
        // Re-probe even a previously verified upload after a long offline gap.
        // Generic unavailable/denied responses never authorize replacement.
        const uploaded=await transfers.taskFiles.upload(attempt.transferId);active();
        if(['COLLAB_TRANSFER_ORPHAN_EXPIRED','COLLAB_TRANSFER_STAGING_MISSING'].includes(uploaded?.code)){
          if(replacement===1)throw fail('UPLOAD_UNAVAILABLE');
          if(typeof uploaded.objectId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(uploaded.objectId)||attempt.objectId&&attempt.objectId!==uploaded.objectId)throw fail('JOURNAL_INVALID');
          // An older publication request cannot commit after this newer grant.
          // Same-grant uncertainty must wait for a fresh server qualification.
          if(attempt.request&&(!Number.isSafeInteger(attempt.request.generation)||attempt.request.generation>=held.generation||attempt.request.leaseId===held.leaseId))throw fail('FENCED');
          await authorized();
          attempt=store.db.transaction(()=>{
            active();const retiredId=`retired-upload:${hash([id,attempt.transferId])}`;
            records.put(retiredId,{kind:'retired-publication-upload',conversationId:input.conversationId,intentId,attemptId:id,transferId:attempt.transferId,
              objectId:uploaded.objectId,descriptor:attempt.descriptor,request:attempt.request||null,reason:uploaded.code==='COLLAB_TRANSFER_ORPHAN_EXPIRED'?'orphan-expired':'staging-missing',replacementGeneration:held.generation,createdAt:store.now()});
            return save(id,{transferId:null,objectId:null,request:null,state:'prepared'});
          })();
          continue;
        }
        if(uploaded?.ok!==true||typeof uploaded.objectId!=='string')throw fail('UPLOAD_UNAVAILABLE');
        if(!/^[A-Za-z0-9_-]{1,200}$/.test(uploaded.objectId)||attempt.objectId&&attempt.objectId!==uploaded.objectId)throw fail('JOURNAL_INVALID');
        attempt=save(id,{objectId:uploaded.objectId,state:'uploaded'});
        break;
      }
      await authorized();
      const request={...held,clientCommandId:attempt.request?.leaseId===held.leaseId&&attempt.request?.generation===held.generation?attempt.request.clientCommandId:randomUUID(),
        publicationId:`pub_${hash([intentId,candidate.commit,validation.evidenceHash])}`,objectId:attempt.objectId,
        baselineCommit:candidate.baseline,deliveryCommit:candidate.delivery,tree:candidate.tree,git:attempt.descriptor,
        validation:{commit:validation.commit,policyId:validation.policyId,evidenceHash:validation.evidenceHash}};
      attempt=save(id,{request,state:'publishing'});
      // Do not overlap a lease renewal and its successful publication/release.
      stopTimer();if(renewing)await renewing;active();
      try{await client.publishIntegration(request);}catch(error){if(error.code==='COLLAB_INTEGRATION_FENCED')throw fail('FENCED');throw error;}
      // The server has released the lease. A fresh immutable publication read
      // is authority for local reflection; lease guards no longer apply.
      held=null;active();return confirm(attempt);
    },
    close(){
      if(closing)return closing;stopTimer();closed=true;
      const request=held;held=null;
      closing=(async()=>{if(!request)return;try{assertAccountActive();await client.releaseIntegration({...request,clientCommandId:randomUUID()});}catch{/* Expiry/revocation or a successor owns recovery. */}})();
      return closing;
    },
  });
}
module.exports={createRemotePublication};
