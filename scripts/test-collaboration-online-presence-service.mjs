import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';import path from 'node:path';
const require=createRequire(import.meta.url);
const {CollaborationStore}=require('../src/main/collaboration/collaboration-store');
const {LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring');
const {createCollaborationService}=require('../src/main/collaboration/service');
const {directoryView}=require('../src/main/collaboration/directory-view');
const root=mkdtempSync(path.join(os.tmpdir(),'presence-service-'));
const keyring=new LocalCollaborationKeyring({filePath:path.join(root,'keys.json'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
const store=new CollaborationStore({dbPath:path.join(root,'db.sqlite'),accountId:'alice',keyring});
store.replaceProjectionFromBootstrap({watermark:0,conversations:[{id:'c',kind:'direct',scopeId:'personal'}]});
let release, syncs=0;
const service=createCollaborationService({openStore:()=>({ok:true,store}),deviceId:'d',client:{
 getPresence:()=>new Promise(resolve=>{release=resolve;}),
 syncAndAcknowledge:async()=>{syncs++;return {events:[]};},getHistoryPage:async()=>({messages:[]})}});
try{
 const reading=service.getPresence({userIds:['peer']});await new Promise(r=>setImmediate(r));
 await service.realtime.notifyAvailable();
 assert.equal(syncs,1,'presence never occupies durable sync lane');
 const opened=await service.open({conversationId:'c',cached:true});assert.equal(opened.ok,true,'cached conversation open does not await presence');
 service.syncEngine.applyBootstrap({watermark:0,conversations:[{id:'c',kind:'direct',scopeId:'personal'}]});
 release({ok:true,observedAt:'2030-01-01T00:00:00Z',states:[{userId:'peer',presence:'online',onlineUntil:'2030-01-01T00:01:15Z'}]});
 assert.equal((await reading).states[0].presence,'unknown','actual bootstrap fences old directory response');
 const cached=directoryView({profile:null,contacts:[],teams:[{id:'t',scopeId:'team:t',name:'Team',role:'member',members:[{userId:'peer',role:'member',presence:'online',onlineUntil:'2099-01-01T00:00:00Z'}]}]});
 assert.equal(cached.teams[0].members[0].presence,'unknown','directory persistence cannot resurrect green');
 const events=[];service.subscribe(event=>events.push(event));
 const late=service.getPresence({userIds:['peer']});await new Promise(r=>setImmediate(r));service.stop();release({ok:true,observedAt:new Date().toISOString(),states:[{userId:'peer',presence:'offline',onlineUntil:null}]});await late;
 assert.deepEqual(events,[],'shutdown is silent and late results stay fenced');
 console.log('presence actual service lane, bootstrap, cache and stop fences: ok');
}finally{service.stop();rmSync(root,{recursive:true,force:true});}
