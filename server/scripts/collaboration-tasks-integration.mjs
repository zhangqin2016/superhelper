import {verifySharedPublications} from './collaboration-publication-fixture.mjs';
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
import taskContract from '../src/services/collaboration/task-contract.cjs';
import {verifyIntegrationLeases} from './collaboration-integration-lease-fixture.mjs';
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
  for(const name of ['033_collaboration_core.sql','035_collaboration_bootstrap_completion.sql','037_collaboration_relationship_events.sql','038_collaboration_conversations.sql','039_collaboration_objects.sql','045_collaboration_tasks.sql','047_collaboration_shared_workspaces.sql','048_collaboration_task_history.sql','049_collaboration_integration_targets.sql','050_collaboration_shared_publications.sql'])await pool.query(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  for(const id of ['owner','helper','observer']){
    await pool.query('INSERT INTO users VALUES($1)',[id]);await pool.query('INSERT INTO devices VALUES($1)',[`d_${id}`]);
    await pool.query('INSERT INTO user_devices(user_id,device_id) VALUES($1,$2)',[id,`d_${id}`]);
  }
  await pool.query("INSERT INTO conversations(id,scope_type,kind,created_by) VALUES('chat','personal','group','owner')");
  await pool.query("INSERT INTO conversation_members(conversation_id,user_id,role,status,joined_seq) VALUES('chat','owner','owner','active',0),('chat','helper','member','active',0),('chat','observer','member','active',0)");
  const packages=createTaskPackageBroker();
  await pool.query("INSERT INTO stored_objects(id,owner_user_id,conversation_id,scope_type,purpose,object_key,state,ciphertext_size,ciphertext_sha256,mime_type,original_name) VALUES('snapshot','owner','chat','personal','workspace','test/snapshot','verified',10,$1,'application/zip','input.zip')",['a'.repeat(64)]);
  const crypto=createCollaborationMessageCrypto({currentKekVersion:1,kekByVersion:{1:randomBytes(32)}});
  const service=createCollaborationTaskService({repository:createKyselyConversationRepository(database),crypto,packages,integrationLeasesEnabled:true});
  const owner={userId:'owner',deviceId:'d_owner'},helper={userId:'helper',deviceId:'d_helper'};
  const input={account:owner,clientCommandId:'create',conversationId:'chat',assigneeUserId:'helper',inputSnapshotId:'snapshot',title:'预算',objective:'核查',acceptanceCriteria:'差异说明',sharedWorkspaceId:'shared'};
  const [first,replay]=await Promise.all([service.create(input),service.create(input)]);
  assert.deepEqual(first,replay,'concurrent same intent creates exactly one task');
  const taskId=first.taskId;
  assert.equal((await service.get({account:helper,taskId})).sharedWorkspaceId,'shared');
  assert.equal(Number((await pool.query('SELECT count(*) FROM collaboration_shared_workspaces')).rows[0].count),1);
  await assert.rejects(service.create({...input,account:helper,assigneeUserId:'owner',clientCommandId:'steal'}),{code:'COLLAB_TASK_ACCESS_DENIED'},'workspace ID cannot transfer ownership');
  await pool.query("INSERT INTO conversations(id,scope_type,kind,created_by) VALUES('other','personal','group','owner')");
  await pool.query("INSERT INTO conversation_members(conversation_id,user_id,role,status,joined_seq) VALUES('other','owner','owner','active',0),('other','helper','member','active',0)");
  await assert.rejects(service.create({...input,conversationId:'other',clientCommandId:'cross-conversation'}),{code:'COLLAB_TASK_ACCESS_DENIED'},'same owner cannot transfer the identity into another permission domain');
  await assert.rejects(service.get({account:{userId:'observer',deviceId:'d_observer'},taskId}),{code:'COLLAB_TASK_ACCESS_DENIED'},'workspace identity grants no bystander task access');
  await assert.rejects(service.get({account:helper,taskId:'absent'}),{code:'COLLAB_TASK_ACCESS_DENIED'},'missing and unauthorized tasks are indistinguishable');
  await assert.rejects(service.create({...input,clientCommandId:'broken',sharedWorkspaceId:'rolledback',inputSnapshotId:'missing'}));
  assert.equal((await pool.query("SELECT id FROM collaboration_shared_workspaces WHERE id='rolledback'")).rowCount,0,'failed object binding rolls back workspace creation');
  await pool.query("INSERT INTO stored_objects(id,owner_user_id,conversation_id,scope_type,purpose,object_key,state,ciphertext_size,ciphertext_sha256,mime_type,original_name) VALUES('snapshot2','owner','chat','personal','workspace','test/snapshot2','verified',10,$1,'application/zip','input.zip')",['b'.repeat(64)]);
  const second=await service.create({...input,clientCommandId:'second',inputSnapshotId:'snapshot2'});
  assert.notEqual(second.taskId,taskId);
  assert.equal((await service.get({account:helper,taskId:second.taskId})).sharedWorkspaceId,'shared','separate tasks retain one workspace identity');
  await pool.query("UPDATE collaboration_tasks SET shared_workspace_id=NULL WHERE id=$1",[second.taskId]);
  await assert.rejects(service.get({account:helper,taskId:second.taskId}),{code:'COLLAB_TASK_UNAVAILABLE'},'encrypted identity must agree with database routing');
  await pool.query("UPDATE collaboration_tasks SET shared_workspace_id='shared' WHERE id=$1",[second.taskId]);
  await assert.rejects(pool.query("UPDATE collaboration_tasks SET requester_user_id='observer' WHERE id=$1",[second.taskId]),{code:'23503'},'database rejects moving a task into another owner domain');
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
  const tasks=await pool.query('SELECT * FROM collaboration_tasks');assert.equal(tasks.rows.length,2);assert.equal(Number(tasks.rows.find(t=>t.id===taskId).revision),2);
  await pool.query("UPDATE conversation_members SET status='active' WHERE user_id='helper'");
  const seeded=[];
  for(let i=0;i<105;i++) {
    const id=`history_${String(i).padStart(3,'0')}`;
    const task=taskContract.createTask({id,conversationId:'chat',assigneeUserId:'helper',inputSnapshotId:`input_${i}`,title:`History ${i}`,objective:'Review',acceptanceCriteria:'Verified'},
      {actorUserId:'owner',authorizedParticipantIds:['owner','helper'],now:1000});
    const envelope=crypto.encryptTask({plaintext:Buffer.from(JSON.stringify(task)),messageId:id,conversationId:'chat',revision:1});
    seeded.push({id,conversation_id:'chat',requester_user_id:'owner',assignee_user_id:'helper',input_snapshot_id:task.inputSnapshotId,
      state:'offered',revision:1,content_ciphertext:envelope.ciphertext,content_key_version:envelope.keyVersion,created_at:new Date(1000),updated_at:new Date(1000)});
  }
  await database.insertInto('collaboration_tasks').values(seeded).execute();
  const page1=await service.listHistory({account:owner,conversationId:'chat'});
  assert.equal(page1.tasks.length,50);assert.ok(page1.nextCursor);
  await service.act({account:helper,clientCommandId:'history-progress',taskId:'history_010',action:'accept',expectedRevision:1});
  let cursor=page1.nextCursor;const seen=page1.tasks.map(task=>task.id);let pages=1;
  while(cursor){const page=await service.listHistory({account:owner,conversationId:'chat',cursor});assert.ok(page.tasks.length<=50);seen.push(...page.tasks.map(task=>task.id));cursor=page.nextCursor;assert.ok(++pages<5);}
  assert.equal(seen.length,107);assert.equal(new Set(seen).size,107,'timestamp ties and progress changes cannot duplicate or omit history');
  assert.deepEqual(await service.listHistory({account:{userId:'observer',deviceId:'d_observer'},conversationId:'chat'}),{tasks:[],nextCursor:null},'bystander sees neither tasks nor pagination metadata');
  await pool.query("UPDATE conversation_members SET status='removed' WHERE user_id='helper'");
  cursor=undefined;pages=0;
  do {const page=await service.listHistory({account:owner,conversationId:'chat',cursor});assert.equal(page.tasks.length,0,'every scanned body rechecks both participants');cursor=page.nextCursor;assert.ok(++pages<5);}while(cursor);
  assert.equal(pages,3,'denied candidate pages must still advance rather than hide later history');
  await assert.rejects(service.listHistory({account:helper,conversationId:'chat'}),{code:'COLLAB_TASK_ACCESS_DENIED'},'revoked actor cannot page the conversation');
  await pool.query("UPDATE conversation_members SET status='active' WHERE user_id='helper'");
  for(const [objectId,userId] of [['git-input','owner'],['git-delivery','helper']])
    await pool.query("INSERT INTO stored_objects(id,owner_user_id,conversation_id,scope_type,purpose,object_key,state,ciphertext_size,ciphertext_sha256,mime_type,original_name) VALUES($1,$2,'chat','personal','workspace',$3,'verified',1000,$4,'application/octet-stream','task.bundle')",[objectId,userId,`test/${objectId}`,'a'.repeat(64)]);
  const inputGit={version:1,format:'git-bundle-v2',ref:`refs/tasks/${'a'.repeat(64)}/baseline`,commit:'b'.repeat(40),prerequisites:[],sha256:'c'.repeat(64),sizeBytes:500};
  const gitInput={...input,clientCommandId:'git-create',inputSnapshotId:'git-input',inputGit};
  const gitTask=(await service.create(gitInput)).taskId;
  assert.equal((await service.create(gitInput)).taskId,gitTask);
  assert.deepEqual((await service.get({account:helper,taskId:gitTask})).inputGit,inputGit,'descriptor survives encrypted PostgreSQL storage');
  await pool.query("UPDATE collaboration_tasks SET input_snapshot_id='snapshot' WHERE id=$1",[gitTask]);
  await assert.rejects(service.get({account:helper,taskId:gitTask}),{code:'COLLAB_TASK_UNAVAILABLE'},'encrypted Git input descriptor cannot be routed through another input object');
  await pool.query("UPDATE collaboration_tasks SET input_snapshot_id='git-input' WHERE id=$1",[gitTask]);
  assert.deepEqual((await service.missingGitObjects({account:helper,taskId:gitTask,haveCommits:[]})).objects,[{objectId:'git-input',descriptor:inputGit}]);
  assert.deepEqual((await service.missingGitObjects({account:helper,taskId:gitTask,haveCommits:[inputGit.commit]})).objects,[]);
  assert.equal((await service.missingGitObjects({account:helper,taskId:gitTask,haveCommits:['0'.repeat(40)]})).objects.length,1,'unknown hashes cannot query other tasks');
  await assert.rejects(service.missingGitObjects({account:{userId:'observer',deviceId:'d_observer'},taskId:gitTask,haveCommits:[]}),{code:'COLLAB_TASK_ACCESS_DENIED'});
  await service.act({account:helper,clientCommandId:'git-accept',taskId:gitTask,action:'accept',expectedRevision:1});
  const deliveryGit={...inputGit,ref:`refs/tasks/${'a'.repeat(64)}/deliveries/${'d'.repeat(64)}`,commit:'e'.repeat(40),prerequisites:[inputGit.commit]};
  const gitSubmit={account:helper,clientCommandId:'git-submit',taskId:gitTask,action:'submit',expectedRevision:2,deliveryId:'git-delivery',deliveryGit};
  await pool.query("UPDATE stored_objects SET state='revoked' WHERE id='git-input'");
  await assert.rejects(service.missingGitObjects({account:helper,taskId:gitTask,haveCommits:[inputGit.commit]}),{code:'COLLAB_TASK_PACKAGE_UNAVAILABLE'},'a local cache hit cannot bypass object revocation');
  await assert.rejects(service.act({...gitSubmit,clientCommandId:'git-unavailable-base'}),{code:'COLLAB_TASK_PACKAGE_UNAVAILABLE'},'incremental delivery cannot depend on revoked server input');
  assert.equal((await pool.query("SELECT state FROM stored_objects WHERE id='git-delivery'")).rows[0].state,'verified','failed prerequisite check leaves delivery unbound');
  await pool.query("UPDATE stored_objects SET state='bound' WHERE id='git-input'");
  await service.act(gitSubmit);await service.act(gitSubmit);
  const gitResult=await service.get({account:owner,taskId:gitTask});assert.equal(gitResult.deliveries.length,1);assert.deepEqual(gitResult.deliveries[0].git,deliveryGit);
  assert.deepEqual((await service.missingGitObjects({account:owner,taskId:gitTask,deliveryId:'git-delivery',haveCommits:[inputGit.commit]})).objects,[{objectId:'git-delivery',descriptor:deliveryGit}]);
  await assert.rejects(service.act({...gitSubmit,deliveryGit:{...deliveryGit,sha256:'0'.repeat(64)}}),{code:'IDEMPOTENCY_KEY_REUSED'},'immutable command binds the descriptor too');
  for(const [objectId,userId] of [['git-input-2','owner'],['git-delivery-2','helper']])
    await pool.query("INSERT INTO stored_objects(id,owner_user_id,conversation_id,scope_type,purpose,object_key,state,ciphertext_size,ciphertext_sha256,mime_type,original_name) VALUES($1,$2,'chat','personal','workspace',$3,'verified',1000,$4,'application/octet-stream','task.bundle')",[objectId,userId,`test/${objectId}`,'a'.repeat(64)]);
  const competingTaskId=(await service.create({...gitInput,clientCommandId:'git-create-2',inputSnapshotId:'git-input-2'})).taskId;
  await service.act({account:helper,clientCommandId:'git-accept-2',taskId:competingTaskId,action:'accept',expectedRevision:1});
  await service.act({...gitSubmit,taskId:competingTaskId,clientCommandId:'git-submit-2',deliveryId:'git-delivery-2'});
  await verifyIntegrationLeases({service,pool,owner,helper,taskId:gitTask,workspaceId:'shared',deliveryId:'git-delivery',baselineCommit:inputGit.commit,
    competingTask:{taskId:competingTaskId,deliveryId:'git-delivery-2'}});
  await verifySharedPublications({service,pool,database,crypto,owner,helper,taskId:competingTaskId,workspaceId:'shared',deliveryId:'git-delivery-2'});
  await pool.query("UPDATE conversation_members SET status='removed' WHERE user_id='helper'");
  await assert.rejects(service.missingGitObjects({account:owner,taskId:gitTask,haveCommits:[]}),{code:'COLLAB_TASK_ACCESS_DENIED'},'missing query rechecks both parties');
  console.log('PostgreSQL remote tasks: migrations, replay, package ACL, CAS, history pagination and Git descriptor/missing-query/prerequisite/revocation checks passed; object verification and historical encrypted rows seeded');
}finally{
  await database.destroy();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
}
