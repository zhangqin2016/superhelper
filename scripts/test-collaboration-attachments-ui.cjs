"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");
if (!app?.whenReady) { console.error("Run with Electron"); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-attachments-dom-"));
app.setPath("userData", path.join(dir, "data")); app.disableHardwareAcceleration();
let win;
const timer = setTimeout(() => { console.error("attachment UI timed out"); finish(1); }, 30000);
function finish(code) { clearTimeout(timer); win?.destroy(); fs.rmSync(dir, { recursive: true, force: true }); app.exit(code); }
app.whenReady().then(async () => {
  const filename = path.join(__dirname, "../src/renderer/modules/collaboration-attachments.js");
  assert.ok(fs.existsSync(filename), "attachment controls must exist as an independent renderer controller");
  const html = fs.readFileSync(path.join(__dirname, "../src/renderer/index.html"), "utf8");
  assert.match(html, /id="collaborationAttachButton"/, "actual collaboration shell exposes the native attachment picker");
  const page = path.join(dir, "index.html");
  fs.writeFileSync(page, '<!doctype html><button id="attach"></button><div id="attachments"></div><div id="timeline"></div>');
  win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadFile(page);
  const result = await win.webContents.executeJavaScript(`(async () => {
    const {initCollaborationAttachments} = await import(${JSON.stringify(pathToFileURL(filename).href)});
    const {renderCollaborationTimeline} = await import(${JSON.stringify(pathToFileURL(path.join(__dirname, "../src/renderer/modules/collaboration-timeline.js")).href)});
    const root=document.getElementById('attachments'),button=document.getElementById('attach'),timeline=document.getElementById('timeline');
    const calls=[];let list=[],releasePick,late=false,denied=false,recoveryFailureCount=0,unrecognizedCount=0;
    const upload={ok:true,id:'upload',conversationId:'conversation',direction:'upload',purpose:'attachment',state:'prepared',originalName:'<img src=x>.txt',totalBytes:120};
    const api={getTransfers:async()=>({ok:true,transfers:list,recoveryFailureCount,unrecognizedCount}),prepareAttachment:async(id)=>{calls.push(['pick',id]);if(late)return new Promise(r=>releasePick=r);list=[upload];return upload;},
      enqueueTransfer:async(id)=>{calls.push(['enqueue',id]);return {ok:true,state:'queued'};},pauseTransfer:async(id)=>{calls.push(['pause',id]);return {ok:true};},
      cancelTransfer:async(id)=>{calls.push(['cancel',id]);return {ok:false,code:'COLLAB_MESSAGE_CANCELLATION_REQUIRED'};},
      sendAttachments:async(input)=>{calls.push(['send',input]);list=[{...upload,sendState:'waiting_attachments',clientCommandId:'command'}];return {ok:true,state:'waiting_attachments',clientCommandId:'command'};},
      prepareDownload:async(input)=>{calls.push(['download',input]);list=[{ok:true,id:'download',conversationId:'conversation',direction:'download',purpose:'attachment',state:'prepared',objectId:'object'}];return list[0];},
      saveDownload:async(id)=>{calls.push(['save',id]);return denied?{ok:false,code:'COLLAB_ACCESS_REVOKED'}:{ok:true,saved:true};}};
    const controller=initCollaborationAttachments({root,attachButton:button,api});
    const settle=()=>new Promise(r=>setTimeout(r,20));
    controller.setConversation({id:'conversation',scopeId:'team:org',title:'Exact recipient'}, {attachments:true});await settle();
    button.click();await settle();
    const picked=calls.at(-1),noAutoUpload=!calls.some(c=>c[0]==='enqueue'),safe=!root.querySelector('img');
    const opener=root.querySelector('[data-action="send-selected"]');opener.focus();opener.click();await settle();
    root.querySelector('[name="attachmentCaption"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await settle();
    const escapeFocus=document.activeElement===opener&&!root.querySelector('[name="attachmentCaption"]');
    opener.click();await settle();
    const noSendBeforeConfirm=!calls.some(c=>c[0]==='send'),confirmation=root.querySelector('[role="dialog"],[role="alertdialog"]').textContent;
    root.querySelector('[name="attachmentCaption"]').value='caption';
    root.querySelector('[data-action="confirm-send"]').click();root.querySelector('[data-action="confirm-send"]')?.click();await settle();
    const sends=calls.filter(c=>c[0]==='send'),waiting=root.textContent.includes('waiting_attachments');
    list=[{...list[0],state:'uploading'}];await controller.refresh();const separateProgress=root.textContent.includes('uploading')&&root.textContent.includes('waiting_attachments');
    root.querySelector('[data-action="cancel-transfer"]').click();await settle();
    const cancellation=root.querySelector('[role="status"]').textContent;
    const deliveryStates=[];
    for(const sendState of ['failed','paused','cancellation_requested']) {
      list=[{...upload,state:'verified',sendState}];await controller.refresh();deliveryStates.push(root.querySelector('article').textContent);
    }
    const message={id:'message',conversationId:'conversation',seq:1,bodyText:'file',kind:'attachment',attachmentIds:['object']};
    renderCollaborationTimeline(timeline,[message],{onDownload:input=>controller.download(input)});
    timeline.querySelector('[data-action="download-attachment"]').click();await settle();
    const download=calls.find(c=>c[0]==='download'),enqueued=calls.find(c=>c[0]==='enqueue'),downloadCancel=!!root.querySelector('[data-action="cancel-transfer"]');
    list=[{...list[0],state:'ready',originalName:'result.txt'}];await controller.refresh();
    root.querySelector('[data-action="save-download"]').click();await settle();const saved=root.querySelector('[role="status"]').textContent;
    denied=true;root.querySelector('[data-action="save-download"]').click();await settle();const rejected=root.querySelector('[role="status"]').textContent;
    renderCollaborationTimeline(timeline,[{...message,revokedAt:'now',attachmentIds:[]}],{onDownload:input=>controller.download(input)});
    const revokedCleared=!timeline.querySelector('[data-action="download-attachment"]');
    list=[];recoveryFailureCount=1;await controller.refresh();const recoveryWarning=root.textContent.includes('recoveryBlocked');
    recoveryFailureCount=0;unrecognizedCount=1;await controller.refresh();const unknownWarning=root.textContent.includes('recoveryBlocked');
    unrecognizedCount=0;await controller.refresh();const clearedRecoveryWarning=!root.textContent.includes('recoveryBlocked');
    late=true;button.click();await settle();controller.reset();releasePick(upload);await settle();
    const resetSafe=button.disabled&&!root.textContent.includes('<img src=x>');
    controller.setConversation({id:'conversation',scopeId:'personal'}, {attachments:false});await settle();const disabled=button.hidden;
    controller.destroy();
    const {initCollaborationCenter}=await import(${JSON.stringify(pathToFileURL(path.join(__dirname, "../src/renderer/modules/collaboration-center.js")).href)});
    const parsed=new DOMParser().parseFromString(${JSON.stringify(html)},'text/html');
    document.body.replaceChildren();const shell=document.createElement('div');shell.id='centerPanel';document.body.append(shell);
    for(const id of ['collaborationNavButton','collaborationCenter','collaborationLive']) {const original=parsed.getElementById(id);if(original)shell.append(original);}
    let publish;late=false;list=[];
    window.assistantClient={collaboration:{...api,getState:async()=>({ok:true}),list:async()=>({ok:true,conversations:[{id:'conversation'}]}),
      open:async()=>({ok:true,conversation:{id:'conversation',scopeId:'personal',title:'Recipient'},messages:[message]}),getDraft:async()=>({ok:true,text:''}),
      onStateChange:cb=>{publish=cb;return()=>{};}}};
    let enabledAttachments=true;
    const center=initCollaborationCenter({getPolicy:async()=>({collaboration:{enabled:true,attachments:enabledAttachments}})});await settle();await center.open('conversation');await settle();
    document.getElementById('collaborationAttachButton').click();await settle();
    const wired=document.getElementById('collaborationTransfers').textContent.includes('<img src=x>.txt')&&!!document.querySelector('#collaborationTimeline [data-action="download-attachment"]');
    document.querySelector('#collaborationTransfers [data-action="send-selected"]').click();await settle();
    const oldConfirm=document.querySelector('#collaborationTransfers [data-action="confirm-send"]'),beforePolicy=calls.filter(c=>c[0]==='send').length;
    const oldDownload=document.querySelector('#collaborationTimeline [data-action="download-attachment"]'),beforeDownloads=calls.filter(c=>c[0]==='download').length;
    enabledAttachments=false;await center.refresh();oldConfirm.click();oldDownload.click();await settle();
    const policyFenced=document.getElementById('collaborationAttachButton').hidden&&calls.filter(c=>c[0]==='send').length===beforePolicy;
    const downloadPolicyFenced=!document.querySelector('#collaborationTimeline [data-action="download-attachment"]')&&calls.filter(c=>c[0]==='download').length===beforeDownloads;
    enabledAttachments=true;await center.refresh();await center.open('conversation');await settle();list=[];await center.open('conversation');await settle();
    late=true;document.getElementById('collaborationAttachButton').click();await settle();center.hide();releasePick(upload);await settle();
    const lateHidden=!document.getElementById('collaborationTransfers').textContent.includes('<img src=x>.txt');late=false;
    publish({type:'availability',state:{ok:false}});await settle();const shellReset=!document.getElementById('collaborationTransfers').textContent.includes('<img src=x>.txt');center.destroy();
    return {picked,noAutoUpload,safe,noSendBeforeConfirm,confirmation,sends,waiting,cancellation,deliveryStates,recoveryWarning,unknownWarning,clearedRecoveryWarning,download,enqueued,saved,rejected,revokedCleared,resetSafe,disabled,wired,shellReset,separateProgress,downloadCancel,policyFenced,lateHidden,downloadPolicyFenced,escapeFocus};
  })()`);
  assert.deepEqual(result.picked,["pick","conversation"]);assert.equal(result.noAutoUpload,true);assert.equal(result.safe,true);
  assert.equal(result.noSendBeforeConfirm,true);assert.match(result.confirmation,/Exact recipient/);assert.match(result.confirmation,/team:org/);
  assert.equal(result.sends.length,1);assert.deepEqual(result.sends[0][1],{conversationId:"conversation",transferIds:["upload"],bodyText:"caption"});
  assert.equal(result.waiting,true);assert.match(result.cancellation,/messageCancellation/);
  assert.match(result.deliveryStates[0],/message_failed/,"verified file is not a delivered message when its outbox failed");
  assert.match(result.deliveryStates[1],/message_paused/,"message pause must not be mistaken for upload pause");
  assert.match(result.deliveryStates[2],/cancellation_requested/,"pending message cancellation is not a cancelled transfer");
  assert.equal(result.recoveryWarning,true,"missing linked manifest cannot become silent waiting with an empty list");
  assert.equal(result.unknownWarning,true,"unrecognized journals show a generic warning without exposing files or other scopes");
  assert.equal(result.clearedRecoveryWarning,true,"repaired journals clear the recovery warning");
  assert.deepEqual(result.download,["download",{conversationId:"conversation",messageId:"message",objectId:"object"}]);assert.deepEqual(result.enqueued,["enqueue","download"]);
  assert.match(result.saved,/saved/);assert.match(result.rejected,/permissionDenied/);assert.equal(result.revokedCleared,true);assert.equal(result.resetSafe,true);assert.equal(result.disabled,true);
  assert.equal(result.wired,true,"real HTML and center controller connect picker and message download");assert.equal(result.shellReset,true,"account reset clears attachment metadata in the shell");
  assert.equal(result.policyFenced,true,"policy change invalidates even detached old confirmation controls");assert.equal(result.lateHidden,true,"late native picker cannot refill a hidden view");
  assert.equal(result.separateProgress,true,"message wait and upload progress remain independently visible");assert.equal(result.downloadCancel,true,"download has its own cancel control");
  assert.equal(result.downloadPolicyFenced,true,"disabled attachment policy removes download and fences old detached button callbacks");
  assert.equal(result.escapeFocus,true,"Escape dismisses confirmation and restores the keyboard opener");
  console.log("collaboration attachments actual Electron DOM: confirmation, safe metadata, download/save, revocation and late-account fences passed");
}).then(()=>finish(0)).catch(error=>{console.error(error);finish(1);});
