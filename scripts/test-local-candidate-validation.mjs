import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createLocalCandidateValidation}=require('../src/main/collaboration/local-candidate-validation');
const {CollaborationStore}=require('../src/main/collaboration/collaboration-store');
const {LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring');
const {createTaskRecords}=require('../src/main/collaboration/task-records');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'local-validation-'));
const hash=v=>createHash('sha256').update(v).digest('hex');
const keyring=new LocalCollaborationKeyring({filePath:path.join(root,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
const store=new CollaborationStore({dbPath:path.join(root,'db'),accountId:'owner',keyring});
store.replaceProjectionFromBootstrap({conversations:[{id:'chat',kind:'direct'}]});
const records=createTaskRecords({store,assertActive(){}}),input={conversationId:'chat',workspaceId:'workspace',projectId:'project',targetId:'target'};
const test="require('node:test').test('preserve local invariant',()=>require('node:assert/strict').equal(require('./value.json').value,2));";
const policy={version:1,type:'node-test',binding:input,origin:{kind:'fixture'},files:[{path:'rule.test.cjs',sizeBytes:Buffer.byteLength(test),sha256:hash(test),base64:Buffer.from(test).toString('base64')}]};
const guardsOnly=process.argv.includes('--guards-only');
let currentPolicy={id:'validation-policy:'+hash(JSON.stringify(policy)),policy};
if(guardsOnly)currentPolicy=null;
const validator=createLocalCandidateValidation({store,rootPath:path.join(root,'private-git'),assertActive(){},getPolicy:()=>currentPolicy});
try{
 for(const [name,value]of [['valid',2],['invalid',0]]){
  const snapshotRoot=path.join(root,name);fs.mkdirSync(snapshotRoot);
  const files={'value.json':JSON.stringify({value}),'rule.test.cjs':"require('node:test').test('weakened',()=>{});"};
  const manifest=Object.entries(files).map(([p,bytes])=>{fs.writeFileSync(path.join(snapshotRoot,p),bytes);return{path:p,sha256:hash(bytes),sizeBytes:Buffer.byteLength(bytes)};});
  const job=records.put(name,{id:name,kind:'local-materialization',conversationId:'chat',intentId:name,token:name,fingerprint:hash(name),state:'ready',candidate:{snapshotRoot,manifest}});
  const result=await validator.validate({job,input});
  assert.equal(result.state,guardsOnly?'required':process.platform==='darwin'?(name==='valid'?'passed':'failed'):'required','pinned original test must govern private W prime, even when candidate weakens it');
  assert.equal(records.get(name).validation.evidenceId,result.id);
  assert.equal(result.report.fingerprint,job.fingerprint);
  assert.doesNotMatch(JSON.stringify(store.db.all('SELECT payload_envelope_json FROM task_workspace_records')),/private-git|preserve local invariant/);
 }
 currentPolicy=null;
 const missing=await validator.validate({job:records.get('valid'),input});assert.equal(missing.state,'required','syntax alone cannot approve local writes');
 const stale=records.get('valid');records.put(stale.id,{...stale,token:'successor'});
 await assert.rejects(validator.validate({job:stale,input}),/FENCED/);
 records.put(stale.id,{...stale,state:'applied'});
 await assert.rejects(validator.validate({job:stale,input}),/FENCED/,'late validation cannot attach evidence after a candidate leaves the ready state');
 console.log(guardsOnly?'local validation guards: private Git, missing-policy refusal, encrypted receipts and stale-candidate fencing passed; pinned execution NOT RUN':'local validation: private Git, pinned checks, failed/required evidence, encrypted receipts and stale-candidate fencing passed');
}finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
