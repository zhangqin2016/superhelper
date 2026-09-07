import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {CollaborationStore}=require('../src/main/collaboration/collaboration-store');
const {LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring');
const {createTaskRecords}=require('../src/main/collaboration/task-records');
const {createTaskRecovery}=require('../src/main/collaboration/task-recovery');
const {createTaskApplication}=require('../src/main/collaboration/task-application');
const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'lily-local-recovery-')));
const keyring=new LocalCollaborationKeyring({filePath:path.join(dir,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()}});
const options={dbPath:path.join(dir,'store.db'),accountId:'owner',keyring};
let store, recovery, stopped=false;
const active=()=>{if(stopped)throw Object.assign(new Error('Stopped'),{code:'COLLABORATION_STOPPED'});};
function open(){store=new CollaborationStore(options);recovery=createTaskRecovery({store,assertActive:active});}
const value={id:'application',conversationId:'team-chat',taskId:'task',deliveryId:'delivery',state:'applying',planHash:'a'.repeat(64),
  input:{applicationId:'application',rootPath:'/private/owned-original',deliveryRoot:'/private/delivery',baseManifest:[],deliveryManifest:[],editablePaths:[]},
  journal:{state:'applying',backupDirectory:'/private/owned-backups',operations:[]},title:'Remote confidential title',kind:'application'};
open();
try {
  store.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES ('owner','team-chat','team:alpha','group',0)");
  createTaskRecords({store,assertActive:active}).put('ordinary',{conversationId:'team-chat',title:'Remote task title'});
  const saved=recovery.put(value.id,value);
  assert.equal(saved.title,undefined);assert.equal(saved.kind,'application');
  assert.deepEqual(recovery.get(value.id),saved);
  assert.deepEqual(recovery.list(),[saved]);
  const row=store.db.get('SELECT * FROM task_local_recovery');
  assert.doesNotMatch(JSON.stringify(row),/owned-original|owned-backups|Remote confidential|team-chat/);
  assert.deepEqual(Object.keys(row).sort(),['account_id','id','payload_envelope_json','updated_at']);
  store.close();open();
  assert.equal(recovery.get('application').input.rootPath,'/private/owned-original');
  store.revokeScope({scopeId:'team:alpha'});
  assert.equal(store.db.get('SELECT COUNT(*) AS n FROM task_workspace_records').n,0,'ordinary remote task records are retired');
  assert.equal(store.getConversation({conversationId:'team-chat'}),null);
  assert.equal(recovery.get('application').journal.backupDirectory,'/private/owned-backups','local original-file recovery survives remote scope revocation');
  recovery.put('application',{...saved,state:'rolled_back',journal:{...saved.journal,state:'rolled_back'}});
  assert.equal(recovery.get('application').state,'rolled_back','same-account offline journal progress needs no conversation or server');
  assert.throws(()=>recovery.put('application',{...saved,taskId:'another'}),/BINDING/);
  assert.throws(()=>recovery.put('application',{...saved,input:{...saved.input,rootPath:'/another'}}),/BINDING/);
  const other=new CollaborationStore({...options,accountId:'different'});
  try {const isolated=createTaskRecovery({store:other,assertActive(){}});assert.equal(isolated.get('application'),null);assert.deepEqual(isolated.list(),[]);}finally{other.close();}
  store.accountId='different';
  for(const operation of [()=>recovery.get('application'),()=>recovery.list(),()=>recovery.put('application',saved)])assert.throws(operation,error=>error.code==='COLLAB_ACCOUNT_CHANGED');
  store.accountId='owner';stopped=true;
  for(const operation of [()=>recovery.get('application'),()=>recovery.list(),()=>recovery.put('application',saved)])assert.throws(operation,error=>error.code==='COLLABORATION_STOPPED');
  stopped=false;store.close();open();
  assert.equal(recovery.get('application').state,'rolled_back','personal recovery key survives team-key deletion and restart');
  const origin=path.join(dir,'origin'),delivery=path.join(dir,'delivery'),backup=path.join(dir,'backup');
  for(const folder of [origin,delivery,backup])fs.mkdirSync(folder);
  fs.writeFileSync(path.join(origin,'owned.txt'),'old');fs.writeFileSync(path.join(delivery,'owned.txt'),'new');
  const manifest=bytes=>[{path:'owned.txt',sizeBytes:3,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}];
  const input={applicationId:'real-apply',rootPath:origin,deliveryRoot:delivery,baseManifest:manifest('old'),deliveryManifest:manifest('new'),editablePaths:['owned.txt']};
  let interrupted=true;
  let realRecord={id:'real-apply',kind:'application',conversationId:'team-chat',taskId:'task',deliveryId:'delivery',input,state:'preview',createdAt:Date.now()};
  function broker(){return createTaskApplication({journalRoot:backup,assertAuthorized:active,journal:{get:()=>recovery.get('real-apply')?.journal,put:(_id,journal)=>{
    if(interrupted && journal.operations.some(operation=>operation.state==='done'))throw new Error('simulated process interruption');
    recovery.put('real-apply',{...realRecord,journal,state:journal.state});
  }}});}
  const preview=await broker().preview(input);realRecord={...realRecord,planHash:preview.planHash};
  await assert.rejects(broker().apply({...input,expectedPlanHash:preview.planHash}),/interruption/);
  assert.equal(fs.readFileSync(path.join(origin,'owned.txt'),'utf8'),'new');
  store.close();open();interrupted=false;
  realRecord=recovery.get('real-apply');
  assert.equal((await broker().recover({applicationId:'real-apply',mode:'rollback'})).state,'rolled_back');
  assert.equal(fs.readFileSync(path.join(origin,'owned.txt'),'utf8'),'old','actual partial application rolls back offline after encrypted SQLite restart');
  console.log('remote task local recovery: personal encryption, SQLite restart, team revocation, minimal projection and account fences passed');
} finally {store.close();fs.rmSync(dir,{recursive:true,force:true});}
