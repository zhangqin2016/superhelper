"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {app,BrowserWindow} = require("electron");
const {exitAndRemove}=require("./electron-test-cleanup.cjs");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"collab-composer-files-"));
app.setPath("userData",path.join(dir,"data"));app.disableHardwareAcceleration();let win;
const timer=setTimeout(()=>finish(1),30000);
function finish(code){exitAndRemove({app,window:win,directory:dir,timer,code});}
app.whenReady().then(async()=>{
 const page=path.join(dir,"index.html");fs.writeFileSync(page,'<button id="attach"></button><div id="files"></div><textarea id="text"></textarea><button id="send"></button>');
 win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});await win.loadFile(page);
 const modules=pathToFileURL(path.resolve(__dirname,"../src/renderer/modules/")).href;
 const result=await win.webContents.executeJavaScript(`(async()=>{
 const {initCollaborationAttachments}=await import('${modules}/collaboration-attachments.js');
 const {initCollaborationComposer}=await import('${modules}/collaboration-composer.js');
 let rows=[],calls=[],savedDrafts=[],denied=false;const wait=()=>new Promise(r=>setTimeout(r,25));
 const api={getTransfers:async()=>({ok:true,transfers:rows}),prepareAttachment:async(id)=>{const row={ok:true,id:'f'+rows.length,conversationId:id,purpose:'attachment',direction:'upload',state:'prepared',originalName:'report.pdf',totalBytes:2048};rows.push(row);return row;},sendAttachments:async(input)=>{calls.push(input);if(denied)return {ok:false,code:'UNAVAILABLE'};rows=rows.map(r=>input.transferIds.includes(r.id)?{...r,sendState:'waiting_attachments'}:r);return {ok:true,state:'waiting_attachments'};},saveDraft:async(input)=>{savedDrafts.push(input);return {ok:true};},getDraft:async()=>({ok:true,text:''}),send:async()=>({ok:true})};window.assistantClient={collaboration:api};
 let composer;const files=initCollaborationAttachments({root:document.getElementById('files'),attachButton:document.getElementById('attach'),api,composerMode:true,onDraftChange:()=>composer?.refreshAttachments()});
 composer=initCollaborationComposer({textarea:document.getElementById('text'),sendButton:document.getElementById('send'),attachmentDraft:files});
 files.setConversation({id:'a'},{attachments:true});composer.setConversation('a');await wait();
 document.getElementById('attach').click();await wait();
 const picked={canSend:!document.getElementById('send').disabled,noUpload:calls.length===0,noCheckbox:!document.querySelector('input[type=checkbox]'),noManualUpload:!document.querySelector('[data-action=resume-transfer]')};
 document.getElementById('text').value='caption';document.getElementById('send').click();document.getElementById('send').click();await wait();
 const sent={count:calls.length,input:calls[0],cleared:document.getElementById('text').value==='',persistedClear:savedDrafts.some(d=>d.conversationId==='a'&&d.text==='')};
 document.getElementById('attach').click();await wait();denied=true;document.getElementById('text').value='keep me';document.getElementById('send').click();await wait();
 const retained=files.hasDraft()&&document.getElementById('text').value==='keep me';
 files.setConversation({id:'b'},{attachments:true});composer.setConversation('b');await wait();const isolated=!files.hasDraft()&&document.getElementById('send').disabled;
 files.setPolicy({attachments:false});await wait();const fenced=!files.hasDraft();
 rows=[{id:'image',objectId:'image-object',conversationId:'b',purpose:'attachment',direction:'download',state:'ready'}];
 let releasePreview;api.resolveTransferPreview=()=>new Promise(resolve=>{releasePreview=resolve;});files.setPolicy({attachments:true});await wait();
 const pending=files.resolvePreview('image-object');files.setConversation({id:'c'},{attachments:true});releasePreview({ok:true,url:'data:image/png;base64,AA==',mimeType:'image/png'});
 const previewFenced=await pending===null;files.destroy();composer.destroy();return {picked,sent,retained,isolated,fenced,previewFenced};})()`);
 assert.deepEqual(result,{picked:{canSend:true,noUpload:true,noCheckbox:true,noManualUpload:true},sent:{count:1,input:{conversationId:'a',transferIds:['f0'],bodyText:'caption'},cleared:true,persistedClear:true},retained:true,isolated:true,fenced:true,previewFenced:true});
 console.log('Composer attachments: one send, no manual upload, failure retention and conversation/policy isolation passed');finish(0);
}).catch(e=>{console.error(e);finish(1);});
