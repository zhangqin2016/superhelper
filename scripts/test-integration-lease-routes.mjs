import assert from 'node:assert/strict';
import {integrationTargetBody,integrationClaimBody,integrationRenewBody,registerCollaborationTaskRoutes} from '../server/src/routes/public/collaboration-tasks.js';
import {createIntegrationLeaseService} from '../server/src/services/collaboration/integration-leases.js';
import {createHash} from 'node:crypto';
import {integrationPublishBody,integrationPublicationBody} from '../server/src/routes/public/collaboration-tasks.js';
const scope={deviceId:'device',workspaceId:'workspace',taskId:'task',deliveryId:'delivery'};
const claim={...scope,clientCommandId:'claim',expectedHead:'a'.repeat(40),expectedRevision:0};
assert.equal(integrationTargetBody.safeParse(scope).success,true);
assert.equal(integrationClaimBody.safeParse(claim).success,true);
const renew={...claim,leaseId:'lease',generation:1};assert.equal(integrationRenewBody.safeParse(renew).success,true);
const git={version:1,format:'git-bundle-v2',ref:`refs/workspaces/${createHash('sha256').update(JSON.stringify(scope.workspaceId)).digest('hex')}/candidates/${'b'.repeat(64)}`,
  commit:'b'.repeat(40),prerequisites:[],sha256:'c'.repeat(64),sizeBytes:500};
const publication={...renew,publicationId:'publication',objectId:'object',baselineCommit:claim.expectedHead,deliveryCommit:'d'.repeat(40),tree:'e'.repeat(40),git,
  validation:{commit:git.commit,policyId:'pinned-node',evidenceHash:'f'.repeat(64)}};
assert.equal(integrationPublishBody.safeParse(publication).success,true);
for(const extra of [{localPath:'/private'},{leaseMs:1},{generation:Number.MAX_SAFE_INTEGER},{tree:'invalid'},
  {git:{...git,ref:git.ref.replace('candidates','head')}},{git:{...git,prerequisites:['0'.repeat(40)]}},
  {git:{...git,sizeBytes:256*1024**2+1}},{git:{...git,ref:git.ref.replace(/workspaces\/[a-f0-9]+/,'workspaces/'+ '0'.repeat(64))}},
  {validation:{...publication.validation,ok:true}},{validation:{...publication.validation,commit:'0'.repeat(40)}}])
  assert.equal(integrationPublishBody.safeParse({...publication,...extra}).success,false,'closed candidate/evidence and workspace scope');
assert.equal(integrationPublicationBody.safeParse({deviceId:'device',workspaceId:'workspace',publicationId:'publication'}).success,true);
assert.equal(integrationPublicationBody.safeParse({...scope,ownerUserId:'other'}).success,false);
for(const extra of [{leaseMs:9999999},{actorUserId:'owner'},{expiresAt:9999999},{localPath:'/private'},{generation:1}])assert.equal(integrationClaimBody.safeParse({...claim,...extra}).success,false);
for(const generation of [0,-1,1.5,Number.MAX_SAFE_INTEGER])assert.equal(integrationRenewBody.safeParse({...renew,generation}).success,false);
const routes=new Map();let calls=0;
registerCollaborationTaskRoutes({post:(url,schema,handler)=>routes.set(url,handler),accountFor:async()=>null,database:{},service:{claimIntegration(){calls++;}}});
await routes.get('/api/collaboration/v1/tasks/integration/claim')({body:claim},{});assert.equal(calls,0);
await assert.rejects(createIntegrationLeaseService({enabled:'true'}).getIntegrationTarget({}),{code:'COLLAB_INTEGRATION_PROTOCOL_UNAVAILABLE'},'only an explicit server capability enables qualification');
console.log('integration qualification routes: closed identity/head/generation inputs, server-owned TTL and authentication boundary passed');
