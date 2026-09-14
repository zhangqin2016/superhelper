import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{TaskGit}=require('../src/main/collaboration/task-git'),{createSharedGit}=require('../src/main/collaboration/shared-git');
const {createSharedGitTransport}=require('../src/main/collaboration/task-git-transport');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'shared-head-sync-'));
const snapshot=(name,files)=>{const snapshotRoot=path.join(root,name);fs.mkdirSync(snapshotRoot);return {snapshotRoot,manifest:Object.entries(files).map(([name,text])=>{fs.writeFileSync(path.join(snapshotRoot,name),text);return {path:name,sizeBytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')};})};};
try{
 const source=new TaskGit({rootPath:path.join(root,'source'),gitOptions:{autoInstall:false}}),target=new TaskGit({rootPath:path.join(root,'target'),gitOptions:{autoInstall:false}});
 const shared=createSharedGit(source),send=createSharedGitTransport(source),base=snapshot('base',{'a.txt':'a','b.txt':'b'});
 const baseline=await source.captureBaseline({taskId:'task',...base});let head=await shared.initialize({workspaceId:'workspace',baseline});
 const publications=new Map(),packs=new Map();let latest,downloads=0,denied=false,mutateDownload=null,afterRead=null;
 for(let i=1;i<=2;i++){
  const changed=snapshot('changed'+i,i===1?{'a.txt':'changed','b.txt':'b'}:{'a.txt':'a','b.txt':'changed'});
  const delivery=await source.captureContribution({baseline,baseManifest:base.manifest,materializedPaths:['a.txt','b.txt'],deliveryId:'delivery'+i,...changed});
  const candidate=await shared.prepare({workspaceId:'workspace',baseline,delivery,expectedHead:head.commit});
  const pack=await send.exportBundle({revision:candidate,prerequisites:i===1?[]:[head.commit],destination:path.join(root,'pack'+i)});
  const publication={id:'pub'+i,publicationId:'pub'+i,workspaceId:'workspace',conversationId:'chat',ownerUserId:'owner',taskId:'task',deliveryId:'delivery'+i,objectId:'object'+i,
   expectedHead:head.commit,expectedRevision:i-1,revision:i,baselineCommit:baseline.commit,deliveryCommit:delivery.commit,tree:candidate.tree,git:pack.descriptor,
   validation:{commit:candidate.commit,policyId:'fixture',evidenceHash:'a'.repeat(64)},parentPublicationId:i===1?null:'pub1'};
  publications.set(publication.id,publication);packs.set(publication.id,pack);latest=publication;
  head=await shared.publish({candidate,validate:async c=>({ok:true,commit:c.commit})});
 }
 const {createSharedHeadSync}=require('../src/main/collaboration/shared-head-sync');
 const input={workspaceId:'workspace',conversationId:'chat',taskId:'task',deliveryId:'delivery2'};
 const client={getIntegrationTarget:async()=>({workspaceId:'workspace',headCommit:latest.git.commit,revision:latest.revision}),
  getIntegrationPublication:async({publicationId})=>{const result=structuredClone(publications.get(publicationId||latest.id));afterRead?.();return {workspaceId:'workspace',publication:result};}};
 const sharedFiles={download:async({publicationId})=>{downloads++;const publication=structuredClone(publications.get(publicationId));mutateDownload?.(publication);return {ok:true,packagePath:packs.get(publicationId).packagePath,publication};}};
 const sync=createSharedHeadSync({taskGit:target,client,sharedFiles,accountId:'owner',deviceId:'device',assertActive(){},authorize:async()=>!denied});
 const first=await sync.acquire({input,baseline});
 assert.equal(first.commit,latest.git.commit);assert.equal(first.remoteRevision,2);assert.equal(downloads,2,'an empty device fetches the complete root then the dependent delta');
 const targetShared=createSharedGit(target),state=await targetShared.remoteState('workspace');
 assert.equal(state.revision,2);assert.equal(state.commit,latest.git.commit);assert.equal(state.publicationId,'pub2');
 assert.deepEqual(await createSharedGit(new TaskGit({rootPath:target.rootPath,gitOptions:{autoInstall:false}})).remoteState('workspace'),state,'remote monotonicity checkpoint survives a new runtime');
 const {git}=await target.ensure();assert.equal(await git(['show',`${first.commit}:a.txt`]),'changed');assert.equal(await git(['show',`${first.commit}:b.txt`]),'changed');
 const again=await sync.acquire({input,baseline});assert.equal(again.commit,first.commit);
 const localBaseline=await target.captureBaseline({taskId:'task',...base});
 const pending=snapshot('pending',{'a.txt':'a','b.txt':'b','pending.txt':'unsent'});
 const localDelivery=await target.captureContribution({baseline:localBaseline,baseManifest:base.manifest,materializedPaths:['a.txt','b.txt'],deliveryId:'pending',...pending});
 const localCandidate=await targetShared.prepare({workspaceId:'workspace',baseline:localBaseline,delivery:localDelivery,expectedHead:first.commit});
 await targetShared.publish({candidate:localCandidate,validate:async c=>({ok:true,commit:c.commit})});
 assert.equal((await sync.acquire({input,baseline})).commit,first.commit);
 assert.equal((await targetShared.publication(localCandidate)).commit,localCandidate.commit,'reconciling canonical H retains an unsent local publication receipt');
 assert.equal(await target.hasRevision(localCandidate),true,'unpublished candidate bytes remain recoverable for rebasing');
 denied=true;await assert.rejects(sync.acquire({input,baseline}),{code:'COLLAB_SHARED_SYNC_ACCESS_DENIED'});denied=false;
 mutateDownload=()=>{denied=true;};
 await assert.rejects(sync.acquire({input,baseline}),{code:'COLLAB_SHARED_SYNC_ACCESS_DENIED'});mutateDownload=null;denied=false;
 assert.deepEqual(await targetShared.remoteState('workspace'),state,'late scope loss cannot advance the shared checkpoint');
 const current=latest;latest=publications.get('pub1');
 await assert.rejects(sync.acquire({input,baseline}),{code:'COLLAB_SHARED_GIT_REMOTE_REGRESSED'});latest=current;
 assert.deepEqual(await targetShared.remoteState('workspace'),state,'a stale server response cannot rewind a recorded remote revision');
 mutateDownload=publication=>{publication.tree='0'.repeat(40);};
 await assert.rejects(sync.acquire({input,baseline}),{code:'COLLAB_SHARED_SYNC_METADATA_CHANGED'});mutateDownload=null;
 const oldTree=latest.tree;latest.tree='0'.repeat(40);
 await assert.rejects(sync.acquire({input,baseline}),{code:'COLLAB_SHARED_SYNC_ANCESTRY_INVALID'});latest.tree=oldTree;
 const oldParent=latest.parentPublicationId;latest.parentPublicationId=latest.id;
 await assert.rejects(sync.acquire({input,baseline}),{code:'COLLAB_SHARED_SYNC_CHAIN_INVALID'});latest.parentPublicationId=oldParent;
 afterRead=()=>{latest=publications.get('pub1');};
 await assert.rejects(sync.acquire({input,baseline}),{code:'COLLAB_SHARED_SYNC_HEAD_CHANGED'});afterRead=null;latest=current;
 // Hostile/unsupported metadata cannot induce unbounded dependency reads.
 for(let i=1;i<=65;i++){
  const commit=i.toString(16).padStart(40,'0'),expectedHead=(i-1).toString(16).padStart(40,'0');
  publications.set('bounded'+i,{...current,id:'bounded'+i,publicationId:'bounded'+i,revision:i,expectedRevision:i-1,expectedHead,parentPublicationId:i===1?null:'bounded'+(i-1),
   git:{...current.git,commit,prerequisites:i===1?[]:[expectedHead]},validation:{...current.validation,commit}});
 }
 latest=publications.get('bounded65');const beforeBounded=downloads;
 await assert.rejects(sync.acquire({input,baseline}),{code:'COLLAB_SHARED_SYNC_CHAIN_INVALID'});latest=current;
 assert.equal(downloads,beforeBounded,'overlong metadata chains are rejected before any file transfer');
 // Capture the local CAS before I/O; another local writer wins during download.
 const originalDownload=sharedFiles.download;let raced=false;
 sharedFiles.download=async args=>{const result=await originalDownload(args);if(!raced){raced=true;await git(['update-ref',first.ref,baseline.commit,first.commit]);}return result;};
 await assert.rejects(sync.acquire({input,baseline}),{code:'COLLAB_SHARED_GIT_HEAD_CHANGED'});
 assert.equal(await git(['rev-parse',first.ref]),baseline.commit,'failed mirror CAS preserves the concurrent local writer');
 sharedFiles.download=originalDownload;
 const repaired=await sync.acquire({input,baseline});assert.equal(repaired.commit,first.commit);
 const initialGit=new TaskGit({rootPath:path.join(root,'initial'),gitOptions:{autoInstall:false}}),initialBaseline=await initialGit.captureBaseline({taskId:'task',...base});
 const initialSync=createSharedHeadSync({taskGit:initialGit,accountId:'owner',deviceId:'device',assertActive(){},authorize:async()=>true,
  client:{getIntegrationTarget:async()=>({workspaceId:'workspace',headCommit:baseline.commit,revision:0})},sharedFiles:{download:()=>{throw Error('No publication exists yet');}}});
 const initialized=await initialSync.acquire({input,baseline:initialBaseline});assert.equal(initialized.remoteRevision,0);assert.equal(initialized.publicationId,null);
 await assert.rejects(initialSync.acquire({input,baseline}),{code:'COLLAB_SHARED_SYNC_BASELINE_UNAVAILABLE'},'another repository or unknown initial anchor cannot be guessed from the current task');
 const initialShared=createSharedGit(initialGit),initialState=await initialShared.remoteState('workspace');
 const importedFirst=await createSharedGitTransport(initialGit).importBundle({packagePath:packs.get('pub1').packagePath,descriptor:publications.get('pub1').git});
 const adoption={workspaceId:'workspace',revision:importedFirst,remoteRevision:1,publicationId:'pub1',expectedHead:initialized.commit,expectedRemoteState:initialState.object,assertCurrent(){}};
 await assert.rejects(initialShared.reconcileRemote({...adoption,expectedHead:first.commit}),{code:'COLLAB_SHARED_GIT_HEAD_CHANGED'});
 assert.deepEqual(await initialShared.remoteState('workspace'),initialState,'failed H CAS cannot persist the newer remote revision');
 let guardCalls=0;
 await assert.rejects(initialShared.reconcileRemote({...adoption,assertCurrent(){if(++guardCalls===2)throw Object.assign(Error('stopped after Git commit'),{code:'COLLAB_INTEGRATION_STOPPED'});}}),{code:'COLLAB_INTEGRATION_STOPPED'});
 const reopenedShared=createSharedGit(new TaskGit({rootPath:initialGit.rootPath,gitOptions:{autoInstall:false}}));
 const committed=await reopenedShared.remoteState('workspace');assert.equal(committed.revision,1);assert.equal(committed.commit,importedFirst.commit);
 assert.equal((await initialGit.ensure()).repository,importedFirst.repository);
 assert.equal(await (await initialGit.ensure()).git(['rev-parse',initialized.ref]),committed.commit,'interruption after the Git transaction leaves H and its remote checkpoint together');
 assert.equal(fs.readFileSync(path.join(base.snapshotRoot,'a.txt'),'utf8'),'a');
 console.log('shared head sync: independent incremental reconstruction, fresh authorization, metadata/ancestry rejection, monotonic remote receipt and local CAS race passed (API/file transport fixtures).');
}finally{fs.rmSync(root,{recursive:true,force:true});}
