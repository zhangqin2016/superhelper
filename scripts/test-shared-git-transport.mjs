import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{TaskGit}=require('../src/main/collaboration/task-git'),{createSharedGit}=require('../src/main/collaboration/shared-git');
const {createSharedGitTransport,createTaskGitTransport}=require('../src/main/collaboration/task-git-transport');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'shared-pack-'));
const snapshot=(name,files)=>{const snapshotRoot=path.join(root,name);fs.mkdirSync(snapshotRoot);return {snapshotRoot,manifest:Object.entries(files).map(([name,text])=>{fs.writeFileSync(path.join(snapshotRoot,name),text);return {path:name,sizeBytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')};})};};
try{
 const source=new TaskGit({rootPath:path.join(root,'source'),gitOptions:{autoInstall:false}}),target=new TaskGit({rootPath:path.join(root,'target'),gitOptions:{autoInstall:false}});
 const shared=createSharedGit(source),send=createSharedGitTransport(source),receive=createSharedGitTransport(target);
 const base=snapshot('base',{'a.txt':'a','b.txt':'b','large.bin':'x'.repeat(1024*1024)}),baseline=await source.captureBaseline({taskId:'task',...base});
 const head=await shared.initialize({workspaceId:'workspace',baseline});let current=head;
 for(const [index,files] of [[1,{'a.txt':'changed','b.txt':'b'}],[2,{'a.txt':'a','b.txt':'changed'}]]){
  const changed=snapshot('change'+index,files),delivery=await source.captureContribution({baseline,baseManifest:base.manifest,
   materializedPaths:['a.txt','b.txt'],deliveryId:'delivery'+index,...changed});
  const candidate=await shared.prepare({workspaceId:'workspace',baseline,delivery,expectedHead:current.commit});
  const exported=await send.exportBundle({revision:candidate,prerequisites:index===1?[]:[current.commit],destination:path.join(root,`pack${index}`)});
  if(index===2){assert.ok(exported.descriptor.prerequisites.includes(current.commit));assert.ok(exported.descriptor.sizeBytes<4096,'later publication reuses the complete prior shared history');}
  if(index===1)await assert.rejects(createTaskGitTransport(source).exportBundle({revision:candidate,destination:path.join(root,'wrong-kind')}));
  const imported=await receive.importBundle({packagePath:exported.packagePath,descriptor:exported.descriptor});assert.equal(imported.commit,candidate.commit);
  const {git}=await target.ensure();assert.equal(await git(['rev-parse',`${imported.commit}^{tree}`]),candidate.tree);
  assert.equal(await git(['rev-list','--parents','-n','1',imported.commit]),`${imported.commit} ${candidate.head} ${candidate.delivery}`);
  current=await shared.publish({candidate,validate:async c=>({ok:true,commit:c.commit})});
 }
 assert.equal(fs.readFileSync(path.join(base.snapshotRoot,'a.txt'),'utf8'),'a');
 console.log('shared Git transport: complete first pack, incremental second pack, exact ancestry/tree import and task-ref separation passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}
