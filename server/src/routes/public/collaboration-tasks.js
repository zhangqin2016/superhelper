import { z } from 'zod';
const id=z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const device={deviceId:id.max(120)};
const command={...device,clientCommandId:id};
const change={...command,taskId:id,expectedRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1)};
export const taskCommandBody=z.union([
  z.object({...command,action:z.literal('create'),conversationId:id,assigneeUserId:id,inputSnapshotId:id,title:z.string().trim().min(1).max(200),objective:z.string().trim().min(1).max(12000),acceptanceCriteria:z.string().trim().min(1).max(12000)}).strict(),
  z.object({...change,action:z.enum(['accept','decline','cancel']),reason:z.string().max(4000).optional()}).strict(),
  z.object({...change,action:z.enum(['submit','approve']),deliveryId:id}).strict(),
  z.object({...change,action:z.literal('request_changes'),deliveryId:id,reason:z.string().trim().min(1).max(4000)}).strict(),
]);
export const taskGetBody=z.object({...device,taskId:id}).strict();
export const taskListBody=z.object({...device,conversationId:id}).strict();
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
}
