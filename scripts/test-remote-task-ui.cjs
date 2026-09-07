"use strict";
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
if(!app?.whenReady)throw new Error('Run with Electron');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-task-ui-'));
app.setPath('userData',path.join(dir,'data'));app.disableHardwareAcceleration();
let win;const deadline=setTimeout(()=>finish(1),45000);
function finish(code){clearTimeout(deadline);win?.destroy();fs.rmSync(dir,{recursive:true,force:true});app.exit(code);}
app.whenReady().then(async()=>{
  win=new BrowserWindow({show:false,width:1100,height:820,webPreferences:{nodeIntegration:false,contextIsolation:true}});
  const fixture=path.join(dir,'fixture.html');
  fs.writeFileSync(fixture,`<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.resolve('src/renderer/styles.css')).href}"></head><body></body></html>`);
  await win.loadFile(fixture);
  await win.webContents.executeJavaScript(`(async()=>{
    const {initRemoteTasks}=await import(${JSON.stringify(pathToFileURL(path.resolve('src/renderer/modules/collaboration-remote-tasks.js')).href)});
    const {setLocale}=await import(${JSON.stringify(pathToFileURL(path.resolve('src/renderer/i18n/index.js')).href)});
    await setLocale('zh-CN',{persist:false});
    document.body.replaceChildren();document.documentElement.dataset.theme='light';
    const shell=document.createElement('div');shell.className='collaboration-center';shell.style='display:block;width:100%;height:100vh';document.body.append(shell);
    const root=document.createElement('section');root.className='collaboration-conversation';root.style='display:flex;height:100%;position:relative';shell.append(root);
    const header=document.createElement('header');header.className='collaboration-conversation-header';root.append(header);
    const draft=document.createElement('textarea');draft.value='保留我的聊天草稿';root.append(draft);
    const check=(x,s)=>{if(!x)throw new Error(s);};const tick=()=>new Promise(r=>setTimeout(r,0));
    const settle=async()=>{for(let i=0;i<8;i++)await tick();};
    const until=async(predicate,label)=>{for(let i=0;i<150;i++){if(predicate())return;await tick();}throw new Error(label);};
    let context={enabled:true,conversationId:'chat',userId:'owner'}, mode='normal',hold,commands=[],pending=[];
    let task={id:'task',conversationId:'chat',requesterUserId:'owner',assigneeUserId:'helper',title:'核查年度预算与最终交付成果',objective:'核对各部门数据，标明差异。<img src=x onerror=alert(1)>',acceptanceCriteria:'总额与分项一致，并提供核查记录。',state:'review',revision:3,currentDeliveryId:'v1',acceptedDeliveryId:null,deliveries:[{id:'v1',number:1,submittedAt:1000}],updatedAt:1000};
    const api={listTasks:async()=>{if(mode==='hold')await new Promise(r=>hold=r);if(mode==='fail')return{ok:false};return{ok:true,tasks:[{...task}]};},getTask:async()=>({ok:true,task:{...task}}),getTaskCommands:async()=>({ok:true,commands:pending}),
      changeTask:async c=>{commands.push(c);pending=[{ok:true,taskId:'task',clientCommandId:'stable',state:'confirming'}];return{ok:true,state:'confirming',clientCommandId:'stable'};},
      retryTask:async id=>{check(id==='stable','retry retains durable identity');pending=[];task={...task,state:'changes_requested',revision:4,reason:'请复核第二项'};return{ok:true,state:'completed',clientCommandId:id};}};
    const ui=initRemoteTasks({root,header,api:()=>api,getContext:()=>context,resolveName:id=>id==='owner'?'我':'林悦'});
    ui.update();check(document.querySelector('[data-action="task-entry"]'),'entry exists');check(root.querySelector('.remote-tasks').hidden,'default collapsed');
    document.querySelector('[data-action="task-entry"]').click();await settle();
    check(root.querySelectorAll('.remote-task-card').length===1,'one stable card per task');
    root.querySelector('[data-action="task-open"]').click();await settle();
    check(!root.querySelector('.remote-tasks img'),'untrusted task text is not HTML');
    check(root.textContent.includes('<img'),'raw markup is visible as text');
    check(root.querySelector('[data-action="request_changes"]'),'requester review controls');
    root.querySelector('[data-action="request_changes"]').click();
    const editing=root.querySelector('.remote-task-reason');editing.focus();
    ui.onChange();check(root.querySelector('.remote-task-change-notice'),'remote update does not discard an in-progress review');
    check(root.querySelector('.remote-task-reason')===editing&&document.activeElement===editing,'update preserves textarea identity and typing focus');
    const confirm=root.querySelector('[data-action="task-confirm"]');check(confirm.disabled,'empty reason blocked');
    const reason=root.querySelector('.remote-task-reason');reason.value='请复核第二项';reason.dispatchEvent(new Event('input'));check(!confirm.disabled,'reason enables confirmation');
    confirm.click();confirm.click();await settle();check(commands.length===1,'double click submits one intent');
    check(commands[0].deliveryId==='v1'&&commands[0].expectedRevision===3,'review binds exact inspected version');
    check(root.querySelector('[data-action="task-retry"]'),'unknown outcome has same-intent recovery');
    root.querySelector('[data-action="task-retry"]').click();await until(()=>root.textContent.includes('待修改'),'confirmed server state arrives');
    check(root.textContent.includes('待修改'),'confirmed change rereads server state: '+root.textContent);
    check(draft.value==='保留我的聊天草稿','chat draft untouched');
    mode='fail';root.querySelector('[data-action="task-back"]').click();await settle();await setLocale('en',{persist:false});
    check(!root.querySelector('[data-action="cancel"]'),'locale change must not resurrect a failed-read task or its actions');
    mode='normal';await setLocale('zh-CN',{persist:false});
    root.querySelector('.remote-tasks').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));check(root.querySelector('.remote-tasks').hidden,'Escape closes');check(!draft.inert,'closing restores chat');
    mode='hold';document.querySelector('[data-action="task-entry"]').click();await settle();context={...context,conversationId:'other'};ui.update();hold();await settle();check(root.querySelector('.remote-tasks').hidden,'late read cannot reopen another conversation');
    context={enabled:false,conversationId:'chat',userId:'owner'};ui.update();check(root.querySelector('[data-action="task-entry"]').hidden,'disabled feature leaves IM baseline');
    mode='normal';context={enabled:true,conversationId:'chat',userId:'helper'};task={...task,state:'offered',revision:1,deliveries:[],currentDeliveryId:null};ui.update();
    root.querySelector('[data-action="task-entry"]').click();await settle();root.querySelector('[data-action="task-open"]').click();await settle();
    check(root.querySelector('[data-action="accept"]')&&!root.querySelector('[data-action="approve"]'),'recipient sees only own actions');
    for(const locale of ['zh-CN','en','ar']){await setLocale(locale,{persist:false});await settle();check(!root.textContent.includes('collaboration.task.'),'all task labels translated');}
    await setLocale('zh-CN',{persist:false});
    task={...task,state:'review',revision:3,reason:undefined,objective:'核对各部门数据，标明差异，并附上复核记录。',deliveries:[{id:'v1',number:1,submittedAt:1000}],currentDeliveryId:'v1'};context={...context,userId:'owner'};ui.update();
    root.querySelector('[data-action="task-entry"]').click();await settle();root.querySelector('[data-action="task-open"]').click();await settle();
    window.taskUiTest={ui,root};
  })()`);
  for(const [theme,width] of [['light',1100],['dark',1100],['light',420],['dark',420]]){
    win.setSize(width,820);await win.webContents.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    await new Promise(r=>setTimeout(r,60));
    const overflow=await win.webContents.executeJavaScript(`(()=>{const e=document.querySelector('.remote-tasks');return e.scrollWidth>e.clientWidth+1;})()`);
    if(overflow)throw new Error(`${theme}/${width} horizontal overflow`);
    const png=await win.webContents.capturePage();fs.writeFileSync(path.join(dir,`${theme}-${width}.png`),png.toPNG());
  }
  // Optional screenshot artifacts are test outputs, never production demo data.
  if(process.env.REMOTE_TASK_SCREENSHOTS)for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.png')))fs.copyFileSync(path.join(dir,file),path.join(process.env.REMOTE_TASK_SCREENSHOTS,`remote-task-${file}`));
  await win.webContents.executeJavaScript('window.taskUiTest.ui.destroy()');
  console.log('remote task UI: real Electron states, recovery, roles, navigation, three locales and four theme/width checks passed (controlled API)');
}).then(()=>finish(0)).catch(e=>{console.error(e);finish(1);});
