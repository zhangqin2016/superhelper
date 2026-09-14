import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
const require=createRequire(import.meta.url);
const {createForegroundWriter,spawnForeground}=require('../src/main/collaboration/foreground-writer');
const {terminateProcessGroup}=require('../src/main/process-tree-kill');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'foreground-writer-'));
const filePath=path.join(root,'writer.sqlite'),writer=createForegroundWriter({filePath}),marker=path.join(root,'writes');
const children=[];
const wait=async test=>{const until=Date.now()+8000;while(!test()){if(Date.now()>until)throw Error('timeout');await new Promise(r=>setTimeout(r,20));}};
try{
 const tool=`const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),20);`;
 const code=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(tool)}],{stdio:'ignore'});setTimeout(()=>process.exit(0),100);`;
 const child=spawnForeground(process.execPath,['-e',code],{cwd:root,env:process.env,stdio:['ignore','ignore','ignore']},{filePath});children.push(child);
 await wait(()=>fs.existsSync(marker));
 await wait(()=>child.exitCode!==null);
 assert.throws(()=>writer.run(()=>assert.fail('cannot enter during surviving tool writes')),/BUSY/);
 const size=fs.statSync(marker).size;await new Promise(r=>setTimeout(r,80));assert.ok(fs.statSync(marker).size>size,'a exited wrapper is not proof that the process group stopped');
 assert.equal((await terminateProcessGroup(child)).ok,true);
 writer.run(()=>fs.writeFileSync(path.join(root,'applied'),'yes'));
 assert.equal(fs.existsSync(path.join(root,'applied')),true);
 let child2;
 await require('../src/main/collaboration/local-writer').createLocalWriter({filePath}).runAsync(async()=>{
   child2=spawnForeground(process.execPath,['-e',`require('node:fs').writeFileSync(${JSON.stringify(path.join(root,'started'))},'yes')`],{cwd:root,env:process.env,stdio:['ignore','ignore','ignore']},{filePath});children.push(child2);
   await new Promise(r=>setTimeout(r,150));assert.equal(fs.existsSync(path.join(root,'started')),false,'registration must precede command execution under the same writer lock');
 });
 await wait(()=>fs.existsSync(path.join(root,'started')));
 await wait(()=>child2.exitCode!==null);
 writer.run(()=>{});
 const ownerCode=`const fs=require('node:fs');const child=require(${JSON.stringify(require.resolve('../src/main/collaboration/foreground-writer'))}).spawnForeground(process.execPath,['-e',${JSON.stringify(tool)}],{cwd:${JSON.stringify(root)},env:process.env,stdio:['ignore','ignore','ignore']},{filePath:${JSON.stringify(filePath)},parentBound:true});fs.writeFileSync(${JSON.stringify(path.join(root,'owner-child'))},String(child.pid));setInterval(()=>{},1000);`;
 const owner=spawn(process.execPath,['-e',ownerCode],{stdio:'ignore',env:process.env});
 try{
   await wait(()=>fs.existsSync(path.join(root,'owner-child')));
   const owned={pid:Number(fs.readFileSync(path.join(root,'owner-child'),'utf8'))};children.push(owned);
   const before=fs.statSync(marker).size;await wait(()=>fs.statSync(marker).size>before);
   owner.kill('SIGKILL');
   await wait(()=>{try{writer.run(()=>{});return true;}catch(error){if(!/BUSY/.test(error.code))throw error;return false;}});
 }finally{owner.kill('SIGKILL');}
 console.log('PASS foreground writer: surviving process group blocks application, exit reclaims admission, command waits behind writer');
}finally{for(const child of children)await terminateProcessGroup(child);fs.rmSync(root,{recursive:true,force:true});}
