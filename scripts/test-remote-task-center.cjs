"use strict";
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {app,BrowserWindow}=require('electron');
if(!app?.whenReady)throw Error('Run with Electron');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'remote-task-center-'));
app.setPath('userData',path.join(temp,'data'));app.disableHardwareAcceleration();
let win;const timer=setTimeout(()=>finish(1),30000);
function finish(code){clearTimeout(timer);win?.destroy();fs.rmSync(temp,{recursive:true,force:true});app.exit(code);}
app.whenReady().then(async()=>{
  const renderer=path.join(__dirname,'../src/renderer');
  const markup=fs.readFileSync(path.join(renderer,'index.html'),'utf8');
  const page=path.join(temp,'test.html');fs.writeFileSync(page,`<!doctype html><link rel="stylesheet" href="${pathToFileURL(path.join(renderer,'styles.css')).href}"><body data-app-view="collaboration"></body>`);
  win=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{sandbox:true,contextIsolation:true}});await win.loadFile(page);
  const result=await win.webContents.executeJavaScript(`(async()=>{
    const real=new DOMParser().parseFromString(${JSON.stringify(markup)},'text/html');
    document.body.append(real.getElementById('collaborationCenter'));
    for(const id of ['collaborationPanelToggle','collaborationNavButton','workbenchNavButton','centerPanel']){const n=document.createElement('div');n.id=id;document.body.append(n);}
    const tasks=[];let local=[{conversationId:'old',taskId:'oldtask',applicationId:'app1',state:'applying',label:'Budget'}];
    window.assistantClient={collaboration:{onStateChange:()=>()=>{},getDirectory:async()=>({ok:true,profile:{userId:'self'},contacts:[],teams:[]}),
      getSocialCommands:async()=>({ok:true,commands:[]}),list:async()=>({ok:true,conversations:[{id:'chat',scopeId:'personal',kind:'direct',title:'Peer'}]}),
      getDraft:async()=>({ok:true,text:''}),saveDraft:async()=>({ok:true}),getTaskCommands:async()=>({ok:true,commands:[]}),listTasks:async()=>({ok:true,tasks:[]}),
      open:async(id,_before,options)=>options?.cached?{ok:false}:{ok:true,conversation:{id,title:'Peer',scopeId:'personal',kind:'direct'},messages:[]},
      taskWorkflow:async command=>{tasks.push(command);if(command.operation==='recoveries')return{ok:true,applications:local};if(command.operation==='rollback'){local=[];return{ok:true,state:'rolled_back'};}return{ok:true,drafts:[],applications:[]};},
    }};
    const {initCollaborationCenter}=await import(${JSON.stringify(pathToFileURL(path.join(renderer,'modules/collaboration-center.js')).href)});
    const tick=()=>new Promise(r=>setTimeout(r,40));const center=initCollaborationCenter({getPolicy:async()=>({collaboration:{enabled:true,tasks:true,workspaceShares:true}})});
    const click=selector=>{const el=document.querySelector(selector);if(!el)throw Error('Missing '+selector+' '+document.querySelector('.remote-tasks')?.textContent);el.click();};
    center.show();await tick();await center.open('chat');await tick();
    const entry=document.querySelector('[data-action="task-entry"]');
    const correct=entry?.closest('#collaborationConversation')!==null&&entry?.getClientRects().length>0;
    if(entry.scrollWidth>entry.clientWidth+1)throw Error('Task entry label overflows its clickable button');
    entry.click();await tick();const visible=document.querySelector('.remote-tasks')?.getClientRects().length>0;
    click('[data-action="task-back"]');
    document.getElementById('collaborationConversationBack').click();await tick();
    const recovery=document.querySelector('[data-action="task-local-recovery-entry"]');
    const discoverable=recovery?.getClientRects().length>0;recovery.click();await tick();
    const outside=document.querySelector('.remote-tasks').parentElement.id==='collaborationCenter'&&document.querySelector('.remote-tasks').getClientRects().length>0;
    click('[data-action="task-local-rollback"]');await tick();
    const rolled=tasks.some(c=>c.operation==='rollback'&&c.conversationId==='old');
    center.destroy();return{correct,visible,discoverable,outside,rolled};
  })()`);
  assert.deepEqual(result,{correct:true,visible:true,discoverable:true,outside:true,rolled:true});
  console.log('remote task center: actual index.html/CSS and center wiring expose task and revoked local recovery surfaces');finish(0);
}).catch(error=>{console.error(error);finish(1);});
