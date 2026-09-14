import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {CollaborationStore}=require('../src/main/collaboration/collaboration-store');
const {LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring');
const {createTransferRuntime}=require('../src/main/collaboration/transfer-runtime');
const {createTaskRecords}=require('../src/main/collaboration/task-records');
const {createTransferManifestStore}=require('../src/main/collaboration/transfer-manifest');
const {createTaskTransferJournal}=require('../src/main/collaboration/task-transfer-journal');
const manifests=f=>createTransferManifestStore({rootPath:f.rootPath,accountId:'owner',keyring:f.store.keyring,recovery:createTaskTransferJournal({store:f.store,deviceId:'device',assertActive(){}})});
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'task-transfer-journal-'))),rootPath=path.join(root,'collaboration-transfer'),source=path.join(root,'source');fs.writeFileSync(source,'original candidate');
 const keyring=new LocalCollaborationKeyring({filePath:path.join(root,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
 let store,runtime;const calls=[];
 const open=(deviceId='device')=>{store=new CollaborationStore({dbPath:path.join(root,'db'),accountId:'owner',keyring});if(!store.getConversation({conversationId:'chat'}))store.replaceProjectionFromBootstrap({conversations:[{id:'chat',kind:'direct'}]});
 runtime=createTransferRuntime({store,deviceId,rootPath,policy:{enabled:true,workspaceShares:true},assertActive(){},client:{objects:{init:async input=>{calls.push(input);throw Object.assign(Error('lost ACK'),{code:'COLLAB_RESPONSE_UNKNOWN',retryable:true});}}}});assert.equal(runtime.ok,true);return runtime;};
 const close=()=>{runtime?.stop();store?.close();store=null;};t.after(()=>{close();fs.rmSync(root,{recursive:true,force:true});});open();
 return {root,rootPath,source,calls,open,close,get store(){return store;},get runtime(){return runtime;},folder:id=>path.join(rootPath,createHash('sha256').update('owner').digest('hex'),id),
 prepare:()=>runtime.taskFiles.prepareUpload({conversationId:'chat',inputPath:source,originalName:'candidate.bundle'}),records:()=>createTaskRecords({store,assertActive(){}})};
}
test('task transfer journal restores a missing manifest and directory with original commands across SQLite reopen',async t=>{
 const f=fixture(t),prepared=await f.prepare();assert.equal(prepared.ok,true);await f.runtime.taskFiles.upload(prepared.id);
 const journal=f.records().list('chat').find(row=>row.kind==='task-transfer-journal');assert.ok(journal,'task uploads need independent encrypted identity before dispatch');
 assert.equal(journal.snapshot.id,prepared.id);assert.equal(journal.snapshot.checkpoint.deviceId,'device');
 const raw=f.store.db.get('SELECT payload_envelope_json FROM task_workspace_records WHERE id=?',journal.id).payload_envelope_json;
 assert.equal(raw.includes(journal.snapshot.checkpoint.content.dek),false);
 fs.unlinkSync(path.join(f.folder(prepared.id),'manifest.json'));f.close();f.open();
 await f.runtime.taskFiles.upload(prepared.id);assert.deepEqual(f.calls[1],f.calls[0]);
 fs.rmSync(f.folder(prepared.id),{recursive:true});f.close();f.open();
 await f.runtime.taskFiles.upload(prepared.id);assert.deepEqual(f.calls[2],f.calls[0]);
});
test('cancelled state survives losing the whole transfer directory',async t=>{
 const f=fixture(t),prepared=await f.prepare();await f.runtime.cancel({transferId:prepared.id});
 fs.rmSync(f.folder(prepared.id),{recursive:true});f.close();f.open();
 const result=await f.runtime.taskFiles.upload(prepared.id);assert.equal(result.ok,false);assert.equal(f.calls.length,0);
 assert.equal(f.records().list('chat').find(row=>row.kind==='task-transfer-journal').snapshot.checkpoint.state,'cancelled');
});
test('missing task manifests cannot be adopted by a changed device or overwrite corrupt files',async t=>{
 const f=fixture(t),prepared=await f.prepare(),filename=path.join(f.folder(prepared.id),'manifest.json');
 fs.unlinkSync(filename);f.close();f.open('other-device');assert.equal((await f.runtime.taskFiles.upload(prepared.id)).ok,false);assert.equal(fs.existsSync(filename),false);assert.equal(f.calls.length,0);
 f.close();f.open();fs.writeFileSync(filename,'corrupt');assert.equal((await f.runtime.taskFiles.upload(prepared.id)).ok,false);assert.equal(fs.readFileSync(filename,'utf8'),'corrupt');assert.equal(f.calls.length,0);
});
for(const initial of [false,true])test(`journal commit before ${initial?'first ownership':'cancel'} cache write survives an interrupted rename`,async t=>{
 const f=fixture(t),disk=manifests(f);
 const item=initial?disk.create({conversationId:'chat',scopeId:f.store.getConversation({conversationId:'chat'}).scopeId,direction:'upload',purpose:'workspace'}):disk.read((await f.prepare()).id);
 const rename=fs.renameSync;t.after(()=>{fs.renameSync=rename;});
 fs.renameSync=(from,to)=>{if(to===path.join(f.folder(item.id),'manifest.json'))throw Error('cache-write-interrupted');return rename(from,to);};
 assert.throws(()=>disk.update({id:item.id,expectedRevision:item.revision,checkpoint:{...item.checkpoint,taskOwned:true,deviceId:'device',state:initial?'encrypting':'cancelled'}}),/cache-write-interrupted/);fs.renameSync=rename;
 f.close();f.open();const restored=manifests(f).read(item.id);assert.equal(restored.checkpoint.state,initial?'encrypting':'cancelled');assert.equal(restored.revision,item.revision+1);
 assert.equal((await f.runtime.taskFiles.upload(item.id)).ok,false);assert.equal(f.calls.length,0);
});
test('removal tombstone prevents resurrection from a stale authenticated file',async t=>{
 const f=fixture(t),prepared=await f.prepare(),disk=manifests(f),filename=path.join(f.folder(prepared.id),'manifest.json'),old=fs.readFileSync(filename);
 disk.remove(prepared.id);assert.equal(fs.existsSync(f.folder(prepared.id)),false);
 const tombstone=f.records().list('chat').find(row=>row.kind==='task-transfer-journal');assert.equal(tombstone.deleted,true);assert.equal(tombstone.snapshot.checkpoint.content,undefined);
 fs.mkdirSync(f.folder(prepared.id),{mode:0o700});fs.writeFileSync(filename,old,{mode:0o600});f.close();f.open();
 assert.equal((await f.runtime.taskFiles.upload(prepared.id)).ok,false);assert.equal(f.calls.length,0);assert.equal(f.runtime.list().transfers.some(row=>row.id===prepared.id),false);
});
test('scope revocation cannot decrypt or recreate a missing manifest',async t=>{
 const f=fixture(t),prepared=await f.prepare(),scopeId=f.store.getConversation({conversationId:'chat'}).scopeId;
 fs.rmSync(f.folder(prepared.id),{recursive:true});f.store.revokeScope({scopeId});
 assert.equal((await f.runtime.taskFiles.upload(prepared.id)).ok,false);assert.equal(fs.existsSync(f.folder(prepared.id)),false);assert.equal(f.calls.length,0);
});
test('unknown files and linked directories are preserved instead of being overwritten during recovery',async t=>{
 const f=fixture(t),prepared=await f.prepare(),folder=f.folder(prepared.id);fs.unlinkSync(path.join(folder,'manifest.json'));fs.writeFileSync(path.join(folder,'external.txt'),'keep');
 assert.equal((await f.runtime.taskFiles.upload(prepared.id)).ok,false);assert.equal(fs.existsSync(path.join(folder,'manifest.json')),false);assert.equal(fs.readFileSync(path.join(folder,'external.txt'),'utf8'),'keep');
 fs.rmSync(folder,{recursive:true});const elsewhere=path.join(f.root,'elsewhere');fs.mkdirSync(elsewhere);fs.symlinkSync(elsewhere,folder,'dir');
 assert.equal((await f.runtime.taskFiles.upload(prepared.id)).ok,false);assert.deepEqual(fs.readdirSync(elsewhere),[]);assert.equal(f.calls.length,0);
});
test('interruption between exclusive restoration link and temporary unlink is recoverable',async t=>{
 const f=fixture(t),prepared=await f.prepare(),filename=path.join(f.folder(prepared.id),'manifest.json'),temporary=path.join(f.folder(prepared.id),`.manifest-${randomUUID()}.tmp`);
 fs.renameSync(filename,temporary);fs.linkSync(temporary,filename);assert.equal(fs.lstatSync(filename).nlink,2);
 f.close();f.open();manifests(f).read(prepared.id);assert.equal(fs.existsSync(temporary),false);assert.equal(fs.lstatSync(filename).nlink,1);
 await f.runtime.taskFiles.upload(prepared.id);assert.equal(f.calls.length,1);
});
