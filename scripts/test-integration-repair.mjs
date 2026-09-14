import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {TaskGit}=require('../src/main/collaboration/task-git');
const {createSharedGit}=require('../src/main/collaboration/shared-git');
const {CollaborationStore}=require('../src/main/collaboration/collaboration-store');
const {LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring');
const {createIntegrationIntents}=require('../src/main/collaboration/integration-intents');
const {createIntegrationWorker}=require('../src/main/collaboration/integration-worker');
const {createTaskRecords}=require('../src/main/collaboration/task-records');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'integration-repair-'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const keyring=new LocalCollaborationKeyring({filePath:path.join(root,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
const store=new CollaborationStore({dbPath:path.join(root,'db'),accountId:'owner',keyring});
let worker;
try{
 store.replaceProjectionFromBootstrap({conversations:[{id:'chat',scopeId:'team:org',kind:'channel'}]});
 const snapshot=(name,files)=>{const dir=path.join(root,name);fs.mkdirSync(dir);return {snapshotRoot:dir,manifest:Object.entries(files).map(([file,text])=>{fs.writeFileSync(path.join(dir,file),text);return {path:file,sizeBytes:Buffer.byteLength(text),sha256:hash(text)};})};};
 const taskGit=new TaskGit({rootPath:path.join(root,'git'),gitOptions:{autoInstall:false}}),shared=createSharedGit(taskGit);
 const base=snapshot('source',{'budget.txt':'cap: 1.0M\nowner: finance\n','README.md':'notes\n'});
 const baseline=await taskGit.captureBaseline({taskId:'task',...base});
 const deliveries={};
 const deliver=async(name,files)=>{const changed=snapshot(name,files);deliveries[name]=await taskGit.captureContribution({baseline,baseManifest:base.manifest,materializedPaths:base.manifest.map(f=>f.path),deliveryId:name,...changed});return deliveries[name];};
 const intents=createIntegrationIntents({store,assertActive(){}}),records=createTaskRecords({store,assertActive(){}});
 const common={conversationId:'chat',taskId:'task',projectId:'project',targetId:hash('target'),sessionId:'session',chain:'shared',workspaceId:'workspace',baselineCommit:baseline.commit};
 let reply=null,answers=[],modelCalls=[],modelAvailable=true;
 const complete=async request=>{modelCalls.push(request);return typeof reply==='function'?reply(request):reply;};
 const workflow={authorizeIntegration:async()=>true,acquireIntegrationInput:async input=>({taskGit,baseline,delivery:deliveries[input.deliveryId]}),
  integrationRepair:async()=>({goal:{title:'Budget cap',objective:'Apply the approved cap',acceptanceCriteria:'The approved cap is 1.2M'},answers,complete:modelAvailable?complete:null})};
 const validate=async candidate=>({ok:true,state:'passed',commit:candidate.commit,policyId:'fixture-v1',evidenceHash:hash(candidate.commit)});
 worker=createIntegrationWorker({store,assertActive(){},getWorkflow:()=>workflow,validationPolicyId:'fixture-v1',validateIntegration:validate});
 const git=async args=>(await taskGit.ensure()).git(args);
 const head=async()=>(await shared.initialize({workspaceId:'workspace',baseline})).commit;
 const work=id=>({...store.db.get('SELECT state,code FROM task_integration_work WHERE intent_id=?',id)});
 const journal=id=>records.list('chat').find(r=>r.kind==='shared-publication'&&r.intentId===id);
 // 1. A clean delivery advances H so later deliveries from the same baseline conflict with it.
 await deliver('first',{'budget.txt':'cap: 1.2M\nowner: finance\n','README.md':'notes\n'});
 const first=intents.enqueue({...common,deliveryId:'first',deliveryCommit:deliveries.first.commit});await worker.recover();
 assert.equal(intents.get(first.id).state,'completed');assert.equal(await git(['show',`${await head()}:budget.txt`]),'cap: 1.2M\nowner: finance');
 assert.equal(modelCalls.length,0,'deterministic merges never consult the model');
 // 2. A conflicting delivery is repaired by the requester's model with the goal as evidence, then validated and published.
 await deliver('second',{'budget.txt':'cap: 1.5M\nowner: finance\n','README.md':'notes\n'});
 reply={ok:true,text:'{"files":{"budget.txt":"cap: 1.2M\\nowner: finance\\n"},"questions":[]}',model:'fixture-model',provider:'fixture-host'};
 const second=intents.enqueue({...common,deliveryId:'second',deliveryCommit:deliveries.second.commit});await worker.recover();
 assert.equal(intents.get(second.id).state,'completed','model-resolved candidate publishes through the same validation gate');
 assert.equal(modelCalls.length,1);assert.match(modelCalls[0].user,/The approved cap is 1.2M/);assert.match(modelCalls[0].user,/<merged>[\s\S]*<<<<<<< ours[\s\S]*>>>>>>> theirs/,'the model sees the diff3 view');
 assert.doesNotMatch(modelCalls[0].user,/README/,'unrelated files never enter the prompt');
 const repaired=journal(second.id);
 assert.equal(repaired.state,'published');assert.match(repaired.candidate.resolutionHash,/^[a-f0-9]{64}$/);
 assert.equal(repaired.candidate.repair.policy,'model-repair-v1');assert.equal(repaired.candidate.repair.model,'fixture-host/fixture-model');assert.deepEqual(repaired.candidate.repair.resolvedPaths,['budget.txt']);
 assert.match(repaired.candidate.repair.promptHash,/^[a-f0-9]{64}$/);assert.match(repaired.candidate.repair.responseHash,/^[a-f0-9]{64}$/);
 assert.equal(await git(['show',`${await head()}:budget.txt`]),'cap: 1.2M\nowner: finance');
 assert.equal(await git(['rev-list','--parents','-n','1',await head()]),`${await head()} ${repaired.candidate.head} ${deliveries.second.commit}`,'repaired candidate keeps both parents');
 // 3. A business decision the goal cannot settle becomes one question; the requester's answer re-admits the same intent.
 await deliver('third',{'budget.txt':'cap: 1.8M\nowner: finance\n','README.md':'notes\n'});
 reply={ok:true,text:'{"files":{},"questions":[{"path":"budget.txt","question":"Keep 1.2M or accept 1.8M?"}]}',model:'fixture-model',provider:'fixture-host'};
 const third=intents.enqueue({...common,deliveryId:'third',deliveryCommit:deliveries.third.commit});
 const outcome=await worker.runIntent({accountId:'owner',sessionId:'session',intentId:third.id},{assertActive(){}});
 assert.equal(outcome.state,'decision_required');assert.deepEqual(work(third.id),{state:'waiting',code:'COLLAB_INTEGRATION_DECISION_REQUIRED'});
 assert.equal(intents.get(third.id).state,'pending');assert.deepEqual(journal(third.id).candidate.repair.questions,[{path:'budget.txt',question:'Keep 1.2M or accept 1.8M?'}]);
 assert.equal(await git(['show',`${await head()}:budget.txt`]),'cap: 1.2M\nowner: finance','an open question never advances shared H');
 answers=[{path:'budget.txt',question:'Keep 1.2M or accept 1.8M?',answer:'Accept 1.8M, the board approved it'}];
 reply={ok:true,text:'{"files":{"budget.txt":"cap: 1.8M\\nowner: finance\\n"}}',model:'fixture-model',provider:'fixture-host'};
 store.db.run("UPDATE task_integration_work SET state='pending',code=NULL,attempts=0,next_attempt_at=0 WHERE intent_id=?",third.id);
 await worker.recover();
 assert.equal(intents.get(third.id).state,'completed');assert.match(modelCalls.at(-1).user,/Accept 1.8M, the board approved it/,'the answer is evidence in the next attempt');
 assert.equal(await git(['show',`${await head()}:budget.txt`]),'cap: 1.8M\nowner: finance');
 // 4. Markers, foreign paths or garbage from the model are refused: the conflict stays a conflict.
 await deliver('fourth',{'budget.txt':'cap: 2.0M\nowner: finance\n','README.md':'notes\n'});
 reply={ok:true,text:'{"files":{"budget.txt":"<<<<<<< ours\\ncap: 1.8M\\n=======\\ncap: 2.0M\\n>>>>>>> theirs\\n"}}',model:'fixture-model',provider:'fixture-host'};
 const fourth=intents.enqueue({...common,deliveryId:'fourth',deliveryCommit:deliveries.fourth.commit});
 assert.equal((await worker.runIntent({accountId:'owner',sessionId:'session',intentId:fourth.id},{assertActive(){}})).state,'conflict');
 assert.deepEqual(work(fourth.id),{state:'waiting',code:'COLLAB_INTEGRATION_CONFLICT'});assert.equal(journal(fourth.id).candidate.repair.error,'RESOLUTION_INVALID');
 assert.equal(await git(['show',`${await head()}:budget.txt`]),'cap: 1.8M\nowner: finance');
 // 5. Without a configured model the conflict is simply reported; nothing is called.
 modelAvailable=false;const calls=modelCalls.length;
 await deliver('fifth',{'budget.txt':'cap: 2.2M\nowner: finance\n','README.md':'notes\n'});
 const fifth=intents.enqueue({...common,deliveryId:'fifth',deliveryCommit:deliveries.fifth.commit});await worker.recover();
 assert.deepEqual(work(fifth.id),{state:'waiting',code:'COLLAB_INTEGRATION_CONFLICT'});assert.equal(modelCalls.length,calls);assert.equal(journal(fifth.id).candidate.repair,undefined);
 assert.doesNotMatch(JSON.stringify(store.db.all('SELECT payload_envelope_json FROM task_workspace_records')),/board approved|Keep 1.2M/,'questions and answers are encrypted at rest');
 console.log('PASS integration repair: deterministic merge without model, model resolution with goal and diff3 evidence published through validation, decision question and answered re-admission, invalid model output refused, unconfigured model reports conflict');
}finally{worker?.stop();store.close();fs.rmSync(root,{recursive:true,force:true});}
