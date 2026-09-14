import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {terminateProcessGroup}=require('../src/main/process-tree-kill');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'engine-exit-'));
let child;
try{
 assert.equal(typeof terminateProcessGroup,'function');
 const marker=path.join(root,'writer');
 const source=`const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(process.argv[1],'x'),20);`;
 const script=`const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(source)},${JSON.stringify(marker)}],{stdio:'ignore'});setTimeout(()=>process.exit(0),150);`;
 child=spawn(process.execPath,['-e',script],{detached:true,stdio:'ignore'});
 await once(child,'exit');assert.ok(fs.existsSync(marker));
 let resolved=false;
 const pending=terminateProcessGroup(child,{hardKillDelayMs:300,timeoutMs:3000}).then(result=>{resolved=true;return result;});
 await new Promise(resolve=>setTimeout(resolve,80));assert.equal(resolved,false,'parent exit is not evidence that tool writers stopped');
 const result=await pending;assert.equal(result.ok,true);
 const size=fs.statSync(marker).size;await new Promise(resolve=>setTimeout(resolve,80));assert.equal(fs.statSync(marker).size,size);
 child=null;
 const denied=await terminateProcessGroup({pid:12345,kill(){}},{platform:'darwin',kill:()=>{throw Object.assign(Error('denied'),{code:'EPERM'});},hardKillDelayMs:5,timeoutMs:20});
 assert.equal(denied.ok,false,'permission errors cannot be interpreted as process absence');
 const windows=await terminateProcessGroup({pid:12345},{platform:'win32',spawn:()=>({on(){}})});
 assert.equal(windows.ok,false,'taskkill dispatch alone is not verified tree completion');
 const signals=[];
 assert.equal((await terminateProcessGroup({pid:12345,kill(){}},{platform:'darwin',kill:(_pid,signal)=>{if(signal)signals.push(signal);},hardKillDelayMs:40,timeoutMs:1})).ok,false);
 await new Promise(resolve=>setTimeout(resolve,60));assert.ok(signals.includes('SIGKILL'),'an observation timeout must not cancel the requested hard-kill fallback');
 for(const pid of [1,process.pid])assert.equal((await terminateProcessGroup({pid},{kill:()=>assert.fail('unsafe pid')})).ok,false);
 console.log('engine exit: real surviving tool writer, confirmed group absence, denied probes and unsupported proof passed');
}finally{if(child){try{process.kill(-child.pid,'SIGKILL');}catch{}}fs.rmSync(root,{recursive:true,force:true});}
