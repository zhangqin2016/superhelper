import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createLocalWriter}=require('../src/main/collaboration/local-writer');
if(process.argv[2]==='hold') {
  createLocalWriter({filePath:process.argv[3]}).run(()=>{
    fs.writeFileSync(process.argv[4],'locked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
  });
} else {
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'lily-local-writer-'));
  const filePath=path.join(root,'coordination','writer.sqlite'),ready=path.join(root,'ready');
  let child;
  try {
    const homedir=os.homedir;
    try {
      os.homedir=()=>root;
      createLocalWriter().run(()=>assert.throws(()=>createLocalWriter().run(()=>{}),/APPLICATION_BUSY/));
      assert.ok(fs.existsSync(path.join(root,'.lily-workbench-coordination','writer.sqlite')),'default coordination is OS-user scoped, outside account/profile storage');
    } finally {os.homedir=homedir;}
    const a=createLocalWriter({filePath}), b=createLocalWriter({filePath});
    let writes=0;
    a.run(()=>{
      assert.throws(()=>b.run(()=>writes++),/COLLAB_TASK_APPLICATION_BUSY/);
      assert.throws(()=>a.run(()=>writes++),/COLLAB_TASK_APPLICATION_BUSY/);
    });
    assert.equal(writes,0,'neither another account nor reentrant work may enter a held writer');
    assert.throws(()=>a.run(()=>{throw Error('checkpoint failure');}),/checkpoint failure/);
    b.run(()=>writes++);
    assert.equal(writes,1,'exceptions release the lock for journal recovery');
    assert.throws(()=>a.run(async()=>{}),/SYNC_REQUIRED/);
    child=fork(new URL(import.meta.url),['hold',filePath,ready],{stdio:'ignore'});
    const deadline=Date.now()+10000;
    while(!fs.existsSync(ready) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(fs.existsSync(ready),'independent process acquired the kernel lock');
    assert.throws(()=>b.run(()=>writes++),/COLLAB_TASK_APPLICATION_BUSY/);
    const exit=once(child,'exit');child.kill('SIGKILL');await exit;child=null;
    b.run(()=>writes++);
    assert.equal(writes,2,'kernel releases killed owner without lease expiry or lock-file deletion');
    assert.ok(fs.existsSync(filePath));
    const alias=path.join(root,'alias');fs.symlinkSync(path.dirname(filePath),alias);
    assert.throws(()=>createLocalWriter({filePath:path.join(alias,'writer.sqlite')}).run(()=>writes++),/UNSAFE_PATH/);
    const linked=path.join(root,'linked.sqlite');fs.linkSync(filePath,linked);
    assert.throws(()=>b.run(()=>writes++),/UNSAFE_PATH/);
    fs.unlinkSync(linked);
    assert.equal(writes,2);
    let release,entered;
    const started=new Promise(resolve=>entered=resolve);
    const pending=a.runAsync(async()=>{entered();await new Promise(resolve=>release=resolve);});
    await started;
    assert.throws(()=>b.run(()=>writes++),/APPLICATION_BUSY/,'async version writes must exclude synchronous task applications across await');
    await assert.rejects(b.runAsync(async()=>writes++),/APPLICATION_BUSY/);
    release();await pending;
    await assert.rejects(a.runAsync(async()=>{throw Error('async failure');}),/async failure/);
    b.run(()=>writes++);assert.equal(writes,3);
    console.log('local writer: account/reentrant exclusion, exception/crash release and unsafe paths passed');
  } finally {
    if(child){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}
    fs.rmSync(root,{recursive:true,force:true});
  }
}
