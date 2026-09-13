import { z } from 'zod';
import gitContract from '../../services/collaboration/task-git-descriptor.cjs';
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
}
