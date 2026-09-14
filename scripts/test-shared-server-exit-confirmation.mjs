import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {OpencodeSharedServer}=require('../src/main/runtime/opencode-shared-server');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'shared-server-exit-'));
const marker=path.join(root,'tool-writes'),engine=path.join(root,'engine');
const tool=`const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),20);`;
fs.writeFileSync(engine,`#!${process.execPath}\nconst fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(tool)}],{stdio:'ignore'});setTimeout(()=>process.exit(2),5000);setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)}))process.exit(0);},20);\n`,{mode:0o700});
const server=new OpencodeSharedServer({serverCommand:engine,cwd:root,dataDir:':memory:'});
try{
 await assert.rejects(server.ensureStarted({timeoutMs:4000}),/exited before listening/);
 assert.equal(server.process,null,'leader exit cleared the live process field');
 const receipt=server.terminate();assert.equal(receipt,server.terminate(),'repeated termination observes the same pending shutdown');
 let resolved=false;receipt.then(()=>resolved=true);
 await new Promise(resolve=>setTimeout(resolve,50));assert.equal(resolved,false,'cleared process field cannot discard the surviving owned process group');
 assert.equal((await receipt).ok,true);
 const size=fs.statSync(marker).size;await new Promise(resolve=>setTimeout(resolve,60));assert.equal(fs.statSync(marker).size,size);
 await assert.rejects(server.ensureStarted(),/terminated/,'a terminated owner cannot spawn again under an old shutdown receipt');
 const idle=new OpencodeSharedServer({serverCommand:engine,cwd:root,dataDir:':memory:'});let nested;
 idle._sseAbort={abort(){nested=idle.terminate();}};
 const idleReceipt=idle.terminate();assert.equal(nested,idleReceipt,'reentrant teardown observes the established receipt');
 assert.equal((await idleReceipt).ok,true);
 console.log('shared server exit: real engine exit retains tool ownership, awaits group shutdown and rejects stale restart passed');
}finally{await server.terminate();fs.rmSync(root,{recursive:true,force:true});}
