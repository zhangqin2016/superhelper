import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const { MessageStore }=require('../src/main/store/message-store');
const { fenceRestoredTasks }=require('../src/main/store/restored-task-fence');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'restored-task-fence-'));
let store;
try {
  store=new MessageStore(path.join(temp,'messages.db'),path.join(temp,'blobs'));
  for(const [seq,status] of [[1,'admitted'],[2,'accepted'],[3,'terminal']])store.db.run("INSERT INTO turn_inputs(session_id,admitted_seq,turn_id,status,created_at,migration_status) VALUES('session',?,?,?,1,'owned')",seq,'turn'+seq,status);
  store.db.run("INSERT INTO parent_closure_recoveries(session_id,owner_scope,source_turn_id,recovery_key,recovery_turn_id,status,source_json,updated_at) VALUES('session','owner','turn1','key','recovery','prepared','{}',1)");
  assert.equal(fenceRestoredTasks(store,{id:'receipt'}),true,'first restored boot suppresses automatic recovery');
  assert.deepEqual(store.db.all('SELECT status FROM turn_inputs ORDER BY admitted_seq').map(r=>r.status),['outcome_unknown','outcome_unknown','terminal']);
  assert.equal(store.db.get('SELECT status FROM parent_closure_recoveries').status,'unavailable');
  store.db.run("INSERT INTO turn_inputs(session_id,admitted_seq,turn_id,status,created_at) VALUES('session',4,'new','admitted',2)");
  assert.equal(fenceRestoredTasks(store,{id:'receipt'}),false,'retained receipt must not suppress new work');
  assert.equal(store.db.get("SELECT status FROM turn_inputs WHERE turn_id='new'").status,'admitted','receipt retry preserves new user work');
  store.close();store=null;
  store=new MessageStore(path.join(temp,'messages.db'),path.join(temp,'blobs'));
  assert.equal(fenceRestoredTasks(store,{id:'receipt'}),false,'ack failure and restart preserve normal new-work recovery');
  assert.equal(store.db.get("SELECT status FROM turn_inputs WHERE turn_id='new'").status,'admitted','restart fence is durable and idempotent');
  console.log('PASS restored queued work stays outcome-unknown across restarts; new tasks preserved');
} finally {store?.close();fs.rmSync(temp,{recursive:true,force:true});}
