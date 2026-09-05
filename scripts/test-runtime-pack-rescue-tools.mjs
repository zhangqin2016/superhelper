import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'lily-rescue-'));
process.env.LILY_USER_DATA_DIR = path.join(tmp,'user');
process.env.LILY_RUNTIME_PACK_ROOT = path.join(tmp,'packs');
process.env.LILY_BUNDLED_RUNTIME_PACK_ROOTS = path.join(tmp,'bundled');
try {
  const { listRuntimePackTool:list, installRuntimePackTool:install } = require('../src/main/mcp/runtime-pack-tools');
  let row={id:'ffmpeg', installed:false}; let checked=0; let healthy=false;
  const deps={runtimePackInstaller:{listRuntimePacks:()=>({ok:true,packs:[row]}),startRuntimePackInstall:(id,opts)=>{row={...row,installing:true,progress:{phase:'resolving'}};return {ok:true,id,started:true,installing:true,opts};}},checkRuntimePackHealth:async()=>{checked++;return {ok:healthy,error:healthy?null:'BROKEN'};},runtimePython:{getBundledPythonEnv:e=>({...e,SECRET:'must not leak'}),getRuntimeEnvExtras:()=>({PYTHONPATH:tmp}),getRuntimePathEntries:()=>[tmp],resolveVenvPython:()=>'/usr/bin/python3'}};
  assert.equal((await list({},null,deps)).packs[0].status,'missing'); assert.equal(checked,0);
  assert.equal((await list({verify:true},null,deps)).error,'PACK_ID_REQUIRED_FOR_HEALTH_CHECK');
  assert.equal((await list({packId:'bogus'},null,deps)).error,'INVALID_RUNTIME_PACK');
  const started=await install({packId:'ffmpeg',repair:true},null,deps);assert.deepEqual(started.opts,{repair:true,force:true});
  let result=await list({packId:'ffmpeg',verify:true},null,deps);assert.equal(result.packs[0].status,'installing'); assert.equal(result.packs[0].ready,false);assert.equal(checked,0);
  row={id:'ffmpeg',installed:false,progress:{phase:'failed',error:'CHECKSUM_MISMATCH'}};
  result=await list({packId:'ffmpeg'},null,deps);assert.equal(result.packs[0].status,'failed');assert.equal(result.packs[0].progress.error,'CHECKSUM_MISMATCH');
  row={id:'ffmpeg',installed:true}; result=await list({packId:'ffmpeg',verify:true},null,deps);assert.equal(result.packs[0].status,'unhealthy');
  healthy=true; result=await list({packId:'ffmpeg',verify:true},null,deps); const ready=result.packs[0];assert.equal(ready.status,'ready');assert.equal(ready.execution.env.SECRET,undefined);
  row={id:'ffmpeg',installed:true,bundled:true,readOnly:true}; healthy=false;
  result=await list({packId:'ffmpeg',verify:true},null,deps);
  assert.equal(result.packs[0].status,'unhealthy');assert.equal(result.packs[0].repairSupported,false);
  assert.match(result.packs[0].repairLimitation,/BUNDLED_RUNTIME_PACK_READ_ONLY/);
  const blocked=await install({packId:'ffmpeg',repair:true},null,deps);
  assert.equal(blocked.started,false);assert.equal(blocked.error,'BUNDLED_RUNTIME_PACK_READ_ONLY');assert.equal(row.installing,undefined);
  row={id:'ffmpeg',installed:true,base:true,readOnly:true};
  assert.equal((await list({packId:'ffmpeg'},null,deps)).packs[0].repairSupported,true);
  assert.equal((await install({packId:'ffmpeg',repair:true},null,deps)).started,true,'base runtime permits managed overlay');
  // Execute a real fixture through a previously missing PATH and PYTHONPATH.
  const py='/usr/bin/python3'; if(fs.existsSync(py)) {
    const code='import lily_rescue_fixture; print(lily_rescue_fixture.OK)';
    assert.notEqual(spawnSync(py,['-c',code],{env:{PATH:'/usr/bin'},encoding:'utf8'}).status,0);
    fs.writeFileSync(path.join(tmp,'lily_rescue_fixture.py'),'OK = "recovered"\n');
    const retry=spawnSync(ready.execution.python,['-c',code],{env:ready.execution.env,encoding:'utf8'});assert.equal(retry.status,0,retry.stderr);assert.equal(retry.stdout.trim(),'recovered');
  }
  // Real installer lifecycle: deferred artifact resolution exposes progress,
  // and terminal failure remains observable after active job cleanup.
  const service=require('../src/main/service-client');let resolve;
  service.runtimePackArtifact=()=>new Promise(r=>{resolve=r;});
  const installer=require('../src/main/runtime-pack-installer');
  const job=installer.startRuntimePackInstall('git',{force:true});assert.equal(job.installing,true);
  assert.ok(!installer.listRuntimePacks().packs.some(p=>p.id==='git'));
  assert.ok((await list({},null,{runtimePackInstaller:installer})).packs.some(p=>p.id==='git'),'broker catalog preserves all previously discoverable pack IDs');
  assert.equal(installer.listRuntimePacks({packId:'git'}).packs.find(p=>p.id==='git').installing,true);
  await new Promise(r=>setImmediate(r)); resolve({ok:false,error:'CONTROLLED_UNAVAILABLE'});
  for(let i=0;i<20 && installer.installingRuntimePackIds().has('git');i++) await new Promise(r=>setImmediate(r));
  const failed=installer.listRuntimePacks({packId:'git'}).packs.find(p=>p.id==='git');assert.equal(failed.installing,false);assert.equal(failed.progress.phase,'failed');assert.ok(failed.progress.error);
  console.log('runtime-pack-rescue-tools: ok');
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
