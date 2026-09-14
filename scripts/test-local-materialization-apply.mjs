import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createLocalMaterializationApplication}=require('../src/main/collaboration/local-materialization-application');
const {createLocalWriter}=require('../src/main/collaboration/local-writer');
const {createTaskApplication}=require('../src/main/collaboration/task-application');
const {CollaborationStore}=require('../src/main/collaboration/collaboration-store');
const {LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring');
const {createTaskRecords}=require('../src/main/collaboration/task-records');
const {createTaskRecovery}=require('../src/main/collaboration/task-recovery');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'local-apply-'));
const hash=v=>createHash('sha256').update(v).digest('hex');
const keyring=new LocalCollaborationKeyring({filePath:path.join(root,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
const store=new CollaborationStore({dbPath:path.join(root,'db'),accountId:'owner',keyring});
store.replaceProjectionFromBootstrap({conversations:[{id:'chat',kind:'direct'}]});
const records=createTaskRecords({store,assertActive(){}}),recoveries=createTaskRecovery({store,assertActive(){}});
const writer=createLocalWriter({filePath:path.join(root,'writer.sqlite')});
let active=true,policy='policy',fault=false;
const input={conversationId:'chat',taskId:'task',deliveryId:'delivery',workspaceId:'workspace',targetId:'target',projectId:'project',sessionId:'session'};
function fixture(name){
 const localRoot=path.join(root,name+'-w'),snapshotRoot=path.join(root,name+'-candidate');fs.mkdirSync(localRoot);fs.mkdirSync(snapshotRoot);
 const manifest=(dir,text)=>{fs.writeFileSync(path.join(dir,'work.txt'),text);return [{path:'work.txt',sha256:hash(text),sizeBytes:Buffer.byteLength(text)}];};
 const currentManifest=manifest(localRoot,'private\n'),manifestAfter=manifest(snapshotRoot,'private\nshared\n');
 const binding={accountId:'owner',deviceId:'device',...Object.fromEntries(['workspaceId','targetId','projectId','sessionId'].map(k=>[k,input[k]])),localRoot,rootIdentity:`${fs.statSync(localRoot).dev}:${fs.statSync(localRoot).ino}`};
 const base=records.put(name+'-base',{conversationId:'chat',binding,generation:0,remoteRevision:0,revision:{ref:'base',commit:'a'.repeat(40)}});
 const report={state:'passed',candidateUnchanged:true,token:name,fingerprint:name,checkPolicyId:'policy',privateCommit:'c'.repeat(40)};
 const evidenceHash=hash(JSON.stringify(report)),evidence=records.put(name+'-validation',{conversationId:'chat',state:'passed',evidenceHash,report});
 return records.put(name,{conversationId:'chat',taskId:'task',deliveryId:'delivery',intentId:name,state:'ready',token:name,fingerprint:name,binding,baseId:base.id,baseGeneration:0,baseRemoteRevision:0,baseRevision:base.revision,
  sharedRevision:{ref:'shared',commit:'b'.repeat(40),remoteRevision:1},candidate:{snapshotRoot,manifest:manifestAfter,currentManifest,paths:['work.txt'],conflicts:[]},
  validation:{state:'passed',evidenceId:evidence.id,evidenceHash,privateCommit:report.privateCommit,checkPolicyId:'policy'}});
}
const application=createLocalMaterializationApplication({store,writer,journalRoot:path.join(root,'recovery'),assertActive(){assert.ok(active);},authorize:async()=>true,getPolicy:()=>({id:policy}),
 beforeReceipt(){if(fault)throw Error('receipt fault');}});
try{
 const job=fixture('success');
 await application.apply({job,input});
 assert.equal(fs.readFileSync(path.join(job.binding.localRoot,'work.txt'),'utf8'),'private\nshared\n');
 const applied=records.get(job.id),base=records.get(job.baseId);
 assert.equal(applied.state,'applied');assert.equal(base.revision.commit,job.sharedRevision.commit,'A records shared M, never the private validation commit');
 assert.equal(base.generation,1);assert.equal(base.remoteRevision,1);
 await application.apply({job:applied,input});assert.equal(records.get(job.baseId).generation,1,'replay must not advance A twice');
 const stale=fixture('stale');fs.writeFileSync(path.join(stale.binding.localRoot,'work.txt'),'later user edit');
 await assert.rejects(application.apply({job:stale,input}),/STALE|PREVIEW|CONFLICT/);
 assert.equal(records.get(stale.baseId).generation,0);
 const invalid=fixture('policy');policy='changed';await assert.rejects(application.apply({job:invalid,input}),/VALIDATION/);policy='policy';
 const moved=fixture('base');records.put(moved.baseId,{...records.get(moved.baseId),generation:1});
 await assert.rejects(application.apply({job:moved,input}),/BASE_CHANGED/);
 const unverified=fixture('unverified');records.put(unverified.id,{...unverified,validation:null});
 await assert.rejects(application.apply({job:unverified,input}),/VALIDATION/);
 const busy=fixture('busy');
 await writer.runAsync(async()=>{await assert.rejects(application.apply({job:busy,input}),/BUSY/);});
 assert.equal(fs.readFileSync(path.join(busy.binding.localRoot,'work.txt'),'utf8'),'private\n');
 const broken=fixture('crash');fault=true;await assert.rejects(application.apply({job:broken,input}),/receipt fault/);fault=false;
 assert.equal(records.get(broken.baseId).generation,0,'a failed receipt transaction must not advance A');
 assert.notEqual(records.get(broken.id).state,'applied');
 assert.equal(recoveries.get(records.get(broken.id).applicationId).journal.state,'applying','last durable write journal remains recoverable');
 const recoveryId=records.get(broken.id).applicationId;
 const recovery=createTaskApplication({writer,journalRoot:path.join(root,'recovery'),assertAuthorized:async()=>true,
  journal:{get:id=>recoveries.get(id).journal,put:(id,journal)=>recoveries.put(id,{...recoveries.get(id),journal,state:journal.state})}});
 await recovery.recover({applicationId:recoveryId,mode:'rollback'});
 assert.equal(fs.readFileSync(path.join(broken.binding.localRoot,'work.txt'),'utf8'),'private\n');
 assert.equal(records.get(broken.baseId).generation,0);
 console.log('PASS local materialization apply: real writes, private preservation, receipt/A transaction, idempotency, stale W/policy and receipt fault');
}finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
