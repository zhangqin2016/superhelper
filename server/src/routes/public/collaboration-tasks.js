import { z } from 'zod';
import gitContract from '../../services/collaboration/task-git-descriptor.cjs';
import publicationContract from '../../services/collaboration/shared-publication-contract.cjs';
const gitDescriptor=z.custom(value=>{try{gitContract.gitDescriptor(value);return true;}catch{return false;}}).transform(gitContract.gitDescriptor);
const id=z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const device={deviceId:id.max(120)};
const command={...device,clientCommandId:id};
const change={...command,taskId:id,expectedRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1)};
export const taskCommandBody=z.union([
  z.object({...command,action:z.literal('create'),conversationId:id,assigneeUserId:id,inputSnapshotId:id,sharedWorkspaceId:id.optional(),inputGit:gitDescriptor.optional(),title:z.string().trim().min(1).max(200),objective:z.string().trim().min(1).max(12000),acceptanceCriteria:z.string().trim().min(1).max(12000)}).strict(),
  z.object({...change,action:z.enum(['accept','decline','cancel']),reason:z.string().max(4000).optional()}).strict(),
  z.object({...change,action:z.literal('submit'),deliveryId:id,deliveryGit:gitDescriptor.optional()}).strict(),
  z.object({...change,action:z.literal('approve'),deliveryId:id}).strict(),
  z.object({...change,action:z.literal('request_changes'),deliveryId:id,reason:z.string().trim().min(1).max(4000)}).strict(),
]);
export const taskGetBody=z.object({...device,taskId:id}).strict();
export const taskGitMissingBody=z.object({...device,taskId:id,deliveryId:id.optional(),
  haveCommits:z.array(z.string().regex(/^[0-9a-f]{40}$/)).max(256).refine(values=>new Set(values).size===values.length),
}).strict();
export const taskListBody=z.object({...device,conversationId:id}).strict();
export const taskHistoryBody=z.object({...device,conversationId:id,cursor:z.object({
  createdAt:z.number().int().min(0).max(8640000000000000),id,
}).strict().optional()}).strict();
const integrationScope={workspaceId:id,taskId:id,deliveryId:id};
const integrationHead={expectedHead:z.string().regex(/^[a-f0-9]{40}$/),expectedRevision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1)};
export const integrationTargetBody=z.object({...device,...integrationScope}).strict();
export const integrationClaimBody=z.object({...command,...integrationScope,...integrationHead}).strict();
export const integrationRenewBody=z.object({...command,...integrationScope,...integrationHead,leaseId:id,generation:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1)}).strict();
export const integrationReleaseBody=integrationRenewBody;
export const integrationPublishBody=z.object({...command,workspaceId:id,taskId:id,deliveryId:id,...integrationHead,leaseId:id,generation:z.number().int().positive(),
  publicationId:id,objectId:id,baselineCommit:z.string(),deliveryCommit:z.string(),tree:z.string(),git:z.unknown(),validation:z.unknown()}).strict()
  .superRefine(({deviceId,clientCommandId,...input},context)=>{try{publicationContract.publicationInput(input);}catch{context.addIssue({code:z.ZodIssueCode.custom,message:'Invalid publication'});}});
export const integrationPublicationBody=z.object({...device,workspaceId:id,publicationId:id.optional()}).strict();
export const integrationBaselineBody=z.object({...device,workspaceId:id}).strict();
export const integrationBaselineResolveBody=z.object({...command,...integrationScope,expectedHead:integrationHead.expectedHead,expectedRevision:z.literal(0),afterTaskId:id.optional()}).strict();
export function registerCollaborationTaskRoutes({post,accountFor,database,service}){
  const run=(schema,fn)=>async(request,reply)=>{
    const input=schema.parse(request.body);
    const account=await accountFor(request,reply,input,database);if(!account)return;
    if(!service)return reply.code(503).send({ok:false,code:'COLLAB_TASK_UNAVAILABLE',retryable:false});
    const {deviceId,...fields}=input;
    return reply.send({ok:true,requestId:account.requestId,result:await fn(account,fields)});
  };
  post('/api/collaboration/v1/tasks',taskCommandBody,run(taskCommandBody,(account,{action,...input})=>action==='create'?service.create({account,...input}):service.act({account,action,...input})));
  post('/api/collaboration/v1/tasks/get',taskGetBody,run(taskGetBody,(account,input)=>service.get({account,...input})));
  post('/api/collaboration/v1/tasks/list',taskListBody,run(taskListBody,(account,input)=>service.list({account,...input})));
  post('/api/collaboration/v1/tasks/history',taskHistoryBody,run(taskHistoryBody,(account,input)=>service.listHistory({account,...input})));
  post('/api/collaboration/v1/tasks/git/missing',taskGitMissingBody,run(taskGitMissingBody,(account,input)=>service.missingGitObjects({account,...input})));
  post('/api/collaboration/v1/tasks/integration/get',integrationTargetBody,run(integrationTargetBody,(account,input)=>service.getIntegrationTarget({account,...input})));
  post('/api/collaboration/v1/tasks/integration/claim',integrationClaimBody,run(integrationClaimBody,(account,input)=>service.claimIntegration({account,...input})));
  post('/api/collaboration/v1/tasks/integration/renew',integrationRenewBody,run(integrationRenewBody,(account,input)=>service.renewIntegration({account,...input})));
  post('/api/collaboration/v1/tasks/integration/release',integrationReleaseBody,run(integrationReleaseBody,(account,input)=>service.releaseIntegration({account,...input})));
  post('/api/collaboration/v1/tasks/integration/publish',integrationPublishBody,run(integrationPublishBody,(account,input)=>service.publishIntegration({account,...input})));
  post('/api/collaboration/v1/tasks/integration/publication',integrationPublicationBody,run(integrationPublicationBody,(account,input)=>service.getIntegrationPublication({account,...input})));
  post('/api/collaboration/v1/tasks/integration/baseline',integrationBaselineBody,run(integrationBaselineBody,(account,input)=>service.getIntegrationBaseline({account,...input})));
  post('/api/collaboration/v1/tasks/integration/baseline/resolve',integrationBaselineResolveBody,run(integrationBaselineResolveBody,(account,input)=>service.resolveIntegrationBaseline({account,...input})));
}
