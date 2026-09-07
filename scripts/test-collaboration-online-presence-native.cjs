const assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto');
const {app}=require('electron');const {pathToFileURL}=require('node:url');const path=require('node:path');
const {createCollaborationClient}=require('../src/main/collaboration/client');const {createCollaborationRealtimeClient}=require('../src/main/collaboration/realtime-client');
let server,realtime;const hooks=[];const deadline=setTimeout(()=>app.exit(1),20000);
app.whenReady().then(async()=>{
 assert.equal(typeof globalThis.WebSocket,'function','packaged Electron main exposes native WebSocket');
 const {registerCollaborationRealtimeGateway}=await import(pathToFileURL(path.resolve('server/src/services/collaboration/realtime-gateway.js')));
 const {createCollaborationWsTicketService}=await import(pathToFileURL(path.resolve('server/src/services/collaboration/ws-ticket.js')));
 const records=new Map(),{publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
 const ticketService=createCollaborationWsTicketService({repository:{withWriteTransaction:fn=>fn({}),issueWsTicket:async(_,record)=>{records.set(record.tokenHash,record);return record;},consumeWsTicket:async(_,hash)=>{const record=records.get(hash);records.delete(hash);return record?{userId:record.userId,deviceId:record.deviceId,sessionId:record.sessionId}:null;}}});
 let issued=0,touched=0,connected=0,disconnected=0,identity;
 server=http.createServer((req,res)=>{let body='';req.on('data',part=>body+=part);req.on('end',async()=>{try{
 assert.equal(req.url,'/api/collaboration/v1/ws-ticket');assert.equal(req.headers.authorization,'Bearer local-test');
 assert.equal(crypto.verify(null,Buffer.from(body),publicKey,Buffer.from(req.headers['x-test-signature'],'base64')),true);
 const value=JSON.parse(body);assert.equal(value.deviceId,'device');assert.ok(value.clientCommandId);issued++;
 const result=await ticketService.issue({userId:'alice',deviceId:value.deviceId,sessionId:'session'});res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,...result}));
 }catch(error){res.statusCode=400;res.end('{}');console.error(error);}});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const gateway=registerCollaborationRealtimeGateway({server,addHook:(_,fn)=>hooks.push(fn)}, {ticketService,presence:{connect:async(_,value)=>{connected++;identity=value;return true;},touch:async()=>{touched++;return false;},disconnect:async()=>{disconnected++;return true;},expiredIds:()=>[],clear:async()=>{}}});
 const client=createCollaborationClient({getServiceBaseUrl:()=>base,expectedAccountId:'alice',accountManager:{accountStatus:()=>({loggedIn:true,user:{id:'alice'}}),accessTokenForService:async()=>({ok:true,accessToken:'local-test'})},signDeviceRequest:async({body})=>({'x-test-signature':crypto.sign(null,Buffer.from(JSON.stringify(body)),privateKey).toString('base64')}),request:async({path,method,body,headers})=>{const response=await fetch(base+path,{method,body:JSON.stringify(body),headers});return {ok:response.ok,json:await response.json()};}});
 let hints=0,syncs=0;
 realtime=createCollaborationRealtimeClient({createSocket:()=>client.createRealtimeSocket({deviceId:'device'}),sync:async()=>{syncs++;},onEphemeral:frame=>{if(frame.type==='presence.changed')hints++;},setIntervalFn:(fn,ms)=>setInterval(fn,ms===30000?25:ms)});
 realtime.start();const until=async fn=>{for(let i=0;i<650;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('native WS condition timed out');};
 await until(()=>touched>0);assert.equal(issued,1);assert.equal(connected,1);assert.equal(identity.sessionId,'session');
 gateway.notifySyncAvailable('alice',1);await until(()=>syncs>0);gateway.notifyPresenceChanged();await until(()=>hints>0);
 for(const socket of gateway.wss.clients)socket.terminate();await until(()=>connected===2);assert.equal(issued,2,'real reconnect obtains a fresh one-time ticket');
 realtime.stop();await until(()=>disconnected>0);client.stop();
 console.log('actual Electron native WebSocket: signed HTTP ticket, session/device-bound gateway, heartbeat, hint, durable sync and close passed (accelerated heartbeat clock)');
}).then(async()=>{clearTimeout(deadline);for(const hook of hooks)await hook();await new Promise(resolve=>server.close(resolve));app.exit(0);}).catch(async error=>{console.error(error);clearTimeout(deadline);realtime?.stop();for(const hook of hooks)await hook();server?.close();app.exit(1);});
