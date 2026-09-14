import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createHash,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {CollaborationStore}=require('../src/main/collaboration/collaboration-store');
const {LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring');
const {createTransferRuntime}=require('../src/main/collaboration/transfer-runtime');
const {TaskGit}=require('../src/main/collaboration/task-git');
const {createTaskGitTransport}=require('../src/main/collaboration/task-git-transport');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'task-git-encrypted-'));
const objects=new Map(),clients=[];
const task={id:'task',conversationId:'chat',requesterUserId:'alice',assigneeUserId:'bob',state:'active',inputSnapshotId:null,deliveries:[]};
let dropPart=true,serverError;
// Local HTTP provider emulator. Only transport is remapped; runtime encryption,
// multipart protocol, Range downloads, journals and Git plumbing are real.
// Object API/ACL below are fixtures, not production service acceptance.
const server=http.createServer(async(req,res)=>{
  try {
    const parts=req.url.split('/'),object=parts[1]==='buckets'
      ? [...objects.values()].find(item=>item.ticket.objectKey===Buffer.from(parts[4],'base64url').toString()) : objects.get(parts[1]);assert.ok(object);
    if(parts[2]==='download'){
      const match=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range);assert.ok(match);
      const start=Number(match[1]),end=Number(match[2]);object.ranges.push([start,end]);
      const bytes=Buffer.from(object.ciphertext.subarray(start,end+1));
      if(object.corrupt)bytes[0]^=1;
      res.writeHead(206,{'content-range':`bytes ${start}-${end}/${object.ciphertext.length}`,'content-length':bytes.length});res.end(bytes);return;
    }
    assert.equal(req.headers.authorization,'UpToken fixture-token');
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;assert.ok(size<=4*1024**2);chunks.push(chunk);}
    const body=Buffer.concat(chunks);let result;
    if(req.method==='PUT'){
      const number=Number(parts.at(-1));object.puts.push(number);object.parts.set(number,body);
      assert.equal(req.headers['content-md5'],createHash('md5').update(body).digest('hex'));
      if(dropPart){dropPart=false;req.socket.destroy();return;}
      result={etag:`part-${number}`,md5:createHash('md5').update(body).digest('hex')};
    }else if(req.method==='GET')result={uploadId:'upload',expireAt:2_000_000_000,partNumberMarker:0,parts:[...object.parts].map(([partNumber,bytes])=>({partNumber,size:bytes.length,etag:`part-${partNumber}`}))};
    else if(parts.at(-1)==='uploads')result={uploadId:'upload',expireAt:2_000_000_000};
    else {
      const completed=JSON.parse(body);object.ciphertext=Buffer.concat(completed.parts.map(part=>object.parts.get(part.partNumber)));
      result={key:object.ticket.objectKey,hash:'object-etag'};
    }
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  }catch(error){serverError=error;res.writeHead(500);res.end();}
});
function assemble(accountId){
  const directory=path.join(root,accountId);fs.mkdirSync(directory);
  const keyring=new LocalCollaborationKeyring({filePath:path.join(directory,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
  const store=new CollaborationStore({dbPath:path.join(directory,'store.db'),accountId,keyring});
  store.replaceProjectionFromBootstrap({conversations:[{id:'chat',kind:'direct'}]});
  const client={getTask:async()=>structuredClone(task),objects:{
    async init(input){
      const objectId=`object-${objects.size+1}`,ticket={bucket:'test',objectKey:`collaboration/${hash(objectId)}`,token:'fixture-token',uploadUrl:'https://provider.invalid'};
      objects.set(objectId,{metadata:input,ticket,state:'uploading',parts:new Map(),puts:[],ranges:[],authorized:true});return {objectId,state:'uploading',upload:ticket};
    },
    async status({objectId}){const object=objects.get(objectId);return {objectId,state:object.state,ciphertextSize:object.metadata.ciphertextSize,ciphertextSha256:object.metadata.ciphertextSha256,upload:object.ticket,provider:object.ciphertext?{state:'present',etag:'object-etag'}:{state:'missing'}};},
    async complete(input){const object=objects.get(input.objectId);assert.equal(hash(object.ciphertext),input.ciphertextSha256);assert.equal(object.ciphertext.length,input.ciphertextSize);object.state='verified';return {objectId:input.objectId,state:'verified'};},
    async downloadTicket({objectId}){const object=objects.get(objectId);if(!object.authorized)throw Object.assign(new Error('revoked'),{code:'COLLAB_OBJECT_UNAVAILABLE'});return {objectId,url:`https://provider.invalid/${objectId}/download`,dek:object.metadata.dek,ciphertextSize:object.ciphertext.length,ciphertextSha256:hash(object.ciphertext),expiresAt:new Date(Date.now()+300000).toISOString()};},
  }};
  const options={store,client,deviceId:`device-${accountId}`,rootPath:path.join(directory,'collaboration-transfer'),policy:{enabled:true,tasks:true,workspaceShares:true},assertActive:()=>{},
    fetchImpl:(url,options)=>{const parsed=new URL(url);assert.equal(parsed.origin,'https://provider.invalid');return fetch(`http://127.0.0.1:${server.address().port}${parsed.pathname}`,options);}};
  const item={store,git:new TaskGit({rootPath:path.join(directory,'git'),gitOptions:{autoInstall:false}}),runtime:createTransferRuntime(options),restart(){this.runtime.stop();this.runtime=createTransferRuntime(options);}};
  clients.push(item);assert.ok(item.runtime.taskFiles,JSON.stringify(item.runtime));return item;
}
const file=(directory,name,bytes)=>{fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,name),bytes);return {path:name,sha256:hash(bytes),sizeBytes:Buffer.byteLength(bytes)};};
try {
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const alice=assemble('alice'),bob=assemble('bob');
  const source=path.join(root,'source'),changed=path.join(root,'changed');
  const manifest=[file(source,'large.bin',randomBytes(6*1024**2)),file(source,'work.txt','before')];
  const baseline=await alice.git.captureBaseline({taskId:task.id,snapshotRoot:source,manifest});
  const initial=await createTaskGitTransport(alice.git).exportBundle({revision:baseline,destination:path.join(root,'input.bundle')});
  const prepared=await alice.runtime.taskFiles.prepareUpload({conversationId:'chat',inputPath:initial.packagePath,originalName:'input.bundle',expectedPlaintextSha256:initial.descriptor.sha256});assert.equal(prepared.ok,true);
  const interrupted=await alice.runtime.taskFiles.upload(prepared.id);assert.equal(interrupted.ok,false);assert.equal(interrupted.retryable,true,JSON.stringify(interrupted));
  alice.restart();const uploaded=await alice.runtime.taskFiles.upload(prepared.id);assert.equal(uploaded.ok,true);
  task.inputSnapshotId=uploaded.objectId;
  const baseObject=objects.get(uploaded.objectId);assert.deepEqual(baseObject.puts,[1,2],'acknowledged-by-provider part is reconciled after restart, not resent');
  const receive=async(item,objectId,descriptor)=>{const downloaded=await item.runtime.taskFiles.download({conversationId:'chat',taskId:task.id,objectId});assert.equal(downloaded.ok,true,downloaded.code);assert.equal(hash(fs.readFileSync(downloaded.packagePath)),descriptor.sha256);await createTaskGitTransport(item.git).importBundle({packagePath:downloaded.packagePath,descriptor});return downloaded;};
  await receive(bob,uploaded.objectId,initial.descriptor);assert.equal(baseObject.ranges.length,2);
  assert.equal(baseObject.ciphertext.includes(Buffer.from('# v2 git bundle')),false,'provider sees encrypted bytes');
  const update=file(changed,'work.txt','after');
  const contribution=await bob.git.captureContribution({baseline:{...baseline,repository:(await bob.git.ensure()).repository},baseManifest:manifest,materializedPaths:manifest.map(f=>f.path),deliveryId:'delivery',snapshotRoot:changed,manifest:[manifest[0],update]});
  const delta=await createTaskGitTransport(bob.git).exportBundle({revision:contribution,prerequisites:[baseline.commit],destination:path.join(root,'delta.bundle')});
  const delivery=await bob.runtime.taskFiles.prepareUpload({conversationId:'chat',inputPath:delta.packagePath,originalName:'delta.bundle',expectedPlaintextSha256:delta.descriptor.sha256});assert.equal(delivery.ok,true);
  const submitted=await bob.runtime.taskFiles.upload(delivery.id);assert.equal(submitted.ok,true);task.deliveries.push({id:submitted.objectId});
  const deltaObject=objects.get(submitted.objectId);assert.ok(deltaObject.ciphertext.length<baseObject.ciphertext.length/100,'encryption retains incremental transfer savings');
  deltaObject.corrupt=true;
  const corrupt=await alice.runtime.taskFiles.download({conversationId:'chat',taskId:task.id,objectId:submitted.objectId});assert.equal(corrupt.ok,false);assert.match(corrupt.code,/INTEGRITY/);
  deltaObject.corrupt=false;alice.restart();await receive(alice,submitted.objectId,delta.descriptor);
  const snapshot=await alice.git.materializeSnapshot({revision:delta.descriptor,parentCommit:baseline.commit,destinationRoot:path.join(root,'result')});
  assert.deepEqual(snapshot.manifest,[manifest[0],update]);assert.equal(fs.readFileSync(path.join(snapshot.snapshotRoot,'work.txt'),'utf8'),'after');
  deltaObject.authorized=false;
  assert.equal((await alice.runtime.taskFiles.download({conversationId:'chat',taskId:task.id,objectId:submitted.objectId})).code,'COLLAB_OBJECT_UNAVAILABLE','cached plaintext still requires a fresh ticket');
  if(serverError)throw serverError;
  console.log(`Git encrypted HTTP transfer: two accounts/repositories, multipart response-loss restart, Range download, corruption recovery, revoked cache and exact ancestry passed; ciphertext baseline=${baseObject.ciphertext.length}, delta=${deltaObject.ciphertext.length}. Object API/ACL/provider are fixtures; no production TLS or full-service claim.`);
} finally {
  for(const item of clients){item.runtime.stop?.();item.store.close();}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});
}
