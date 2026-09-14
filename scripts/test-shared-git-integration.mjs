import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {TaskGit}=require('../src/main/collaboration/task-git');
const {createSharedGit}=require('../src/main/collaboration/shared-git');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'shared-git-'));
const write=(directory,name,text)=>{fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,name),text);return {path:name,sha256:createHash('sha256').update(text).digest('hex'),sizeBytes:Buffer.byteLength(text)};};
try{
 const taskGit=new TaskGit({rootPath:path.join(root,'git'),gitOptions:{autoInstall:false}}),shared=createSharedGit(taskGit);
 const source=path.join(root,'source'),base=[write(source,'work.txt','first\nsecond\nthird\n'),write(source,'.gitattributes','*.txt merge=union\n')];
 const baseline=await taskGit.captureBaseline({taskId:'task',snapshotRoot:source,manifest:base});
 const initial=await shared.initialize({workspaceId:'workspace',baseline});assert.equal(initial.commit,baseline.commit);
 async function delivery(id,text){const directory=path.join(root,id),modified=write(directory,'work.txt',text);return taskGit.captureContribution({baseline,baseManifest:base,materializedPaths:base.map(f=>f.path),deliveryId:id,snapshotRoot:directory,manifest:[modified,base[1]]});}
 const first=await delivery('one','FIRST\nsecond\nthird\n'),second=await delivery('two','first\nsecond\nTHIRD\n');
 const candidate=await shared.prepare({workspaceId:'workspace',baseline,delivery:first,expectedHead:initial.commit});assert.equal(candidate.state,'ready');
 const {git}=await taskGit.ensure();assert.equal(await git(['rev-parse',initial.ref]),initial.commit,'preparation never changes published H');
 await assert.rejects(shared.publish({candidate,validate:async()=>({ok:false})}),/VALIDATION_FAILED/);
 await assert.rejects(shared.publish({candidate,validate:async()=>({ok:true,commit:initial.commit})}),/VALIDATION_FAILED/,'validation of a different commit never authorizes this candidate');
 const published=await shared.publish({candidate,validate:async value=>({ok:true,commit:value.commit})});
 assert.equal(await git(['rev-parse',initial.ref]),published.commit);
 const merged=await shared.prepare({workspaceId:'workspace',baseline,delivery:second,expectedHead:published.commit});assert.equal(merged.state,'ready');
 assert.equal(await git(['show',`${merged.commit}:work.txt`]),'FIRST\nsecond\nTHIRD','three-way merge retains both independent contributions');
 const snapshot=await taskGit.materializeSnapshot({revision:merged,parents:[published.commit,second.commit],destinationRoot:path.join(root,'candidate')});assert.equal(fs.readFileSync(path.join(snapshot.snapshotRoot,'work.txt'),'utf8'),'FIRST\nsecond\nTHIRD\n');
 const conflict=await delivery('conflict','DIFFERENT\nsecond\nthird\n');
 const unresolved=await shared.prepare({workspaceId:'workspace',baseline,delivery:conflict,expectedHead:published.commit});
 assert.equal(unresolved.state,'conflicts');assert.deepEqual(unresolved.paths,['work.txt'],'contributed union driver cannot silently suppress semantic conflicts');
 assert.equal(await git(['rev-parse',initial.ref]),published.commit);
 const rival=await shared.prepare({workspaceId:'workspace',baseline,delivery:second,expectedHead:published.commit});assert.equal(rival.commit,merged.commit,'candidate retries are immutable');
 const otherRoot=path.join(root,'other'),added=write(otherRoot,'added.txt','other delivery');
 const other=await taskGit.captureContribution({baseline,baseManifest:base,materializedPaths:base.map(f=>f.path),deliveryId:'other',snapshotRoot:otherRoot,manifest:[...base,added]});
 const competing=await shared.prepare({workspaceId:'workspace',baseline,delivery:other,expectedHead:published.commit});
 assert.equal(competing.state,'ready');
 await shared.publish({candidate:merged,validate:async value=>({ok:true,commit:value.commit})});
 await assert.rejects(shared.publish({candidate:competing,validate:async value=>({ok:true,commit:value.commit})}),/HEAD_CHANGED/,'target advancement invalidates the old candidate');
 assert.equal((await shared.publish({candidate:merged,validate:async value=>({ok:true,commit:value.commit})})).commit,merged.commit,'lost publish ACK resolves from actual Git ref');
 await assert.rejects(shared.prepare({workspaceId:'workspace',baseline,delivery:first,expectedHead:initial.commit}),/HEAD_CHANGED/);
 assert.equal(fs.readFileSync(path.join(source,'work.txt'),'utf8'),'first\nsecond\nthird\n','shared publication never mutates private W');
 const binaryRoot=path.join(root,'binary'),binaryBase=[write(binaryRoot,'book.xlsx',Buffer.from([0,1,2]))];
 const binaryBaseline=await taskGit.captureBaseline({taskId:'binary',snapshotRoot:binaryRoot,manifest:binaryBase});
 const binaryHead=await shared.initialize({workspaceId:'binary-workspace',baseline:binaryBaseline});
 const binaryDeliveries=[];
 for(const value of [3,4]){
   const directory=path.join(root,`binary-${value}`),manifest=[write(directory,'book.xlsx',Buffer.from([0,1,value]))];
   binaryDeliveries.push(await taskGit.captureContribution({baseline:binaryBaseline,baseManifest:binaryBase,materializedPaths:['book.xlsx'],deliveryId:`binary-${value}`,snapshotRoot:directory,manifest}));
 }
 const binaryFirst=await shared.prepare({workspaceId:'binary-workspace',baseline:binaryBaseline,delivery:binaryDeliveries[0],expectedHead:binaryHead.commit});
 const binaryPublished=await shared.publish({candidate:binaryFirst,validate:async value=>({ok:true,commit:value.commit})});
 const binaryConflict=await shared.prepare({workspaceId:'binary-workspace',baseline:binaryBaseline,delivery:binaryDeliveries[1],expectedHead:binaryPublished.commit});
 assert.equal(binaryConflict.state,'conflicts');assert.deepEqual(binaryConflict.paths,['book.xlsx'],'binary conflicts await typed/semantic resolution and never silently choose a side');
 console.log('shared Git: immutable candidates, explicit-base three-way merge, attribute isolation, conflict refusal, validation gate, CAS target advancement and publish replay passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}
