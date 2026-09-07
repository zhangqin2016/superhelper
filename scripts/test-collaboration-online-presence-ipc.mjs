import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createCollaborationIpc}=require('../src/main/ipc-collaboration');
const {createCollaborationClient}=require('../src/main/collaboration/client');
const handlers=new Map(); let requests=0;
const service={ok:true,getPresence:({userIds})=>{requests++;return {ok:true,observedAt:new Date().toISOString(),states:userIds.map(userId=>({userId,presence:'offline',onlineUntil:null,token:'secret'}))};}};
createCollaborationIpc({ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},getService:()=>service});
const get=payload=>handlers.get('collaboration:get-presence')(null,payload);
for (const input of [null,{}, {userIds:['u','u']},{userIds:['../u']},{userIds:['u'],deviceId:'foreign'}, {userIds:Array.from({length:201},(_,i)=>`u${i}`)}]) assert.equal((await get(input)).ok,false);
assert.equal(requests,0);
assert.deepEqual((await get({userIds:['u']})).states,[{userId:'u',presence:'offline',onlineUntil:null}]);
let signed, sent;
const client=createCollaborationClient({accountManager:{accessTokenForService:async()=>({ok:true,accessToken:'private'})},
signDeviceRequest:async value=>{signed=value;return {'x-device':'signed'};},request:async value=>{sent=value;return {ok:true,json:{ok:true,states:[],observedAt:new Date().toISOString()}};}});
await client.getPresence({deviceId:'d',userIds:['u']});
assert.equal(sent.path,'/api/collaboration/v1/presence'); assert.deepEqual(signed.body,{deviceId:'d',userIds:['u']});
assert.equal(sent.headers['x-device'],'signed');
console.log('presence client and IPC: ok');
