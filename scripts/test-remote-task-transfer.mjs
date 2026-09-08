import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {CollaborationStore}=require('../src/main/collaboration/collaboration-store');
const {LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring');
const {createTransferRuntime}=require('../src/main/collaboration/transfer-runtime');
const {decryptFile}=require('../src/main/collaboration/encrypted-container');
const {freezeTaskBundle,unpackTaskBundle}=require('../src/main/collaboration/task-bundle');
const {transferResult}=require('../src/main/collaboration/transfer-ipc');
const {createTransferManifestStore}=require('../src/main/collaboration/transfer-manifest');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'lily-task-transfer-')));
  const keyring=new LocalCollaborationKeyring({filePath:path.join(dir,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()}});
  const store=new CollaborationStore({dbPath:path.join(dir,'store.db'),accountId:'alice',keyring});
  store.replaceProjectionFromBootstrap({conversations:[{id:'conversation',kind:'direct'}]});
  const source=path.join(dir,'source'); fs.mkdirSync(source); fs.writeFileSync(path.join(source,'report.txt'),'original shared evidence');
  const bundle=await freezeTaskBundle({sourceRoot:source,destinationRoot:path.join(dir,'frozen')});
  const remote={parts:new Map(),state:'uploading',metadata:null,ciphertext:null,tickets:0,taskReads:0,authorized:true,
    task:{id:'task',conversationId:'conversation',requesterUserId:'alice',assigneeUserId:'bob',state:'active',inputSnapshotId:'object',deliveries:[]}};
  const ticket={bucket:'test',objectKey:`collaboration/${'a'.repeat(64)}`,token:'PRIVATE_UPLOAD_TOKEN',uploadUrl:'https://upload.invalid'};
  const client={async getTask(){remote.taskReads++;return structuredClone(remote.task);},objects:{
    async init(input){remote.metadata=input; assert.equal(input.purpose,'workspace');assert.equal(input.conversationId,'conversation');return {objectId:'object',state:'uploading',upload:ticket};},
    async status(){return {objectId:'object',state:remote.state,ciphertextSize:remote.metadata.ciphertextSize,ciphertextSha256:remote.metadata.ciphertextSha256,upload:ticket,provider:remote.ciphertext?{state:'present',etag:'object-etag'}:{state:'missing'}};},
    async complete(input){assert.equal(digest(remote.ciphertext),input.ciphertextSha256);assert.equal(remote.ciphertext.length,input.ciphertextSize);remote.state='verified';return {objectId:'object',state:'verified'};},
    async downloadTicket(){remote.tickets++;if(!remote.authorized)throw Object.assign(new Error('revoked'),{code:'COLLAB_OBJECT_UNAVAILABLE'});return {objectId:'object',url:'https://download.invalid/object',dek:remote.metadata.dek,ciphertextSize:remote.ciphertext.length,ciphertextSha256:digest(remote.ciphertext),expiresAt:new Date(Date.now()+300000).toISOString()};},
  }};
  const fetchImpl=async(url,options)=>{
    const parsed=new URL(url);
    if(parsed.hostname==='download.invalid')return new Response(remote.ciphertext,{status:206,headers:{'content-range':`bytes 0-${remote.ciphertext.length-1}/${remote.ciphertext.length}`}});
    assert.equal(options.headers.authorization,'UpToken PRIVATE_UPLOAD_TOKEN');
    let result;
    if(options.method==='POST' && parsed.pathname.endsWith('/uploads'))result={uploadId:'upload',expireAt:2_000_000_000};
    else if(options.method==='PUT'){
      const number=Number(parsed.pathname.split('/').at(-1));const bytes=Buffer.from(options.body);remote.parts.set(number,bytes);
      result={etag:`part-${number}`,md5:crypto.createHash('md5').update(bytes).digest('hex')};
    }else if(options.method==='GET')result={uploadId:'upload',expireAt:2_000_000_000,partNumberMarker:0,parts:[...remote.parts].map(([partNumber,bytes])=>({partNumber,size:bytes.length,etag:`part-${partNumber}`}))};
    else {const {parts}=JSON.parse(options.body);remote.ciphertext=Buffer.concat(parts.map(p=>remote.parts.get(p.partNumber)));result={key:ticket.objectKey,hash:'object-etag'};}
    return Response.json(result);
  };
  const options={store,client,deviceId:'device',rootPath:path.join(dir,'collaboration-transfer'),policy:{enabled:true,attachments:false,workspaceShares:true,tasks:true},assertActive:()=>{},fetchImpl};
  let runtime=createTransferRuntime(options);
  t.after(()=>{runtime.stop();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,store,bundle,remote,manifests:()=>createTransferManifestStore({rootPath:options.rootPath,accountId:store.accountId,keyring}),get runtime(){return runtime;},restart(){runtime.stop();runtime=createTransferRuntime(options);}};
}

test('taskFiles uploads a real encrypted workspace and downloads the exact authenticated package',async t=>{
  const f=await fixture(t);
  const prepared=await f.runtime.taskFiles.prepareUpload({conversationId:'conversation',inputPath:f.bundle.packagePath,originalName:'materials.lilyspace.zip'});
  assert.equal(prepared.ok,true);assert.equal(prepared.state,'prepared');assert.equal(f.remote.metadata,null,'preview must not upload');
  assert.equal(prepared.taskOwned,true,'task upload is explicitly marked as task-owned before ordinary transfer list reads');
  const uploaded=await f.runtime.taskFiles.upload(prepared.id);
  assert.equal(uploaded.ok,true);assert.equal(uploaded.state,'verified');assert.equal(uploaded.objectId,'object');
  assert.notDeepEqual(f.remote.ciphertext,fs.readFileSync(f.bundle.packagePath));
  const cipherFile=path.join(f.dir,'cipher'),plainFile=path.join(f.dir,'plain');fs.writeFileSync(cipherFile,f.remote.ciphertext);
  await decryptFile({inputPath:cipherFile,outputPath:plainFile,key:Buffer.from(f.remote.metadata.dek,'base64')});
  assert.deepEqual(fs.readFileSync(plainFile),fs.readFileSync(f.bundle.packagePath));
  const downloaded=await f.runtime.taskFiles.download({conversationId:'conversation',taskId:'task',objectId:'object'});
  assert.equal(downloaded.ok,true);
  f.restart();
  const taskTransfers=transferResult('getTransfers',f.runtime.list()).transfers;
  assert.ok(taskTransfers.length>=2&&taskTransfers.every(item=>item.taskOwned===true),'task ownership survives encrypted manifest reopen and safe IPC projection');
  const legacyDownload=taskTransfers.find(item=>item.direction==='download');
  const manifests=f.manifests(),stored=manifests.read(legacyDownload.id),{taskOwned,...legacyCheckpoint}=stored.checkpoint;
  manifests.update({id:stored.id,expectedRevision:stored.revision,checkpoint:legacyCheckpoint});
  f.restart();assert.equal(f.runtime.list().transfers.find(item=>item.id===stored.id).taskOwned,undefined,'legacy unmarked records remain readable');
  assert.equal((await f.runtime.taskFiles.download({conversationId:'conversation',taskId:'task',objectId:'object'})).ok,true);
  assert.equal(f.runtime.list().transfers.find(item=>item.id===stored.id).taskOwned,true,'explicit authorized task reopen marks an old cached task transfer');
  f.store.hydrateAuthorizedHistory({conversationId:'conversation',messages:[{id:'share',createSeq:1,kind:'workspace_share',attachmentIds:['ordinary_object'],revision:1}]});
  const ordinary=await f.runtime.prepareDownload({conversationId:'conversation',messageId:'share',objectId:'ordinary_object'});
  assert.equal(ordinary.ok,true);assert.equal(ordinary.purpose,'workspace');assert.equal(ordinary.taskOwned,undefined,'ordinary workspace shares remain outside task ownership');
  const unpacked=await unpackTaskBundle({packagePath:downloaded.packagePath,destinationRoot:path.join(f.dir,'unpacked')});
  assert.deepEqual(unpacked.manifest,f.bundle.manifest);
  assert(f.remote.taskReads>=1);assert(f.remote.tickets>=2,'publishing a cached file reacquires object authorization');
  for(const view of [prepared,uploaded,...f.runtime.list().transfers]) assert.doesNotMatch(JSON.stringify(view),/PRIVATE_UPLOAD_TOKEN|dek|inputPath|ciphertextSha256/);
});

test('taskFiles refuses nonparticipant, wrong binding and fresh ACL denial even after a cached download',async t=>{
  const f=await fixture(t);
  const prepared=await f.runtime.taskFiles.prepareUpload({conversationId:'conversation',inputPath:f.bundle.packagePath,originalName:'materials.lilyspace.zip'});
  await f.runtime.taskFiles.upload(prepared.id);
  const command={conversationId:'conversation',taskId:'task',objectId:'object'};
  assert.equal((await f.runtime.taskFiles.download({...command,objectId:'other'})).code,'COLLAB_TASK_ACCESS_DENIED');
  assert.equal(f.remote.tickets,0);
  f.remote.task.requesterUserId='eve';
  assert.equal((await f.runtime.taskFiles.download(command)).code,'COLLAB_TASK_ACCESS_DENIED');
  f.remote.task.requesterUserId='alice';
  const cached=await f.runtime.taskFiles.download(command);assert.equal(cached.ok,true);
  f.remote.authorized=false;
  assert.equal((await f.runtime.taskFiles.download(command)).code,'COLLAB_OBJECT_UNAVAILABLE');
  f.remote.authorized=true;
  fs.chmodSync(cached.packagePath,0o600);fs.writeFileSync(cached.packagePath,'tampered');
  const tampered=await f.runtime.taskFiles.download(command);
  assert.equal(tampered.ok,false,'cached plaintext integrity cannot rely on its historical ready state');
  f.remote.task.state='cancelled';
  assert.equal((await f.runtime.taskFiles.download(command)).code,'COLLAB_TASK_ACCESS_DENIED');
});

test('taskFiles binds encryption output to the reviewed plaintext hash before preparing any upload',async t=>{
  const f=await fixture(t);
  const rejected=await f.runtime.taskFiles.prepareUpload({conversationId:'conversation',inputPath:f.bundle.packagePath,originalName:'materials.lilyspace.zip',expectedPlaintextSha256:'0'.repeat(64)});
  assert.equal(rejected.ok,false,'wrong expected hash must not become an uploadable prepared transfer');
  assert.equal(f.remote.metadata,null,'mismatched plaintext never reaches object init');
  const accepted=await f.runtime.taskFiles.prepareUpload({conversationId:'conversation',inputPath:f.bundle.packagePath,originalName:'materials.lilyspace.zip',expectedPlaintextSha256:digest(fs.readFileSync(f.bundle.packagePath))});
  assert.equal(accepted.ok,true);
  assert.equal((await f.runtime.taskFiles.upload(accepted.id)).state,'verified');
});
