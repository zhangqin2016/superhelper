import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const {createCollaborationClient}=require('../src/main/collaboration/client');
let account='alice',release,url,posted;
const client=createCollaborationClient({expectedAccountId:'alice',getServiceBaseUrl:()=> 'https://example.test',WebSocketCtor:class{constructor(value){url=value;}},
accountManager:{accountStatus:()=>({loggedIn:true,user:{id:account}}),accessTokenForService:async()=>({ok:true,accessToken:'secret'})},signDeviceRequest:async()=>({}),request:async value=>{posted=value;return {ok:true,json:{ok:true,ticket:'one-time'}};}});
assert.equal(typeof client.createRealtimeSocket,'function','production client constructs ticket-bound socket without test-only factory');
await client.createRealtimeSocket({deviceId:'d'});
assert.equal(url,'wss://example.test/api/collaboration/v1/realtime?ticket=one-time');assert.equal(url.includes('secret'),false);assert.equal(posted.path,'/api/collaboration/v1/ws-ticket');assert.equal(posted.body.deviceId,'d');assert.ok(posted.body.clientCommandId);
console.log('presence default signed ticket socket: ok');
for(const phase of ['account','stop']){
 let complete,owner='alice',constructed=0;
 const pendingClient=createCollaborationClient({expectedAccountId:'alice',getServiceBaseUrl:()=> 'https://example.test',WebSocketCtor:class{constructor(){constructed++;}},accountManager:{accountStatus:()=>({loggedIn:true,user:{id:owner}}),accessTokenForService:async()=>({ok:true,accessToken:'secret'})},signDeviceRequest:async()=>({}),request:()=>new Promise(resolve=>{complete=resolve;})});
 const pending=pendingClient.createRealtimeSocket({deviceId:'d'});await new Promise(r=>setImmediate(r));
 if(phase==='account')owner='other';else pendingClient.stop();
 complete({ok:true,json:{ok:true,ticket:'late'}});await assert.rejects(()=>pending);assert.equal(constructed,0,phase+' fences pending ticket before socket construction');
}
const {createCollaborationRealtimeClient}=require('../src/main/collaboration/realtime-client');
const sockets=[];let nextReconnect,connections=0,frames=0;
const realtime=createCollaborationRealtimeClient({sync:async()=>{},onReconnect:()=>{connections++;},onEphemeral:()=>{frames++;},
createSocket:()=>{const handlers={};const socket={readyState:1,addEventListener:(type,fn)=>{handlers[type]=fn;},close(){},handlers};sockets.push(socket);return socket;},setIntervalFn:()=>1,clearIntervalFn:()=>{},setTimeoutFn:fn=>{nextReconnect=fn;return 1;},clearTimeoutFn:()=>{}});
realtime.start();sockets[0].handlers.open();await Promise.resolve();sockets[0].handlers.close();nextReconnect();sockets[1].handlers.open();await Promise.resolve();
sockets[0].handlers.message({data:JSON.stringify({type:'presence.changed',schemaVersion:1})});sockets[0].handlers.open();await Promise.resolve();
assert.equal(frames,0,'old socket cannot publish presence hint');assert.equal(connections,2,'old socket cannot report reconnect');realtime.stop();
console.log('presence ticket cancellation and stale socket fencing: ok');
