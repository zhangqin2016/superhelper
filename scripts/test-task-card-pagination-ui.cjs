const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {pathToFileURL}=require('node:url');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'card-pagination-'));app.setPath('userData',path.join(tmp,'profile'));app.disableHardwareAcceleration();
const {CollaborationStore}=require('../src/main/collaboration/collaboration-store');
const {LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring');
const {createTaskCards}=require('../src/main/collaboration/task-cards');
const {createTaskRecords}=require('../src/main/collaboration/task-records');
const {createTaskWorkflow}=require('../src/main/collaboration/task-workflow');
const {taskWorkflowResult}=require('../src/main/collaboration/task-workflow-view');
const {createTask}=require('../server/src/services/collaboration/task-contract.cjs');
let win,store;const timer=setTimeout(()=>finish(1),60000);
function finish(code){clearTimeout(timer);win?.destroy();store?.close();fs.rmSync(tmp,{recursive:true,force:true});app.exit(code);}
app.whenReady().then(async()=>{
 const keyring=new LocalCollaborationKeyring({filePath:path.join(tmp,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
 store=new CollaborationStore({dbPath:path.join(tmp,'db'),accountId:'owner',keyring});store.replaceProjectionFromBootstrap({watermark:0,conversations:[{id:'chat',kind:'direct'}]});
 const cards=createTaskCards({store,assertActive(){}}),records=createTaskRecords({store,assertActive(){}});
 const add=i=>cards.remember(createTask({id:`task_${i}`,sharedWorkspaceId:'shared',conversationId:'chat',assigneeUserId:'helper',inputSnapshotId:`object_${i}`,title:`Task ${i}`,objective:'Review',acceptanceCriteria:'Checked'},{actorUserId:'owner',authorizedParticipantIds:['owner','helper'],now:i}));
 for(let i=1;i<=1150;i++)add(i);
 records.put('workspace',{kind:'workspace-binding',conversationId:'chat',projectId:'project',sessionId:'origin',deviceId:'device',sharedWorkspaceId:'shared'});
 const workflow=createTaskWorkflow({store,client:{},tasks:{},transfers:{},deviceId:'device',assertActive(){},rootPath:path.join(tmp,'managed'),resolveCardSession:id=>id==='origin'?{sessionId:id,projectId:'project'}:null});
 ipcMain.handle('test:cards',async(_event,command)=>taskWorkflowResult(await workflow.run(command)));
 ipcMain.handle('test:add',()=>add(1151));
 const preload=path.join(tmp,'preload.cjs');fs.writeFileSync(preload,"const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixture',{cards:c=>ipcRenderer.invoke('test:cards',c),add:()=>ipcRenderer.invoke('test:add')});");
 const base=pathToFileURL(path.resolve('src/renderer')+'/').href,file=path.join(tmp,'test.html');fs.writeFileSync(file,`<!doctype html><link rel="stylesheet" href="${base}styles.css"><body><section id="im" class="collaboration-center" style="height:350px;overflow:auto"></section><section id="local" class="session-task-cards"></section></body>`);
 win=new BrowserWindow({show:false,width:900,height:800,webPreferences:{contextIsolation:true,preload}});await win.loadFile(file);
 await win.webContents.executeJavaScript(`(async()=>{
  const base=${JSON.stringify(base)},check=(x,s)=>{if(!x)throw Error(s);};
  const wait=async fn=>{for(let i=0;i<300;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI condition timed out');};
  const {createTaskCardController}=await import(base+'modules/collaboration-task-cards.js');
  const {renderCollaborationTimeline}=await import(base+'modules/collaboration-timeline.js');
  const {initSessionTaskCards}=await import(base+'modules/session-task-cards.js');
  const {setLocale}=await import(base+'i18n/index.js');await setLocale('en',{persist:false});
  let context={enabled:true,userId:'owner',conversationId:'chat'},listener,failMore=false,pauseMore=false,releasePage;
  const api={taskWorkflow:async command=>{if(failMore&&command.before){failMore=false;throw Error('temporary local read failure');}const result=await window.fixture.cards(command);if(pauseMore&&command.before){pauseMore=false;return new Promise(resolve=>{releasePage=()=>resolve(result);});}return result;},listTasks:async()=>({ok:false}),onStateChange:fn=>(listener=fn,()=>{})};
  const client={collaboration:api,getAccountStatus:async()=>({loggedIn:context.enabled,user:{id:'owner'}})};
  const im=document.querySelector('#im'),local=document.querySelector('#local');let controller;
  const draw=()=>renderCollaborationTimeline(im,[],{taskCards:controller?.cards()||[],taskCardPagination:controller?.pagination()});
  controller=createTaskCardController({api:()=>api,getContext:()=>context,onChange:draw});controller.update();
  const session=initSessionTaskCards({root:local,sessionId:'origin',client:()=>client,onOpen:async()=>({ok:true})});session.setActive(true);
  for(const root of [im,local]) {
    await wait(()=>root.querySelectorAll('.collaboration-task-card').length===100);
    const newest=root.querySelector('[data-card-id="task_1150"]');check(newest,'initial page contains newest card');
    failMore=true;root.querySelector('.task-card-pager button').click();
    await wait(()=>root.querySelector('.task-card-pager button')?.textContent==='Retry earlier tasks');
    check(root.querySelectorAll('.collaboration-task-card').length===100,'failed page preserves loaded cards');
    pauseMore=true;releasePage=null;root.querySelector('.task-card-pager button').click();await wait(()=>releasePage);
    if(root===im)controller.refresh();else listener({type:'task'});
    releasePage();await wait(()=>root.querySelectorAll('.collaboration-task-card').length===200);
    while(root.querySelector('.task-card-pager button')) {
      const before=root.querySelectorAll('.collaboration-task-card').length;root.querySelector('.task-card-pager button').click();
      await wait(()=>root.querySelectorAll('.collaboration-task-card').length>before);
    }
    check(root.querySelectorAll('.collaboration-task-card').length===1150,'all cards beyond 1000 are reachable');
    check(root.querySelector('[data-card-id="task_1150"]')===newest,'loading older cards preserves original DOM node');
  }
  await window.fixture.add();controller.refresh();listener({type:'task'});
  await wait(()=>im.querySelectorAll('.collaboration-task-card').length===1151&&local.querySelectorAll('.collaboration-task-card').length===1151);
  check(im.querySelector('[data-card-id="task_1"]')&&local.querySelector('[data-card-id="task_1"]'),'new task refresh retains oldest loaded anchors');
  context={...context,enabled:false};controller.update();listener({type:'availability'});
  await wait(()=>!im.querySelector('.collaboration-task-card')&&!local.querySelector('.collaboration-task-card'));
  controller.destroy();session.destroy();
 })()`);
 console.log('task card pagination: actual IPC/SQLite and both Electron surfaces, 1150 cards, failed-page retry, stable nodes, new-task refresh and logout passed');
}).then(()=>finish(0)).catch(error=>{console.error(error);finish(1);});
