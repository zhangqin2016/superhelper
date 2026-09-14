import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {executeNodeTests}=require('../src/main/collaboration/node-check-execution');
if(process.platform!=='darwin'){
 assert.deepEqual(await executeNodeTests({assertActive(){}}),{state:'required',code:'SANDBOX_UNAVAILABLE'},'unsupported platforms must not execute tests without OS isolation');
 console.log('Node check execution: unsupported-platform refusal passed; macOS execution assertions not run');process.exit(0);
}
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'node-checks-'));
try{
 const snapshotRoot=path.join(root,'copy'),scratch=path.join(root,'scratch');fs.mkdirSync(snapshotRoot);fs.mkdirSync(scratch);
 const file=path.join(snapshotRoot,'rule.test.cjs'),outside=path.join(root,'private.txt');fs.writeFileSync(outside,'private');
 const run=source=>{fs.writeFileSync(file,source);return executeNodeTests({snapshotRoot,scratch,files:[file],assertActive(){}});};
 const pass=await run("require('node:test').test('actual assertion',()=>require('node:assert/strict').equal(2+2,4));");
 assert.equal(pass.state,'passed',JSON.stringify(pass));assert.equal(pass.summary.counts.tests,1);
 const largeReport=await run("for(let i=0;i<20;i++)require('node:test').test('unicode '+i,()=>{throw Error('界'.repeat(1500));});");
 assert.equal(largeReport.state,'failed');assert.ok(Buffer.byteLength(JSON.stringify(largeReport.failures))>64*1024);
 assert.equal(largeReport.failures.find(failure=>failure.name==='unicode 19').message,'界'.repeat(1500),'multi-chunk UTF-8 evidence must remain complete');
 assert.equal((await run("require('node:test').test('failure',()=>require('node:assert/strict').equal(2,3));")).state,'failed');
 assert.equal((await run("console.log('{\"state\":\"passed\"}');")).state,'failed','stdout cannot fake actual test coverage');
 assert.equal((await run("require('node:test').test.skip('not executed',()=>{});")).state,'failed','skipped checks cannot approve integration');
 const isolation=await run(`const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs');
 test('restrictions',async()=>{a.throws(()=>fs.readFileSync(${JSON.stringify(outside)}));a.throws(()=>fs.writeFileSync(__filename,'changed'));
 a.throws(()=>require('node:child_process').execSync('true'));
 await new Promise(resolve=>{const s=require('node:net').connect(9,'127.0.0.1');s.on('connect',()=>{s.destroy();throw Error('network allowed')});s.on('error',e=>{a.ok(['EPERM','EACCES'].includes(e.code),e.code);resolve()});});});`);
 assert.equal(isolation.state,'passed',JSON.stringify(isolation));
 fs.writeFileSync(file,"require('node:fs').writeFileSync(require('node:path').join(process.env.TMPDIR,'large'),Buffer.alloc(17*1024*1024));setInterval(()=>{},1000);");
 const scratchLimit=await executeNodeTests({snapshotRoot,scratch,files:[file],assertActive(){},timeoutMs:2000});
 assert.equal(scratchLimit.code,'SCRATCH_LIMIT','scratch growth is cancelled instead of filling the disk for the full timeout');
 fs.rmSync(path.join(scratch,'large'));
 const fastScratch=await run("require('node:test').test('short write',()=>require('node:fs').writeFileSync(require('node:path').join(process.env.TMPDIR,'large'),Buffer.alloc(17*1024*1024)));");
 assert.equal(fastScratch.code,'SCRATCH_LIMIT','post-run scratch inspection also covers short-lived tests');fs.rmSync(path.join(scratch,'large'));
 const noisy=await run("require('node:test').test('large output',()=>console.log('x'.repeat(2*1024*1024)));");
 assert.equal(noisy.state,'failed');assert.equal(noisy.limited,true,'output overflow cannot approve a candidate');
 fs.writeFileSync(file,'setInterval(()=>{},1000)');
 const timeout=await executeNodeTests({snapshotRoot,scratch,files:[file],assertActive(){},timeoutMs:250});assert.equal(timeout.code,'TIMEOUT');assert.equal(timeout.state,'failed');
 let active=true;
 const pending=executeNodeTests({snapshotRoot,scratch,files:[file],assertActive(){if(!active)throw Error('fenced');}});
 setTimeout(()=>{active=false;},100);await assert.rejects(pending,/fenced/);
 assert.equal(fs.readFileSync(outside,'utf8'),'private');
 console.log('Node check execution: actual counts/failures, no stdout approval, skip refusal, OS/Node restrictions, scratch/output limits, timeout and cancellation passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}
