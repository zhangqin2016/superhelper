"use strict";
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {pathToFileURL}=require('node:url');const {app,BrowserWindow}=require('electron');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lily-im-layout-'));app.setPath('userData',path.join(dir,'data'));app.disableHardwareAcceleration();let win;
const timer=setTimeout(()=>finish(1),30000);function finish(code){clearTimeout(timer);win?.destroy();fs.rmSync(dir,{recursive:true,force:true});app.exit(code);}
app.whenReady().then(async()=>{
 const root=path.resolve(__dirname,'../src/renderer');const base=pathToFileURL(root+'/').href;
 let html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace('<head>','<head><base href="'+base+'">');
 const filename=path.join(dir,'index.html');fs.writeFileSync(filename,html);
 win=new BrowserWindow({show:false,width:1200,height:820,webPreferences:{sandbox:true,contextIsolation:true}});await win.loadFile(filename,{query:{view:'collaboration'}});
 await win.webContents.executeJavaScript(`(async()=>{
 const {setLocale}=await import('${base}i18n/index.js');await setLocale('zh-CN',{persist:false});
 document.documentElement.dataset.theme='dark';
 const {initCollaborationPanelShell}=await import('${base}modules/collaboration-panel-shell.js');initCollaborationPanelShell().setConversationOpen(true);
 document.querySelector('.collaboration-rail-tab').setAttribute('aria-pressed','true');document.getElementById('collaborationStatus').classList.add('is-available');document.getElementById('collaborationConversationEmpty').hidden=true;
 document.getElementById('collaborationConversationTitle').textContent='产品讨论组';document.getElementById('collaborationScopeBadge').textContent='4 位成员';document.getElementById('collaborationConversationInfo').hidden=false;
 const {renderCollaborationInbox}=await import('${base}modules/collaboration-inbox.js');
 const now=Date.now();renderCollaborationInbox(document.getElementById('collaborationInbox'),['产品讨论组','设计协作','小林','项目交付','技术交流'].map((title,i)=>({id:'c'+i,title,scopeId:'personal',kind:i===2?'direct':'group',lastSeq:10-i,updatedAt:now-i*3600000,lastMessage:{text:['图片和文档都放在这里','明天下午一起确认','好的，收到','交付清单已经更新','文件上传完成'][i]},unreadCount:i===1?3:0})),{activeConversationId:'c0'});
 const {renderCollaborationTimeline}=await import('${base}modules/collaboration-timeline.js');
 const msgs=[['peer','新版界面我们在这里一起确认。'],['me','收到，文字、图片和文件都可以在这里发送。'],['peer','我把交付文档发你。'],['peer',''],['me','好，我看一下，稍后在群里反馈。']].map(([senderUserId,bodyText],i)=>({id:'m'+i,conversationId:'c0',senderUserId,bodyText,seq:i+1,createdAt:now-300000+i*30000,state:'persisted',...(i===3?{kind:'attachment',attachmentIds:['pdf'],attachments:[{objectId:'pdf',originalName:'产品交付说明.pdf',sizeBytes:234560,mimeType:'application/pdf'}]}:{})}));
 renderCollaborationTimeline(document.getElementById('collaborationTimeline'),msgs,{currentUserId:'me',resolveSender:id=>id==='me'?'我':'小林',showSenderNames:true,onDownload:()=>{}});
 const {initCollaborationAttachments}=await import('${base}modules/collaboration-attachments.js');const upload={id:'draft',direction:'upload',purpose:'attachment',conversationId:'c0',originalName:'项目资料.zip',totalBytes:3456123,state:'prepared'};
 const files=initCollaborationAttachments({root:document.getElementById('collaborationTransfers'),attachButton:document.getElementById('collaborationAttachButton'),composerMode:true,api:{getTransfers:async()=>({ok:true,transfers:[upload]})}});files.setConversation({id:'c0'},{attachments:true});await files.refresh();
 document.getElementById('collaborationComposer').value='这份是整理好的项目资料。';document.getElementById('collaborationSendButton').disabled=false;
 })()`);
 for(const theme of ['dark','light']){
  await win.webContents.executeJavaScript(`document.documentElement.dataset.theme='${theme}'`);await new Promise(r=>setTimeout(r,100));
  const checks=await win.webContents.executeJavaScript(`(()=>{const q=s=>document.querySelector(s),r=s=>q(s).getBoundingClientRect();return {headerHidden:getComputedStyle(q('.collaboration-panel-header')).display==='none',ownAvatar:getComputedStyle(q('.is-outgoing .collaboration-message-avatar')).display!=='none',green:getComputedStyle(q('.is-outgoing .collaboration-message-bubble')).backgroundColor,bodyFits:document.documentElement.scrollWidth<=innerWidth,listWidth:r('.collaboration-home').width,inputInside:r('.collaboration-composer').bottom<=innerHeight+1,transfersInside:q('.collaboration-composer').contains(q('#collaborationTransfers')),noCheckbox:!q('#collaborationTransfers input[type=checkbox]')};})()`);
  assert.equal(checks.headerHidden,true);assert.equal(checks.ownAvatar,true);assert.equal(checks.bodyFits,true);assert.equal(checks.inputInside,true);assert.equal(checks.transfersInside,true);assert.equal(checks.noCheckbox,true);assert.equal(Math.round(checks.listWidth),344);assert.equal(checks.green,theme==='dark'?'rgb(45, 204, 140)':'rgb(149, 236, 105)');
  fs.writeFileSync(path.join(os.tmpdir(),'lily-im-desktop-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
 }
 win.setSize(720,700);await new Promise(r=>setTimeout(r,100));
 const narrow=await win.webContents.executeJavaScript(`({fits:document.documentElement.scrollWidth<=innerWidth,inputFits:document.querySelector('.collaboration-composer').getBoundingClientRect().bottom<=innerHeight+1})`);assert.deepEqual(narrow,{fits:true,inputFits:true});
 console.log('Desktop IM: real markup, dark/light layout, avatars, compact draft cards and viewport bounds passed');finish(0);
}).catch(e=>{console.error(e);finish(1);});
