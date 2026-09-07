import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.COLLABORATION_ENABLED='true';
process.env.COLLABORATION_KILL_SWITCH='false';
const {registerCollaborationRoutes}=await import('../server/src/routes/public/collaboration.js');
const require=createRequire(new URL('../server/package.json',import.meta.url));
const app=require('fastify')();
let reads=0;
app.collaborationPresence={readBatch:async()=>{reads++;return[];}};
registerCollaborationRoutes(app,{database:{},syncService:{},ticketService:{},friendService:{},objectService:{},messageService:{},taskService:{},conversationService:{},conversationProjectionService:{}});
try {
 const request=payload=>app.inject({method:'POST',url:'/api/collaboration/v1/presence',payload});
 assert.equal((await request({deviceId:'d',userIds:Array(201).fill('u')})).statusCode,400);
 assert.equal((await request({deviceId:'d',userIds:['']})).statusCode,400);
 assert.equal((await request({deviceId:'d',userIds:['u']})).statusCode,401);
 assert.equal(reads,0,'unsigned or oversized requests never reach presence');
 console.log('Presence route: schema bounds and account authentication gate passed');
}finally{await app.close();}
