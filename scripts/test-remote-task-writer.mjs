import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createLocalWriter}=require('../src/main/collaboration/local-writer');
const {createTaskApplication}=require('../src/main/collaboration/task-application');
const childMode=process.argv[2]==='apply';
const root=childMode?process.argv[3]:fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'lily-task-writer-'));
const ready=path.join(root,'ready'),filePath=path.join(root,'global','writer.sqlite');
const manifest=(name,bytes)=>[{path:name,sizeBytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}];
function account(name,hold=false) {
  // Separate account/profile databases and recovery directories, one physical W.
  const profile=path.join(root,name);fs.mkdirSync(profile,{recursive:true});
  const journalRoot=path.join(profile,'recovery');fs.mkdirSync(journalRoot,{recursive:true});
  const db=new DatabaseSync(path.join(profile,'account.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS journal (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  const journal={get:id=>{const row=db.prepare('SELECT payload FROM journal WHERE id=?').get(id);return row?JSON.parse(row.payload):null;},put(id,value){
    // A dies after rename, before its completion receipt. The saved "writing"
    // checkpoint must remain recoverable and must fence B throughout the stall.
    if(hold && value.operations.some(item=>item.state==='done')) {
      fs.writeFileSync(ready,'locked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
    }
    db.prepare('INSERT OR REPLACE INTO journal VALUES (?,?)').run(id,JSON.stringify(value));
  }};
  return {db,journal,broker:createTaskApplication({journal,journalRoot,assertAuthorized:async()=>true,writer:createLocalWriter({filePath})})};
}
if(childMode) {
  const a=account('account-a',true),input=JSON.parse(fs.readFileSync(path.join(root,'a-input.json'),'utf8'));
  await a.broker.apply(input);
} else {
  let child,a,b;
  try {
    for(const folder of ['workspace/sub','delivery-a/sub','delivery-b'])fs.mkdirSync(path.join(root,folder),{recursive:true});
    fs.writeFileSync(path.join(root,'workspace/sub/doc.txt'),'old');
    fs.writeFileSync(path.join(root,'delivery-a/sub/doc.txt'),'one');
    fs.writeFileSync(path.join(root,'delivery-b/doc.txt'),'two');
    a=account('account-a');b=account('account-b');
    const inputA={applicationId:'a',rootPath:path.join(root,'workspace'),deliveryRoot:path.join(root,'delivery-a'),baseManifest:manifest('sub/doc.txt','old'),deliveryManifest:manifest('sub/doc.txt','one'),editablePaths:['sub/doc.txt']};
    const inputB={applicationId:'b',rootPath:path.join(root,'workspace/sub'),deliveryRoot:path.join(root,'delivery-b'),baseManifest:manifest('doc.txt','old'),deliveryManifest:manifest('doc.txt','two'),editablePaths:['doc.txt']};
    inputA.expectedPlanHash=(await a.broker.preview(inputA)).planHash;
    inputB.expectedPlanHash=(await b.broker.preview(inputB)).planHash;
    fs.writeFileSync(path.join(root,'a-input.json'),JSON.stringify(inputA));
    child=fork(new URL(import.meta.url),['apply',root],{stdio:'ignore'});
    const deadline=Date.now()+10000;
    while(!fs.existsSync(ready) && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(fs.existsSync(ready),'real application reached the interrupted write checkpoint');
    await assert.rejects(b.broker.apply(inputB),/APPLICATION_BUSY/);
    await assert.rejects(a.broker.recover({applicationId:'a',mode:'rollback'}),/APPLICATION_BUSY/);
    const versions=new (require('../src/main/workspace-version-service').WorkspaceVersionService)({writerLockPath:filePath});
    await assert.rejects(versions.restore(path.join(root,'workspace'),'unused'),/WORKSPACE_VERSION_BUSY/,'version restoration must not enter another process task write');
    assert.equal(b.journal.get('b'),null,'busy admission creates no partial application or recovery obligation');
    assert.equal(fs.readFileSync(path.join(root,'workspace/sub/doc.txt'),'utf8'),'one');
    const exit=once(child,'exit');child.kill('SIGKILL');await exit;child=null;
    await assert.rejects(b.broker.apply(inputB),/PREVIEW_CHANGED/);
    assert.equal(b.journal.get('b'),null,'after acquiring the released lock, stale previews still cannot overwrite');
    assert.equal((await a.broker.recover({applicationId:'a',mode:'rollback'})).state,'rolled_back');
    assert.equal((await b.broker.apply(inputB)).state,'applied');
    assert.equal(fs.readFileSync(path.join(root,'workspace/sub/doc.txt'),'utf8'),'two');
    console.log('task writer: independent accounts/processes, nested target, busy apply/rollback, crash recovery and stale preview passed');
  } finally {
    if(child){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}
    a?.db.close();b?.db.close();fs.rmSync(root,{recursive:true,force:true});
  }
}
