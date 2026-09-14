import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash,randomBytes} from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{TaskGit}=require('../src/main/collaboration/task-git'),{createSharedGit}=require('../src/main/collaboration/shared-git');
const {createSharedPublication}=require('../src/main/collaboration/shared-publication'),{createRemotePublication}=require('../src/main/collaboration/remote-publication');
const {CollaborationStore}=require('../src/main/collaboration/collaboration-store'),{LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring');
const {createIntegrationIntents}=require('../src/main/collaboration/integration-intents'),{createTaskRecords}=require('../src/main/collaboration/task-records');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'remote-publication-'));
const keyring=new LocalCollaborationKeyring({filePath:path.join(root,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
const taskGit=new TaskGit({rootPath:path.join(root,'git'),gitOptions:{autoInstall:false}}),shared=createSharedGit(taskGit);
let store,intents,remote,localLease,time=1000,validations=0,publishCalls=0,claimLost=true,publishLost=true,renewFailure=false;
const open=()=>{store=new CollaborationStore({dbPath:path.join(root,'db'),accountId:'owner',keyring,now:()=>time});intents=createIntegrationIntents({store,assertActive(){},now:()=>time});};
const snapshot=(name,files)=>{const snapshotRoot=path.join(root,name);fs.mkdirSync(snapshotRoot);return {snapshotRoot,manifest:Object.entries(files).map(([name,bytes])=>{fs.writeFileSync(path.join(snapshotRoot,name),bytes);return {path:name,sizeBytes:Buffer.byteLength(bytes),sha256:createHash('sha256').update(bytes).digest('hex')};})};};
const publications=new Map(),transfersById=new Map(),claims=new Map();let server;
const view=()=>({...server,serverTime:Date.now(),lease:server.lease?{...server.lease,active:server.lease.expiresAt>Date.now()}:null});
const unavailable=code=>Object.assign(Error(code),{code});
const client={
 getIntegrationTarget:async()=>view(),
 claimIntegration:async request=>{
  if(claims.has(request.clientCommandId))return structuredClone(claims.get(request.clientCommandId));
  if(server.lease&&server.lease.expiresAt>Date.now())throw unavailable('COLLAB_INTEGRATION_BUSY');
  server.generation++;server.lease={id:'lease'+server.generation,deviceId:'device',taskId:request.taskId,deliveryId:request.deliveryId,expiresAt:Date.now()+30000};
  const result=view();claims.set(request.clientCommandId,result);
  if(claimLost){claimLost=false;throw unavailable('COLLAB_NETWORK_UNAVAILABLE');}return result;
 },
 renewIntegration:async()=>{if(renewFailure)throw unavailable('COLLAB_NETWORK_UNAVAILABLE');server.lease.expiresAt=Date.now()+30000;return view();},
 releaseIntegration:async()=>{server.lease=null;return view();},
 getIntegrationPublication:async({publicationId})=>{const publication=publications.get(publicationId||server.publicationId);if(!publication)throw unavailable('COLLAB_INTEGRATION_PUBLICATION_UNAVAILABLE');return {workspaceId:'workspace',publication:structuredClone(publication)};},
 publishIntegration:async request=>{
  publishCalls++;
  assert.equal(request.leaseId,server.lease.id);assert.equal(request.generation,server.generation);assert.equal(request.expectedHead,server.headCommit);
  const {deviceId,clientCommandId,leaseId,generation,...body}=request;
  const publication={...body,id:request.publicationId,ownerUserId:'owner',conversationId:'chat',revision:request.expectedRevision+1,parentPublicationId:request.git.prerequisites.length?server.publicationId:null};
  publications.set(publication.id,publication);server={...server,headCommit:request.git.commit,revision:publication.revision,publicationId:publication.id,lease:null};
  if(publishLost){publishLost=false;throw unavailable('COLLAB_NETWORK_UNAVAILABLE');}return {workspaceId:'workspace',publicationId:publication.id,headCommit:server.headCommit,revision:server.revision};
 },
};
const transfers={taskFiles:{prepareUpload:async({inputPath})=>{const id='transfer'+transfersById.size;transfersById.set(id,{packagePath:inputPath,objectId:'object'+transfersById.size});return {ok:true,id};},
 upload:async id=>({ok:true,objectId:transfersById.get(id).objectId})},sharedFiles:{download:async({publicationId})=>{const publication=publications.get(publicationId),transfer=[...transfersById.values()].find(item=>item.objectId===publication.objectId);return {ok:true,packagePath:transfer.packagePath,publication:structuredClone(publication)};}}};
function session(input,intentId){
 const guard=()=>{remote?.assertCurrent();};
 remote=createRemotePublication({store,taskGit,client,transfers,deviceId:'device',input,intentId,assertActive:()=>{guard();intents.assertLease(localLease);},assertAccountActive(){},authorize:async()=>true});
 const publisher=createSharedPublication({store,taskGit,assertActive:guard,authorize:async()=>true,now:()=>time});
 return {publisher,remote};
}
const validate=async candidate=>{validations++;return {ok:true,commit:candidate.commit,policyId:'fixture',evidenceHash:createHash('sha256').update(candidate.commit).digest('hex')};};
try{
 open();store.replaceProjectionFromBootstrap({conversations:[{id:'chat',kind:'direct'}]});
 const base=snapshot('base',{'a.txt':'a','b.txt':'b','large.bin':randomBytes(1024*1024)}),baseline=await taskGit.captureBaseline({taskId:'task',...base});
 const deliveries=[];
 for(const [index,files] of [[1,{'a.txt':'changed','b.txt':'b'}],[2,{'a.txt':'a','b.txt':'changed'}],[3,{'a.txt':'a','b.txt':'b','new.txt':'third'}]]){
  deliveries.push(await taskGit.captureContribution({baseline,baseManifest:base.manifest,materializedPaths:['a.txt','b.txt'],deliveryId:'delivery'+index,...snapshot('change'+index,files)}));
 }
 server={workspaceId:'workspace',headCommit:baseline.commit,revision:0,generation:0,lease:null};
 const input={workspaceId:'workspace',conversationId:'chat',taskId:'task',deliveryId:'delivery1',targetId:'target',chain:'shared',projectId:'project',sessionId:'session',baselineCommit:baseline.commit,deliveryCommit:deliveries[0].commit};
 const intent=intents.enqueue(input),args={baseline,delivery:deliveries[0],validationPolicyId:'fixture',validate};
 const oldPublisher=createSharedPublication({store,taskGit,assertActive(){},authorize:async()=>true,now:()=>time});
 const legacy=await oldPublisher.run({...args,lease:intents.claim(intent.id,{workerId:'old-client'})});
 assert.equal(intents.get(intent.id).state,'completed');assert.equal(oldPublisher.outbox('chat')[0].state,'queued');
 await require('../src/main/collaboration/legacy-publication-migration').createLegacyPublicationMigration({store,assertActive(){},enabled:true,now:()=>time}).recover();
 validations=0;
 localLease=intents.claim(intent.id,{workerId:'one'});let context=session(input,intent.id);
 await assert.rejects(context.publisher.run({...args,lease:localLease,remote}),{code:'COLLAB_NETWORK_UNAVAILABLE'});
 assert.equal(validations,0);assert.equal(server.generation,1,'lost claim response has one server grant');await remote.close();remote=null;
 store.close();time+=31000;server.lease.expiresAt=Date.now()-1;open();localLease=intents.claim(intent.id,{workerId:'two'});context=session(input,intent.id);
 await assert.rejects(context.publisher.run({...args,lease:localLease,remote}),{code:'COLLAB_NETWORK_UNAVAILABLE'});
 assert.equal(validations,1);assert.equal(publishCalls,1);assert.equal(intents.get(intent.id).state,'running');assert.equal(context.publisher.outbox('chat').filter(row=>row.state==='sent').length,0,'uncertain remote commit cannot complete local work');
 assert.equal(createTaskRecords({store,assertActive(){}}).get(legacy.outboxId).state,'queued');
 const before=context.publisher.get(intent.id);assert.equal((await shared.initialize({workspaceId:'workspace',baseline})).commit,baseline.commit,'a lost remote ACK does not optimistically advance local H');
 await remote.close();remote=null;store.close();time+=31000;open();localLease=intents.claim(intent.id,{workerId:'three'});context=session(input,intent.id);
 const recovered=await context.publisher.run({...args,lease:localLease,remote});assert.equal(recovered.state,'published');
 assert.equal(recovered.remoteReceipt.headCommit,before.candidate.commit);assert.equal(createTaskRecords({store,assertActive(){}}).get(recovered.outboxId).state,'sent');assert.equal(intents.get(intent.id).state,'completed');
 assert.equal(createTaskRecords({store,assertActive(){}}).get(legacy.outboxId).state,'superseded','legacy outbox retires only with the confirmed replacement');
 assert.equal(publishCalls,1);assert.equal(validations,1,'reopening confirms the committed immutable publication without repeating checks or publication');await remote.close();remote=null;
 const secondInput={...input,deliveryId:'delivery2',deliveryCommit:deliveries[1].commit},second=intents.enqueue(secondInput);localLease=intents.claim(second.id,{workerId:'four'});context=session(secondInput,second.id);
 const secondResult=await context.publisher.run({baseline,delivery:deliveries[1],validationPolicyId:'fixture',validate,lease:localLease,remote});
 const secondPublication=publications.get(secondResult.remoteReceipt.publicationId);assert.ok(secondPublication.git.prerequisites.includes(recovered.remoteReceipt.headCommit));
 assert.ok(secondPublication.git.sizeBytes<4096,'second native publication reuses the verified remote H');
 const {git}=await taskGit.ensure();assert.equal(await git(['show',`${secondResult.candidate.commit}:a.txt`]),'changed');assert.equal(await git(['show',`${secondResult.candidate.commit}:b.txt`]),'changed');
 await remote.close();remote=null;
 const thirdInput={...input,deliveryId:'delivery3',deliveryCommit:deliveries[2].commit},third=intents.enqueue(thirdInput);localLease=intents.claim(third.id,{workerId:'five'});context=session(thirdInput,third.id);
 renewFailure=true;const priorHead=server.headCommit;
 await assert.rejects(context.publisher.run({baseline,delivery:deliveries[2],validationPolicyId:'fixture',lease:localLease,remote,
  validate:async c=>{await new Promise(resolve=>setTimeout(resolve,6000));return validate(c);}}),{code:'COLLAB_REMOTE_PUBLICATION_FENCED'});
 assert.equal(server.headCommit,priorHead);assert.equal(publishCalls,2,'a failed live renewal fences validation before any publication request');
 await remote.close();remote=null;assert.equal(server.lease,null,'cleanup releases only the held scope after failed validation');
 assert.equal(intents.get(third.id).remotePublicationRequired,true,'new remote work also retains the protocol requirement');
 await assert.rejects(createSharedPublication({store,taskGit,assertActive(){},authorize:async()=>true,now:()=>time}).run({baseline,delivery:deliveries[2],validationPolicyId:'fixture',validate,lease:localLease}),{code:'COLLAB_PUBLICATION_REMOTE_REQUIRED'});
 assert.equal(fs.readFileSync(path.join(base.snapshotRoot,'a.txt'),'utf8'),'a');
 console.log('remote-first publication: durable claim/commit ACK loss across reopen, one confirmed outbox, actual incremental packs and failed-renewal publication fence passed (server/transfer fixtures).');
}finally{await remote?.close();store?.close();fs.rmSync(root,{recursive:true,force:true});}
