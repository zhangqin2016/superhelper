const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {pathToFileURL}=require('node:url');const {app,BrowserWindow,ipcMain}=require('electron');
const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'task-cached-transfer-ui-')));app.setPath('userData',path.join(temp,'data'));app.disableHardwareAcceleration();
let win,store,runtime;const timer=setTimeout(()=>finish(1),30000);
function finish(code){clearTimeout(timer);win?.destroy();try{runtime?.stop();store?.close();require('./lib/electron-test-cleanup.cjs')(temp);}catch(error){console.error(error);code=1;}app.exit(code);}
app.whenReady().then(async()=>{
  const {CollaborationStore}=require('../src/main/collaboration/collaboration-store');const {LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring');
  const {createTransferRuntime}=require('../src/main/collaboration/transfer-runtime');const {createTransferManifestStore}=require('../src/main/collaboration/transfer-manifest');
  const {createTaskRecords}=require('../src/main/collaboration/task-records');const {createTaskWorkflow}=require('../src/main/collaboration/task-workflow');const {createCollaborationIpc}=require('../src/main/ipc-collaboration');
  const keyring=new LocalCollaborationKeyring({filePath:path.join(temp,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
  store=new CollaborationStore({dbPath:path.join(temp,'db'),accountId:'owner',keyring});store.replaceProjectionFromBootstrap({conversations:[{id:'chat',kind:'direct'}]});
  const task={id:'task',conversationId:'chat',requesterUserId:'owner',assigneeUserId:'helper',inputSnapshotId:'input',title:'Budget',objective:'Review',acceptanceCriteria:'Correct',state:'accepted',revision:4,createdAt:1,updatedAt:2,deliveries:[{id:'delivery',number:1,submittedAt:2}],currentDeliveryId:'delivery',acceptedDeliveryId:'delivery'};
  let objectRequests=0,taskReads=0,opens=0,changes=0;const subscribers=new Set();
  const client={getTask:async()=>{taskReads++;return structuredClone(task);},objects:{init:async()=>{objectRequests++;throw Error('Unexpected upload');},downloadTicket:async()=>{objectRequests++;throw Error('Cached workflow must not redownload');}}};
  const rootPath=path.join(temp,'collaboration-transfer');runtime=createTransferRuntime({store,client,deviceId:'device',rootPath,policy:{enabled:true,attachments:true,workspaceShares:true,tasks:true},assertActive:()=>{},onChange:()=>{changes++;for(const callback of subscribers)callback({type:'transfer'});}});
  assert.equal(runtime.ok,true);
  const manifests=createTransferManifestStore({rootPath,accountId:'owner',keyring});
  const seed=(objectId,direction)=>{const item=manifests.create({conversationId:'chat',scopeId:'personal',purpose:'workspace',direction});return manifests.update({id:item.id,expectedRevision:item.revision,checkpoint:{state:direction==='upload'?'verified':'ready',deviceId:'device',objectId}}).id;};
  const ids=[seed('input','upload'),seed('delivery','download'),seed('ordinary','download')];
  const cached=path.join(temp,'snapshot');fs.mkdirSync(cached);
  const records=createTaskRecords({store,assertActive:()=>{}});records.put('task:task',{id:'task:task',kind:'task',taskId:'task',conversationId:'chat',sourceRoot:cached,workRoot:cached,snapshotRoot:cached,baseManifest:[],deliveries:{delivery:{snapshotRoot:cached,manifest:[]}}});
  const tasks={get:async()=>({ok:true,task:await client.getTask()}),list:async()=>({ok:true,tasks:[task]})};
  const workflow=createTaskWorkflow({store,client,tasks,transfers:runtime,deviceId:'device',assertActive:()=>{},rootPath:path.join(temp,'workspaces'),openWorkspace:()=>{opens++;return{projectId:'project',sessionId:'session'};}});
  const service={ok:true,getTransfers:()=>runtime.list(),listTasks:()=>tasks.list(),getTask:()=>tasks.get(),getTaskCommands:()=>({ok:true,commands:[]}),taskWorkflow:command=>workflow.run(command)};
  Object.assign(service,{getState:()=>({ok:true}),getDirectory:()=>({ok:true,profile:{userId:'owner'},contacts:[],teams:[]}),getSocialCommands:()=>({ok:true,commands:[]}),list:()=>({ok:true,conversations:[{id:'chat',scopeId:'personal',kind:'direct',title:'Helper'}]}),open:()=>({ok:true,conversation:{id:'chat',scopeId:'personal',kind:'direct',title:'Helper'},messages:[]}),getDraft:()=>({ok:true,text:''}),saveDraft:()=>({ok:true})});
  createCollaborationIpc({ipcMain,getService:()=>service,subscribeState:callback=>{subscribers.add(callback);return()=>subscribers.delete(callback);}});ipcMain.handle('session:focus',()=>({ok:true}));ipcMain.handle('notifications:get',()=>({ok:true}));ipcMain.handle('assistant:feature-flags',()=>({ok:true,flags:{}}));
  const renderer=path.join(__dirname,'../src/renderer'),page=path.join(temp,'index.html');fs.writeFileSync(page,`<!doctype html><link rel="stylesheet" href="${pathToFileURL(path.join(renderer,'styles.css')).href}"><body><div id="root"><header id="header"></header><button id="attach">Attach</button><div id="transfers"></div></div></body>`);
  win=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{contextIsolation:true,preload:path.join(__dirname,'../src/preload.js')}});await win.loadFile(page);
  await win.webContents.executeJavaScript(`(async()=>{const base=${JSON.stringify(pathToFileURL(renderer+'/').href)};document.body.replaceChildren();document.body.dataset.appView='collaboration';const real=new DOMParser().parseFromString(${JSON.stringify(fs.readFileSync(path.join(renderer,'index.html'),'utf8'))},'text/html');document.body.append(real.getElementById('collaborationCenter'));for(const id of ['collaborationPanelToggle','collaborationNavButton','workbenchNavButton','centerPanel']){const n=document.createElement('div');n.id=id;document.body.append(n);}await (await import(base+'i18n/index.js')).setLocale('en',{persist:false});const {initCollaborationCenter}=await import(base+'modules/collaboration-center.js');window.center=initCollaborationCenter({getPolicy:async()=>({collaboration:{enabled:true,attachments:true,workspaceShares:true,tasks:true}})});window.tick=()=>new Promise(r=>setTimeout(r,150));await tick();center.show();await tick();await center.open('chat');await tick();})()`);
  assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("[data-transfer-id]").length'),3,'legacy task and ordinary workspace rows initially indistinguishable');
  for(const action of ['task-delivery-open','task-receive']){
    if(action==='task-receive'){
      task.requesterUserId='helper';task.assigneeUserId='owner';task.state='active';task.acceptedDeliveryId=null;
      for(const id of ids.slice(0,2)){const item=manifests.read(id),{taskOwned,...checkpoint}=item.checkpoint;manifests.update({id,expectedRevision:item.revision,checkpoint});}
    }
    await win.webContents.executeJavaScript(`(async()=>{document.querySelector('[data-action=task-entry]').click();await tick();document.querySelector('[data-action=task-open]').click();await tick();const action=document.querySelector('[data-action=${action}]');if(!action)throw Error('Missing task action');action.click();await tick();await tick();})()`);
    const visible=await win.webContents.executeJavaScript('[...document.querySelectorAll("[data-transfer-id]")].map(el=>el.dataset.transferId)');
    assert.deepEqual(visible,[ids[2]],`${action} cached workflow must retrofit only its known input/delivery packages out of ordinary tray`);
    assert.equal(objectRequests,0,'cached workspaces need no object upload or download');
    if(action==='task-receive')await win.webContents.executeJavaScript("document.querySelector('[data-action=task-back]').click()");
  }
  assert.equal(opens,1);assert.ok(taskReads>=2,'explicit cached workflow access retains fresh task authorization');
  assert.equal(changes,2,'one transfer event per actual legacy retrofit, not per read');
  await workflow.run({operation:'open',conversationId:'chat',taskId:'task',deliveryId:'delivery'});assert.equal(changes,2,'already marked cached reopen emits no redundant change');
  await win.webContents.executeJavaScript('center.destroy()');
  for(const boundary of ['account','conversation']){
    let expired=false,registered=false;
    const guarded=createTaskWorkflow({store,client,tasks,deviceId:'device',rootPath:path.join(temp,'guarded'),assertActive:()=>{if(expired)throw Object.assign(Error('Stopped'),{code:'COLLABORATION_STOPPED'});},transfers:{taskFiles:{markOwned:async()=>{if(boundary==='account')expired=true;else store.db.run('DELETE FROM conversations WHERE account_id = ? AND id = ?','owner','chat');return{ok:false,code:'COLLAB_TRANSFER_UNAVAILABLE'};}}},openWorkspace:()=>{registered=true;return{projectId:'project',sessionId:'session'};}});
    const result=await guarded.run({operation:'open',conversationId:'chat',taskId:'task',deliveryId:'delivery'});
    assert.equal(registered,false,`${boundary} invalidated across cosmetic ownership await must prevent workspace registration`);assert.equal(result.ok,false);
  }
  console.log('cached task transfer UI: real workflow cache, encrypted legacy manifests, IPC and tray hide task objects only on explicit open/receive');finish(0);
}).catch(error=>{console.error(error);finish(1);});
