import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createRequire} from 'node:module';import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const {checkSyntax,checkCandidateJavascript}=require('../src/main/collaboration/candidate-javascript');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'candidate-js-'));
try{
 const sentinel=path.join(root,'executed');
 assert.equal((await checkSyntax({source:Buffer.from(`require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'bad')`),mode:'commonjs',assertActive(){}})).status,'passed');
 assert.equal(fs.existsSync(sentinel),false,'candidate code is parsed, never executed');
 assert.equal((await checkSyntax({source:Buffer.from('export const x = ;'),mode:'module',assertActive(){}})).status,'failed');
 assert.equal((await checkSyntax({source:Buffer.from('export const x = 1'),mode:'module',assertActive(){}})).status,'passed');
 assert.equal((await checkSyntax({source:Buffer.from('export const x = 1'),mode:'commonjs',assertActive(){}})).status,'failed');
 const previous=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS=`--require=${path.join(root,'missing-preload')}`;
 try{assert.equal((await checkSyntax({source:Buffer.from('const x = 1'),mode:'commonjs',assertActive(){}})).status,'passed','inherited preload/options cannot execute inside the checker');}
 finally{if(previous===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=previous;}
 let child;
 const hang=()=>child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['pipe','pipe','pipe']});
 const timed=await checkSyntax({source:Buffer.from(''),mode:'commonjs',assertActive(){},timeoutMs:30,spawnProcess:hang});
 assert.equal(timed.status,'required');assert.equal(timed.code,'TIMEOUT');assert.notEqual(child.signalCode,null,'timeout waits for actual child termination');
 let active=true;
 const pending=checkSyntax({source:Buffer.from(''),mode:'module',assertActive(){if(!active)throw Error('fenced');},spawnProcess:hang});
 active=false;await assert.rejects(pending,/fenced/);assert.notEqual(child.signalCode,null,'cancellation terminates the parser before returning');
 const noisy=()=>child=spawn(process.execPath,['-e',"process.stdout.write('x'.repeat(128*1024));setInterval(()=>{},1000)"],{stdio:['pipe','pipe','pipe']});
 assert.equal((await checkSyntax({source:Buffer.from(''),mode:'module',assertActive(){},spawnProcess:noisy})).code,'OUTPUT_LIMIT');
 assert.notEqual(child.signalCode,null);
 const files={'package.json':'{"type":"module"}','main.js':'export const x=1;',
   'nested/package.json':'{"type":"commonjs"}','nested/main.js':'export const x=1;',
   'auto/package.json':'{}','auto/main.js':'export const x=1;','notes.txt':'not JavaScript'};
 const manifest=Object.entries(files).map(([name,text])=>{
   fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});fs.writeFileSync(path.join(root,name),text);
   return {path:name,sizeBytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')};
 });
 const report=await checkCandidateJavascript({snapshotRoot:root,manifest,assertActive(){}});
 assert.equal(report.status,'failed');assert.equal(report.counts.parsed,3);assert.equal(report.counts.otherFiles,4);
 assert.equal(report.details.find(d=>d.path==='nested/main.js').status,'failed','nearest immutable package scope determines parse mode');
 assert.equal(report.details.find(d=>d.path==='auto/main.js').status,'passed');
 assert.equal(report.details.find(d=>d.path==='auto/main.js').attempts.length,2,'unspecified JS mode accepts valid module syntax without executing it');
 const tooLarge=await checkCandidateJavascript({snapshotRoot:root,manifest:[{path:'huge.js',sizeBytes:1024*1024+1,sha256:'0'.repeat(64)}],assertActive(){}});
 assert.equal(tooLarge.status,'required');assert.equal(tooLarge.counts.parsed,0,'unread/over-limit files never count as syntax coverage');
 console.log('candidate JS: real syntax checks, no execution, module mode, clean env, timeout termination and cancellation passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}
