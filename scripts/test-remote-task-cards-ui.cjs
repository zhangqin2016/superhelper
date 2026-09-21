"use strict";
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const task=require('../server/src/services/collaboration/task-contract.cjs').createTask({id:'task',conversationId:'chat',assigneeUserId:'helper',inputSnapshotId:'object',title:'Budget review',objective:'Check totals',acceptanceCriteria:'Verified'},{actorUserId:'owner',authorizedParticipantIds:['owner','helper'],now:20});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'task-cards-ui-'));app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();
let win;const timeout=setTimeout(()=>finish(1),30000);
function finish(code){clearTimeout(timeout);win?.destroy();fs.rmSync(root,{recursive:true,force:true});app.exit(code);}
app.whenReady().then(async()=>{
 win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true}});
 const file=path.join(root,'test.html');fs.writeFileSync(file,'<!doctype html><body><header></header><section id="panel"></section><section id="timeline"></section>');await win.loadFile(file);
 await win.webContents.executeJavaScript(`(async()=>{
  const {initCenterRemoteTasks}=await import(${JSON.stringify(pathToFileURL(path.resolve('src/renderer/modules/collaboration-workspace-integration.js')).href)});
  const {renderCollaborationTimeline}=await import(${JSON.stringify(pathToFileURL(path.resolve('src/renderer/modules/collaboration-timeline.js')).href)});
  const {openWorkspaceTaskCard}=await import(${JSON.stringify(pathToFileURL(path.resolve('src/renderer/modules/workspace-collaboration-entry.js')).href)});
  const {setLocale}=await import(${JSON.stringify(pathToFileURL(path.resolve('src/renderer/i18n/index.js')).href)});await setLocale('en',{persist:false});
  const check=(x,s)=>{if(!x)throw Error(s);},settle=async()=>{for(let i=0;i<15;i++)await new Promise(r=>setTimeout(r,0));};
  let context={enabled:true,conversationId:'chat',userId:'owner'},rows=[{id:'draft',taskId:null,title:'<img src=x>',state:'preparing',createdAt:10,revision:0}],reads=0;
  let detailTask=${JSON.stringify(task)},integration=null,retries=0,releaseRetry,configurations=0,releaseChecks;
  const api={taskWorkflow:async command=>{
    if(command.operation==='cards')return {ok:true,cards:structuredClone(rows)};
    if(command.operation==='integrationStatus')return {ok:true,integration};
    if(command.operation==='configureIntegrationChecks'){
      check(JSON.stringify(Object.keys(command).sort())===JSON.stringify(['conversationId','deliveryId','operation','taskId']),'check selection carries only identities');
      configurations++;return new Promise(resolve=>{releaseChecks=resolve;});
    }
    if(command.operation==='retryIntegration'){
      check(JSON.stringify(Object.keys(command).sort())===JSON.stringify(['conversationId','deliveryId','operation','taskId']),'retry carries only identities');
      check(command.taskId==='task'&&command.deliveryId==='delivery'&&command.conversationId==='chat','retry targets original delivery');
      retries++;return new Promise(resolve=>{releaseRetry=resolve;});
    }
    return {ok:true,applications:[],drafts:[{id:'draft',state:'prepared',files:[]}]};
  },listTasks:async conversationId=>{check(typeof conversationId==='string','preload listTasks takes a conversation ID');reads++;return {ok:true,tasks:[]};},
    getTask:async()=>({ok:true,task:detailTask}),getTaskCommands:async()=>({ok:true,commands:[]}),
    getConversationDetails:async()=>({ok:true,members:[{userId:'owner'},{userId:'helper'}]}),
    getDirectory:async()=>({ok:true,profile:{userId:'owner'}}),list:async()=>({ok:true,conversations:[{id:'chat'}]})};
  window.assistantClient={collaboration:api,getAccountStatus:async()=>({loggedIn:true,user:{id:'owner'}})};
  const timeline=document.querySelector('#timeline');let ui;
  const draw=()=>renderCollaborationTimeline(timeline,[],{taskCards:ui?.cards?.() || [],onOpenTask:card=>ui.openCard(card)});
  let navigated='';
  ui=initCenterRemoteTasks({root:document.querySelector('#panel'),header:document.querySelector('header'),api:()=>api,getContext:()=>context,onCardsChange:draw,
    workspace:{getContext:()=>context,getPolicy:async()=>({collaboration:{enabled:true,tasks:true}}),load:async()=>{},activate(){},open:async id=>{navigated=id;context={...context,conversationId:id};}}});ui.update();await settle();
  check(reads>0,'cards refresh without ever opening the task panel');
  const card=timeline.querySelector('.collaboration-task-card');check(card,'pending card appears in conversation');check(!card.querySelector('img'),'title remains text');
  card.querySelector('button').click();await settle();check(document.querySelector('[data-action="task-send"]'),'pending card opens original draft form');
  rows=[{...rows[0],taskId:'task',state:'offered',revision:1}];ui.onChange();await settle();
  check(timeline.querySelectorAll('.collaboration-task-card').length===1&&timeline.firstElementChild===card,'ACK updates the original node');
  const opened=await openWorkspaceTaskCard({...rows[0],conversationId:'chat'});await settle();
  check(opened.ok&&navigated==='chat'&&document.querySelector('.remote-tasks').textContent.includes('Budget review'),'local card route opens actual authorized task detail');
  rows=[{...rows[0],state:'active',revision:2}];ui.onChange();await settle();check(card.dataset.revision==='2','progress updates same node');
  renderCollaborationTimeline(timeline,[{id:'m',seq:1,createdAt:20,bodyText:'Later message',senderUserId:'helper'}],{taskCards:ui.cards()});check(timeline.firstElementChild===card,'later messages preserve the original card position');
  detailTask={...detailTask,state:'review',revision:3,currentDeliveryId:'delivery',deliveries:[{id:'delivery',number:1,submittedAt:30}]};
  integration={stage:'failed',deliveryId:'delivery',canRetry:true};rows=[{...rows[0],state:'review',revision:3,integration}];ui.onChange();await settle();
  check(timeline.firstElementChild===card&&card.textContent.includes('Automatic integration failed'),'integration updates original conversation card');
  await openWorkspaceTaskCard({...rows[0],conversationId:'chat'});await settle();
  let retry=document.querySelector('[data-action="task-retry-integration"]');check(retry,'failed integration exposes retry');
  retry.click();retry.click();await settle();check(retries===1&&retry.disabled,'retry is single-flight');
  releaseRetry({ok:false});await settle();check(document.querySelector('.remote-task-integration').textContent.includes('Could not retry'),'failed retry remains visible');
  document.querySelector('[data-action="task-retry-integration"]').click();await settle();
  releaseRetry({ok:true,integration:{...integration,stage:'queued',canRetry:false}});await settle();
  check(document.querySelector('.remote-task-integration').textContent.includes('Integration queued')&&!document.querySelector('[data-action="task-retry-integration"]'),'successful retry shows queue without another action');
  integration={...integration,stage:'validation_required',canRetry:false};await openWorkspaceTaskCard({...rows[0],conversationId:'chat'});await settle();
  await setLocale('zh-CN',{persist:false});await settle();
  check(document.querySelector('.remote-task-integration').textContent.includes('等待验证')&&!document.querySelector('[data-action="task-retry-integration"]'),'missing validator is localized and not retryable');
  integration={...integration,canConfigureChecks:true,checkCount:0};await openWorkspaceTaskCard({...rows[0],conversationId:'chat'});await settle();
  for(const locale of ['en','zh-CN','ar']){await setLocale(locale,{persist:false});await settle();check(!document.querySelector('.remote-task-integration').textContent.includes('collaboration.task.'),'check selection localized '+locale);}
  await setLocale('en',{persist:false});await settle();
  check(document.querySelector('.remote-task-integration').textContent.includes('run project code'),'check selection explains automatic execution trust');
  const choose=document.querySelector('[data-action="task-configure-checks"]');choose.click();choose.click();await settle();check(configurations===1&&choose.disabled,'native check selection is single-flight');
  integration={...integration,checkCount:2};releaseChecks({ok:true,integration});await settle();
  check(document.querySelector('.remote-task-integration').textContent.includes('Pinned 2 check files'),'saved check count is visible');
  document.querySelector('[data-action="task-configure-checks"]').click();await settle();releaseChecks({ok:true,cancelled:true});await settle();
  check(document.querySelector('.remote-task-integration').textContent.includes('Pinned 2 check files'),'cancelled picker preserves installed checks');
  await setLocale('en',{persist:false});integration={...integration,stage:'publication_pending',canConfigureChecks:false};await openWorkspaceTaskCard({...rows[0],conversationId:'chat'});await settle();
  check(document.querySelector('.remote-task-integration').textContent.includes('waiting to sync'),'local publication is not labeled remotely synced');
  integration={...integration,stage:'failed',canRetry:true};await openWorkspaceTaskCard({...rows[0],conversationId:'chat'});await settle();document.querySelector('[data-action="task-retry-integration"]').click();await settle();
  context={...context,conversationId:'other'};rows=[];ui.update();await settle();check(!timeline.querySelector('.collaboration-task-card'),'navigation clears old card');
  releaseRetry({ok:true,integration:{...integration,stage:'queued'}});await settle();check(!document.querySelector('.remote-task-integration'),'late retry cannot repaint after navigation');
  let release;const normalRead=api.taskWorkflow;
  api.taskWorkflow=command=>command.operation==='cards'?new Promise(resolve=>{release=resolve;}):normalRead(command);
  ui.onChange();await settle();check(release,'pending read started');
  context={...context,enabled:false,userId:''};ui.update();await settle();check(ui.cards().length===0,'logout clears account-owned cards');
  release({ok:true,cards:[{id:'late',title:'Private previous account',state:'active',createdAt:10,revision:2}]});await settle();
  check(ui.cards().length===0&&!timeline.querySelector('.collaboration-task-card'),'late response cannot restore previous account cards');ui.destroy();
 })()`);
 console.log('task cards UI: original anchors, integration states/localization, identity-only single-flight retry/failure and navigation/logout fences passed');
}).then(()=>finish(0)).catch(error=>{console.error(error);finish(1);});
