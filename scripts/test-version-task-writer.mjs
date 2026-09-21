import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {WorkspaceVersionService}=require('../src/main/workspace-version-service');
const {createLocalWriter}=require('../src/main/collaboration/local-writer');
const {createTaskApplication}=require('../src/main/collaboration/task-application');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'version-task-writer-'));
const workspace=path.join(root,'workspace'),delivery=path.join(root,'delivery'),journalRoot=path.join(root,'journal'),filePath=path.join(root,'writer.sqlite');
for(const p of [workspace,delivery,journalRoot])fs.mkdirSync(p);
const manifest=text=>[{path:'file.txt',sha256:crypto.createHash('sha256').update(text).digest('hex'),sizeBytes:Buffer.byteLength(text)}];
try{
 const versions=new WorkspaceVersionService({writerLockPath:filePath,git:{isAvailable:async()=>false}});
 fs.writeFileSync(path.join(workspace,'file.txt'),'old');
 const saved=await versions.save(workspace);
 fs.writeFileSync(path.join(workspace,'file.txt'),'new');fs.writeFileSync(path.join(delivery,'file.txt'),'remote');
 const records=new Map(),broker=createTaskApplication({writer:createLocalWriter({filePath}),journalRoot,assertAuthorized:async()=>true,journal:{get:id=>records.get(id),put:(id,value)=>records.set(id,structuredClone(value))}});
 const input={applicationId:'apply',rootPath:workspace,deliveryRoot:delivery,baseManifest:manifest('new'),deliveryManifest:manifest('remote'),editablePaths:['file.txt']};
 const preview=await broker.preview(input);
 const restore=versions.snapshots.restore.bind(versions.snapshots);
 let reached,release;
 const started=new Promise(resolve=>reached=resolve),resume=new Promise(resolve=>release=resolve);
 versions.snapshots.restore=async(...args)=>{const result=await restore(...args);reached();await resume;return result;};
 const pending=versions.restore(workspace,saved.version.id);await started;
 try{
   assert.equal(fs.readFileSync(path.join(workspace,'file.txt'),'utf8'),'old');
   await assert.rejects(broker.apply({...input,expectedPlanHash:preview.planHash}),/APPLICATION_BUSY/);
   assert.equal(records.size,0,'blocked task application creates no partial journal');
 }finally{release();await pending;}
 await assert.rejects(broker.apply({...input,expectedPlanHash:preview.planHash}),/PREVIEW_CHANGED/,'after restoration releases the lock, the old task preview cannot overwrite restored files');
 assert.equal(versions.isMutating(workspace),false);
 createLocalWriter({filePath}).run(()=>{});
 console.log('version/task writer: real snapshot restore, async write exclusion, journal preservation and stale-preview refusal passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}
