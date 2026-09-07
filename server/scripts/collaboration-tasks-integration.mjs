import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { createKyselyConversationRepository } from '../src/services/collaboration/conversation-repository.js';
import { createCollaborationTaskService } from '../src/services/collaboration/tasks.js';
import { createCollaborationMessageCrypto } from '../src/services/collaboration/message-crypto.js';
import { createTaskPackageBroker } from '../src/services/collaboration/task-packages.js';
import { createKyselyObjectRepository } from '../src/services/collaboration/object-repository.js';
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL required for isolated PostgreSQL test');
const schema=`task_test_${randomUUID().replaceAll('-','')}`;
const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
const uri=new URL(process.env.DATABASE_URL);uri.searchParams.set('options',`-c search_path=${schema}`);
const pool=new pg.Pool({connectionString:uri.href});
const database=new Kysely({dialect:new PostgresDialect({pool})});
try{
  await admin.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE TABLE users(id text primary key); CREATE TABLE devices(id text primary key);
    CREATE TABLE user_devices(user_id text references users(id),device_id text references devices(id),status text default 'active',primary key(user_id,device_id));
    CREATE TABLE organizations(id text primary key,name text,status text);
    CREATE TABLE organization_members(organization_id text,user_id text,role text,status text,primary key(organization_id,user_id));`);
  for(const name of ['033_collaboration_core.sql','035_collaboration_bootstrap_completion.sql','037_collaboration_relationship_events.sql','038_collaboration_conversations.sql','039_collaboration_objects.sql','045_collaboration_tasks.sql'])await pool.query(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  for(const id of ['owner','helper','observer']){
    await pool.query('INSERT INTO users VALUES($1)',[id]);await pool.query('INSERT INTO devices VALUES($1)',[`d_${id}`]);
    await pool.query('INSERT INTO user_devices(user_id,device_id) VALUES($1,$2)',[id,`d_${id}`]);
  }
  await pool.query("INSERT INTO conversations(id,scope_type,kind,created_by) VALUES('chat','personal','group','owner')");
  await pool.query("INSERT INTO conversation_members(conversation_id,user_id,role,status,joined_seq) VALUES('chat','owner','owner','active',0),('chat','helper','member','active',0),('chat','observer','member','active',0)");
  const packages=createTaskPackageBroker();
  await pool.query("INSERT INTO stored_objects(id,owner_user_id,conversation_id,scope_type,purpose,object_key,state,ciphertext_size,ciphertext_sha256,mime_type,original_name) VALUES('snapshot','owner','chat','personal','workspace','test/snapshot','verified',10,$1,'application/zip','input.zip')",['a'.repeat(64)]);
  const service=createCollaborationTaskService({repository:createKyselyConversationRepository(database),crypto:createCollaborationMessageCrypto({currentKekVersion:1,kekByVersion:{1:randomBytes(32)}}),packages});
  const owner={userId:'owner',deviceId:'d_owner'},helper={userId:'helper',deviceId:'d_helper'};
  const input={account:owner,clientCommandId:'create',conversationId:'chat',assigneeUserId:'helper',inputSnapshotId:'snapshot',title:'预算',objective:'核查',acceptanceCriteria:'差异说明'};
  const [first,replay]=await Promise.all([service.create(input),service.create(input)]);
  assert.deepEqual(first,replay,'concurrent same intent creates exactly one task');
  const taskId=first.taskId;
  const objects=createKyselyObjectRepository(database);
  for(const userId of ['owner','helper','observer']){
    const access=await database.transaction().execute(trx=>objects.authorizeObject(trx,{account:{userId,deviceId:`d_${userId}`},objectId:'snapshot',action:'download'}));
    assert.equal(access.ok,userId!=='observer','conversation access must not grant task package access');
  }
  const races=await Promise.allSettled([
    service.act({account:helper,clientCommandId:'accept',taskId,action:'accept',expectedRevision:1}),
    service.act({account:helper,clientCommandId:'decline',taskId,action:'decline',expectedRevision:1}),
  ]);
  assert.equal(races.filter(r=>r.status==='fulfilled').length,1,'CAS permits one winner');
  assert.equal(races.find(r=>r.status==='rejected').reason.code,'COLLAB_TASK_REVISION_CONFLICT');
  await pool.query("UPDATE conversation_members SET status='removed' WHERE user_id='helper'");
  await assert.rejects(service.create(input),{code:'COLLAB_TASK_ACCESS_DENIED'},'removed peer blocks old receipt replay');
  const tasks=await pool.query('SELECT * FROM collaboration_tasks');assert.equal(tasks.rows.length,1);assert.equal(Number(tasks.rows[0].revision),2);
  console.log('PostgreSQL remote tasks: migrations, concurrent replay, task package ACL, transition race and revoked receipt replay passed; object upload verification seeded');
}finally{
  await database.destroy();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
}
