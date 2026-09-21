import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {TaskGit}=require('../src/main/collaboration/task-git');
const {taskChangeset}=require('../src/main/collaboration/task-changeset');
const {assertCapacity,collaborationLimits}=require('../src/main/collaboration/resource-policy');
const FILES=Number(process.env.LILY_SCALE_FILES||15000),LARGE=Number(process.env.LILY_SCALE_LARGE_MB||24);
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'lily-git-scale-'));
const hash=b=>createHash('sha256').update(b).digest('hex');
let peak=process.memoryUsage().rss;const monitor=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},20);
const timed=async(name,fn)=>{const start=process.hrtime.bigint();const value=await fn();const ms=Number(process.hrtime.bigint()-start)/1e6;report.steps.push({name,ms:Math.round(ms)});console.log(`${name}: ${Math.round(ms)} ms`);return value;};
const report={files:FILES,largeBytes:LARGE*1024*1024,steps:[],runtime:{node:process.version,platform:`${process.platform}-${process.arch}`,git:execFileSync('git',['--version'],{encoding:'utf8'}).trim()}};
try{
 const source=path.join(root,'source');fs.mkdirSync(source);
 const manifest=[];let totalBytes=0;
 for(let i=0;i<FILES;i++){
  const name=`dir${i%97}/sub${i%13}/file-${String(i).padStart(6,'0')}.txt`,text=`line ${i}\n`.repeat(1+i%40);
  fs.mkdirSync(path.dirname(path.join(source,name)),{recursive:true});fs.writeFileSync(path.join(source,name),text);
  manifest.push({path:name,sha256:hash(text),sizeBytes:Buffer.byteLength(text)});totalBytes+=Buffer.byteLength(text);
 }
 const large=Buffer.alloc(LARGE*1024*1024);for(let i=0;i<large.length;i+=4096)large.writeUInt32LE(i>>>0,i);
 fs.writeFileSync(path.join(source,'assets/large.bin'.replace('assets/','')),large);manifest.push({path:'large.bin',sha256:hash(large),sizeBytes:large.length});totalBytes+=large.length;
 report.totalBytes=totalBytes;
 const tasks=new TaskGit({rootPath:path.join(root,'collaboration'),gitOptions:{autoInstall:false}});
 const baseline=await timed('captureBaseline',()=>tasks.captureBaseline({taskId:'scale',snapshotRoot:source,manifest}));
 const listing=execFileSync('git',['--git-dir',baseline.repository,'ls-tree','-r','-l','-z',baseline.commit],{maxBuffer:256*1024*1024});
 assert.ok(listing.length>1024*1024,`tree listing (${listing.length} bytes) exceeds the former 1 MiB process buffer, so enumeration is streamed`);
 report.treeListingBytes=listing.length;
 const entries=await timed('inspectTree',()=>tasks.inspectTree(baseline.commit));
 assert.equal(entries.length,FILES+1);
 const snapshot=await timed('materializeSnapshot',()=>tasks.materializeSnapshot({revision:baseline,destinationRoot:path.join(root,'snapshot')}));
 assert.equal(snapshot.manifest.length,FILES+1);
 assert.deepEqual(fs.readFileSync(path.join(snapshot.snapshotRoot,'large.bin')),large,'large blob streams through cat-file --batch byte-exact');
 assert.equal(snapshot.manifest.find(f=>f.path==='large.bin').sha256,hash(large));
 const full=await timed('ensureWorktree(full)',()=>tasks.ensureWorktree({baseline,workRoot:path.join(root,'work-full'),manifest}));
 assert.equal(full.materializedPaths.length,FILES+1);assert.equal(execFileSync('git',['-C',path.join(root,'work-full'),'status','--porcelain'],{encoding:'utf8'}),'');
 // Sparse inventory: only small files come to disk; the large asset stays an online-only entry with no placeholder.
 const small=manifest.filter(f=>f.path!=='large.bin').map(f=>f.path);
 const sparse=await timed('ensureWorktree(sparse)',()=>tasks.ensureWorktree({baseline,workRoot:path.join(root,'work-sparse'),manifest,materializePaths:small}));
 assert.equal(sparse.materializedPaths.length,FILES);assert.equal(fs.existsSync(path.join(root,'work-sparse','large.bin')),false,'no empty placeholder for an online-only entry');
 const reopened=await tasks.ensureWorktree({baseline,workRoot:path.join(root,'work-sparse'),manifest});
 assert.equal(reopened.materializedPaths.length,FILES,'the worktree marker remembers the sparse inventory across reopen');
 const after=manifest.filter(f=>f.path!=='large.bin').map(f=>f.path===small[0]?{...f,sha256:hash('edited'),sizeBytes:6}:f);
 const changes=taskChangeset({baseManifest:manifest,manifest:after,materializedPaths:sparse.materializedPaths});
 assert.deepEqual(changes.operations.map(o=>[o.kind,(o.after||o.before).path]),[['modify',small[0]]],'an absent online-only file is not a deletion and the edit is the only operation');
 assert.throws(()=>taskChangeset({baseManifest:manifest,manifest:[...after,{path:'large.bin',sha256:hash('x'),sizeBytes:1}],materializedPaths:sparse.materializedPaths}),/NOT_MATERIALIZED/,'changing a file that was never brought to disk is refused');
 const more=await timed('materializePaths(large)',()=>tasks.materializePaths({baseline,workRoot:path.join(root,'work-sparse'),manifest,paths:['large.bin']}));
 assert.deepEqual(more.added,['large.bin']);assert.equal(more.materializedPaths.length,FILES+1);
 assert.deepEqual(fs.readFileSync(path.join(root,'work-sparse','large.bin')),large);
 assert.deepEqual((await tasks.materializePaths({baseline,workRoot:path.join(root,'work-sparse'),manifest,paths:['large.bin']})).added,[],'materializing twice is idempotent');
 // Capacity policy: a volume without room for the bytes plus reserve refuses before any write.
 const tight=new TaskGit({rootPath:path.join(root,'collaboration'),gitOptions:{autoInstall:false},capacityProbe:()=>({bavail:1n,bsize:4096n})});
 await assert.rejects(tight.materializeSnapshot({revision:baseline,destinationRoot:path.join(root,'never')}),/DISK_QUOTA/);
 assert.equal(fs.existsSync(path.join(root,'never','snapshot')),false);
 assert.throws(()=>collaborationLimits({LILY_COLLAB_MAX_TOTAL_BYTES:'-1'}),/LIMIT_INVALID/);
 assert.equal(collaborationLimits({LILY_COLLAB_MAX_TOTAL_BYTES:String(8*1024*1024*1024)}).maxTotalBytes,8*1024*1024*1024,'operators raise capacity by policy');
 const capacity=assertCapacity({root,bytes:0});assert.ok(capacity.available>0);
 clearInterval(monitor);report.peakRssBytes=peak;report.startRssBytes=process.memoryUsage().rss;
 console.log(`scale: files=${FILES+1} bytes=${totalBytes} listing=${listing.length} peakRSS=${(peak/1048576).toFixed(1)}MiB`);
 if(process.env.LILY_SCALE_REPORT){fs.mkdirSync(path.dirname(process.env.LILY_SCALE_REPORT),{recursive:true});fs.writeFileSync(process.env.LILY_SCALE_REPORT,JSON.stringify({...report,recordedAt:new Date().toISOString()},null,2));}
 console.log('PASS task Git scale: streamed enumeration beyond the old buffer, single-process blob materialization, sparse inventory without placeholders or deletions, on-demand materialization, capacity policy');
}finally{clearInterval(monitor);fs.rmSync(root,{recursive:true,force:true});}
