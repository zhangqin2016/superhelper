"use strict";
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'task-cards-ui-'));app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();
let win;const timeout=setTimeout(()=>finish(1),30000);
function finish(code){clearTimeout(timeout);win?.destroy();fs.rmSync(root,{recursive:true,force:true});app.exit(code);}
app.whenReady().then(async()=>{
 win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true}});
 const file=path.join(root,'test.html');fs.writeFileSync(file,'<!doctype html><body><header></header><section id="panel"></section><section id="timeline"></section>');await win.loadFile(file);
 await win.webContents.executeJavaScript(`(async()=>{
  const {initCenterRemoteTasks}=await import(${JSON.stringify(pathToFileURL(path.resolve('src/renderer/modules/collaboration-workspace-integration.js')).href)});
  const {renderCollaborationTimeline}=await import(${JSON.stringify(pathToFileURL(path.resolve('src/renderer/modules/collaboration-timeline.js')).href)});
  const {setLocale}=await import(${JSON.stringify(pathToFileURL(path.resolve('src/renderer/i18n/index.js')).href)});await setLocale('en',{persist:false});
  const check=(x,s)=>{if(!x)throw Error(s);},settle=async()=>{for(let i=0;i<15;i++)await new Promise(r=>setTimeout(r,0));};
  let context={enabled:true,conversationId:'chat',userId:'owner'},rows=[{id:'draft',taskId:null,title:'<img src=x>',state:'preparing',createdAt:10,revision:0}],reads=0;
  const api={taskWorkflow:async command=>command.operation==='cards'?{ok:true,cards:structuredClone(rows)}:{ok:true,applications:[]},listTasks:async conversationId=>{check(typeof conversationId==='string','preload listTasks takes a conversation ID');reads++;return {ok:true,tasks:[]};}};
  const timeline=document.querySelector('#timeline');let ui;
  const draw=()=>renderCollaborationTimeline(timeline,[],{taskCards:ui?.cards?.() || []});
  ui=initCenterRemoteTasks({root:document.querySelector('#panel'),header:document.querySelector('header'),api:()=>api,getContext:()=>context,onCardsChange:draw});ui.update();await settle();
  check(reads>0,'cards refresh without ever opening the task panel');
  const card=timeline.querySelector('.collaboration-task-card');check(card,'pending card appears in conversation');check(!card.querySelector('img'),'title remains text');
  rows=[{...rows[0],taskId:'task',state:'offered',revision:1}];ui.onChange();await settle();
  check(timeline.querySelectorAll('.collaboration-task-card').length===1&&timeline.firstElementChild===card,'ACK updates the original node');
  rows=[{...rows[0],state:'active',revision:2}];ui.onChange();await settle();check(card.dataset.revision==='2','progress updates same node');
  renderCollaborationTimeline(timeline,[{id:'m',seq:1,createdAt:20,bodyText:'Later message',senderUserId:'helper'}],{taskCards:ui.cards()});check(timeline.firstElementChild===card,'later messages preserve the original card position');
  context={...context,conversationId:'other'};rows=[];ui.update();await settle();check(!timeline.querySelector('.collaboration-task-card'),'navigation clears old card');
  let release;const normalRead=api.taskWorkflow;
  api.taskWorkflow=command=>command.operation==='cards'?new Promise(resolve=>{release=resolve;}):normalRead(command);
  ui.onChange();await settle();check(release,'pending read started');
  context={...context,enabled:false,userId:''};ui.update();await settle();check(ui.cards().length===0,'logout clears account-owned cards');
  release({ok:true,cards:[{id:'late',title:'Private previous account',state:'active',createdAt:10,revision:2}]});await settle();
  check(ui.cards().length===0&&!timeline.querySelector('.collaboration-task-card'),'late response cannot restore previous account cards');ui.destroy();
 })()`);
 console.log('task cards UI: panel-independent load, pending/ACK node identity, progress, safe text, ordering and navigation/logout passed');
}).then(()=>finish(0)).catch(error=>{console.error(error);finish(1);});
