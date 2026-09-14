import assert from 'node:assert/strict';
import { taskCommandBody, taskGetBody, taskListBody, taskHistoryBody, taskGitMissingBody, integrationBaselineBody, integrationBaselineResolveBody, registerCollaborationTaskRoutes } from '../server/src/routes/public/collaboration-tasks.js';
import { createConfiguredTaskService } from '../server/src/services/collaboration/task-config.js';
const create={deviceId:'d',clientCommandId:'c',action:'create',conversationId:'chat',assigneeUserId:'helper',inputSnapshotId:'snapshot',title:'预算',objective:'核对',acceptanceCriteria:'差异说明'};
assert.equal(taskCommandBody.safeParse(create).success,true);
const inputGit={version:1,format:'git-bundle-v2',ref:`refs/tasks/${'a'.repeat(64)}/baseline`,commit:'b'.repeat(40),prerequisites:[],sha256:'c'.repeat(64),sizeBytes:500};
assert.equal(taskCommandBody.safeParse({...create,inputGit}).success,true);
assert.equal(taskCommandBody.safeParse({...create,inputGit:{...inputGit,localPath:'/private'}}).success,false);
assert.equal(taskGitMissingBody.safeParse({deviceId:'d',taskId:'t',haveCommits:[inputGit.commit]}).success,true);
for (const haveCommits of [[inputGit.commit,inputGit.commit],['private'],Array(257).fill(inputGit.commit)])
  assert.equal(taskGitMissingBody.safeParse({deviceId:'d',taskId:'t',haveCommits}).success,false);
assert.equal(taskCommandBody.safeParse({...create,sharedWorkspaceId:'workspace'}).success,true);
for (const sharedWorkspaceId of ['',null,'../private']) assert.equal(taskCommandBody.safeParse({...create,sharedWorkspaceId}).success,false);
for(const extra of [{requesterUserId:'forged'},{role:'owner'},{state:'accepted'},{revision:100},{localPath:'/private/file'}])assert.equal(taskCommandBody.safeParse({...create,...extra}).success,false);
assert.equal(taskCommandBody.safeParse({deviceId:'d',clientCommandId:'x',taskId:'t',action:'approve',expectedRevision:1}).success,false,'approval must identify the reviewed immutable version');
assert.equal(taskCommandBody.safeParse({...create,title:' '.repeat(3)}).success,false);
assert.equal(taskGetBody.safeParse({deviceId:'d',taskId:'t',userId:'owner'}).success,false);
assert.equal(taskListBody.safeParse({deviceId:'d',conversationId:'chat'}).success,true);
assert.equal(taskHistoryBody.safeParse({deviceId:'d',conversationId:'chat',cursor:{createdAt:100,id:'task'}}).success,true);
for(const cursor of [{createdAt:-1,id:'task'},{createdAt:100,id:'../task'},{createdAt:100,id:'task',userId:'other'}])
  assert.equal(taskHistoryBody.safeParse({deviceId:'d',conversationId:'chat',cursor}).success,false);
assert.equal(taskHistoryBody.safeParse({deviceId:'d',conversationId:'chat',limit:1000000}).success,false,'page size cannot be chosen by an untrusted client');
const resolve={deviceId:'d',clientCommandId:'restore',workspaceId:'workspace',taskId:'task',deliveryId:'delivery',expectedHead:inputGit.commit,expectedRevision:0};
assert.equal(integrationBaselineResolveBody.safeParse(resolve).success,true);
for(const extra of [{limit:10000},{expectedRevision:1},{afterTaskId:'../private'},{ownerUserId:'forged'}])
  assert.equal(integrationBaselineResolveBody.safeParse({...resolve,...extra}).success,false,'initial H restoration is scoped, revision-zero and server-bounded');
assert.equal(integrationBaselineBody.safeParse({deviceId:'d',workspaceId:'workspace',sourceTaskId:'forged'}).success,false);
assert.equal(createConfiguredTaskService({config:{collaborationTasksEnabled:false}}),null);
assert.equal(createConfiguredTaskService({config:{collaborationTasksEnabled:true,collaborationWorkspaceSharesEnabled:true,collaborationMessageKek:'bad'}}),null,'missing task crypto does not take ordinary IM down');
const routes=new Map();let calls=0;
registerCollaborationTaskRoutes({post:(path,schema,handler)=>routes.set(path,handler),accountFor:async()=>null,database:{},service:{create:()=>calls++}});
await routes.get('/api/collaboration/v1/tasks')({body:create},{});
await routes.get('/api/collaboration/v1/tasks/history')({body:{deviceId:'d',conversationId:'chat'}},{});
await routes.get('/api/collaboration/v1/tasks/git/missing')({body:{deviceId:'d',taskId:'t',haveCommits:[]}},{});
await routes.get('/api/collaboration/v1/tasks/integration/baseline')({body:{deviceId:'d',workspaceId:'workspace'}},{});
await routes.get('/api/collaboration/v1/tasks/integration/baseline/resolve')({body:resolve},{});
assert.equal(calls,0,'unauthenticated requests never reach task mutation');
console.log('remote task routes: closed inputs, explicit delivery approval, authentication boundary and disabled fallback passed');
