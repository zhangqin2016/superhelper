import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {TaskGit}=require('../src/main/collaboration/task-git');
const {createSharedGit}=require('../src/main/collaboration/shared-git');
const {CollaborationStore}=require('../src/main/collaboration/collaboration-store');
const {LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring');
const {createIntegrationCheckPolicy}=require('../src/main/collaboration/integration-check-policy');
const {createIntegrationIntents}=require('../src/main/collaboration/integration-intents');
const {createIntegrationWorker}=require('../src/main/collaboration/integration-worker');
const {createTaskRecords}=require('../src/main/collaboration/task-records');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'node-policy-'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const executable=process.platform==='darwin';
const keyring=new LocalCollaborationKeyring({filePath:path.join(root,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
let store,worker,pending;
const snapshot=(name,files)=>{const dir=path.join(root,name);fs.mkdirSync(dir);return {snapshotRoot:dir,manifest:Object.entries(files).map(([file,text])=>{
 fs.writeFileSync(path.join(dir,file),text);return {path:file,sizeBytes:Buffer.byteLength(text),sha256:hash(text)};
})};};
try{
 store=new CollaborationStore({dbPath:path.join(root,'db'),accountId:'owner',keyring});
 store.replaceProjectionFromBootstrap({conversations:[{id:'chat',scopeId:'team:org',kind:'channel'}]});
 const checks="require('node:test').test('original invariant',()=>require('node:assert/strict').equal(require('./value.json').value,2));";
 const base=snapshot('source',{'value.json':'{"value":2}','rule.test.cjs':checks});
 const taskGit=new TaskGit({rootPath:path.join(root,'git'),gitOptions:{autoInstall:false}}),shared=createSharedGit(taskGit);
 const baseline=await taskGit.captureBaseline({taskId:'task',...base});
 const common={conversationId:'chat',taskId:'task',projectId:'project',targetId:hash('target'),sessionId:'session',chain:'shared',baselineCommit:baseline.commit};
 const identity=hash('original root'),policies=createIntegrationCheckPolicy({store,assertActive(){}});
 const intents=createIntegrationIntents({store,assertActive(){}}),records=createTaskRecords({store,assertActive(){}});
 const cases=[['removed',{'value.json':'{"value":0}'},'failed'],
  ['weakened',{'value.json':'{"value":0}','rule.test.cjs':"require('node:test').test('weakened',()=>{});"},'failed'],
  ['valid',{'value.json':'{"value":2}','rule.test.cjs':"require('node:test').test('weakened',()=>{});"},'passed']];
 for(const [name,files,nativeExpected] of cases){
  const expected=executable?nativeExpected:'required';
  const changed=snapshot(name,files),delivery=await taskGit.captureContribution({baseline,baseManifest:base.manifest,
   materializedPaths:base.manifest.map(f=>f.path),deliveryId:name,...changed});
  const input={...common,workspaceId:name,deliveryId:name,deliveryCommit:delivery.commit};
  const policy=await policies.install({input,sourceIdentity:identity,taskGit,baseline,paths:['rule.test.cjs'],expectedPolicyId:null,authorize:async()=>true});
  const intent=intents.enqueue(input);
  store.db.run("UPDATE task_integration_work SET state='waiting',code='COLLAB_INTEGRATION_VALIDATION_REQUIRED' WHERE intent_id=?",intent.id);
  worker=createIntegrationWorker({store,assertActive(){},getWorkflow:()=>({authorizeIntegration:async()=>true,
   acquireIntegrationInput:async()=>({taskGit,baseline,delivery}),getIntegrationCheckPolicy:async()=>policies.current(input,identity)})});
  await worker.recoverCheckPolicies();
  assert.equal(store.db.get('SELECT state FROM task_integration_work WHERE intent_id=?',intent.id).state,'pending','startup upgrades saved policies without executing them');
  await worker.runIntent({accountId:'owner',sessionId:'session',intentId:intent.id},{assertActive(){}});
  const evidence=records.list('chat').find(r=>r.kind==='candidate-validation'&&r.intentId===intent.id);
  assert.equal(evidence.report.state,expected,`${name} must execute the pinned original invariant`);
  const execution=evidence.report.checks.find(c=>c.id==='project-policy').execution;
  assert.equal(execution.checkPolicyId,policy.id);assert.equal(execution.originalChecks[0].sha256,hash(checks));
  if(executable)assert.equal(execution.execution.summary.counts.tests,1);
  else assert.equal(execution.execution.code,'SANDBOX_UNAVAILABLE');
  assert.equal(execution.executionCopyUnchanged,true);
  assert.equal(execution.execution.state,expected);assert.equal(hash(JSON.stringify(evidence.report)),evidence.evidenceHash);
  const head=await shared.initialize({workspaceId:name,baseline});
  assert.equal(intents.get(intent.id).state,expected==='passed'?'completed':'pending');
  if(expected!=='passed')assert.equal(head.commit,baseline.commit,'failed or unavailable original invariant cannot advance shared H');
  else assert.equal(head.commit,evidence.report.commit,'successful checks publish the exact candidate');
  worker.stop();
 }
 if(executable){
 const waitingCheck="require('node:test').test('waiting check',async()=>{require('node:fs').writeFileSync(require('node:path').join(process.env.TMPDIR,'started'),'started');await new Promise(()=>setInterval(()=>{},1000));});";
 const waitingBase=snapshot('waiting-source',{'rule.test.cjs':waitingCheck,'replacement.test.cjs':"require('node:test').test('replacement',()=>{});"});
 const waitingBaseline=await taskGit.captureBaseline({taskId:'waiting-task',...waitingBase});
 const waitingDelivery=await taskGit.captureContribution({baseline:waitingBaseline,baseManifest:waitingBase.manifest,
  materializedPaths:waitingBase.manifest.map(f=>f.path),deliveryId:'waiting-delivery',...waitingBase});
 const waitingInput={...common,workspaceId:'waiting',taskId:'waiting-task',deliveryId:'waiting-delivery',baselineCommit:waitingBaseline.commit,deliveryCommit:waitingDelivery.commit};
 const waitingPolicy=await policies.install({input:waitingInput,sourceIdentity:identity,taskGit,baseline:waitingBaseline,paths:['rule.test.cjs'],expectedPolicyId:null,authorize:async()=>true});
 const waitingIntent=intents.enqueue(waitingInput);
 worker=createIntegrationWorker({store,assertActive(){},getWorkflow:()=>({authorizeIntegration:async()=>true,
  acquireIntegrationInput:async()=>({taskGit,baseline:waitingBaseline,delivery:waitingDelivery}),getIntegrationCheckPolicy:async()=>policies.current(waitingInput,identity),
  assertIntegrationCheckPolicy(_input,expected){if(policies.current(waitingInput,identity).id!==expected)throw Object.assign(Error('policy changed'),{code:'COLLAB_CHECK_POLICY_CHANGED'});}})});
 pending=worker.runIntent({accountId:'owner',sessionId:'session',intentId:waitingIntent.id},{assertActive(){}});
 const started=()=>fs.readdirSync(root).filter(name=>name.startsWith('node-validation-')).some(name=>fs.existsSync(path.join(root,name,'scratch','started')));
 const deadline=Date.now()+5000;while(!started()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(started(),true,'the actual pinned test process reached its waiting assertion');
 await policies.install({input:waitingInput,sourceIdentity:identity,taskGit,baseline:waitingBaseline,paths:['replacement.test.cjs'],expectedPolicyId:waitingPolicy.id,authorize:async()=>true});
 await pending;pending=null;
 assert.equal(store.db.get('SELECT code FROM task_integration_work WHERE intent_id=?',waitingIntent.id).code,'COLLAB_CHECK_POLICY_CHANGED');
 assert.equal((await shared.initialize({workspaceId:'waiting',baseline:waitingBaseline})).commit,waitingBaseline.commit,'changing the persisted policy kills the active check without publication');
 worker.stop();
 }
 assert.equal(fs.readFileSync(path.join(base.snapshotRoot,'rule.test.cjs'),'utf8'),checks,'private source remains untouched');
 assert.doesNotMatch(JSON.stringify(store.db.all('SELECT payload_envelope_json FROM task_workspace_records')),/original invariant|rule.test.cjs|AssertionError/);
 const proofs=records.list('chat').filter(r=>r.kind==='candidate-validation').map(r=>[r.id,r.evidenceHash]);
 store.close();store=new CollaborationStore({dbPath:path.join(root,'db'),accountId:'owner',keyring});
 const reopened=createTaskRecords({store,assertActive(){}});for(const [id,evidenceHash] of proofs)assert.equal(reopened.get(id).evidenceHash,evidenceHash);
 assert.equal(fs.readdirSync(root).some(name=>name.startsWith('node-validation-')),false,'execution copies are removed');
 console.log(executable?'pinned Node policy: actual worker, deleted/weakened test refusal, exact candidate publication, active policy-change cancellation, private isolation, encrypted evidence and reopen passed (remote authorization is a fixture)':
  'pinned Node policy: actual worker refuses unsupported execution without publication; macOS execution/cancellation assertions not run');
}finally{worker?.stop();await pending?.catch(()=>{});store?.close();fs.rmSync(root,{recursive:true,force:true});}
