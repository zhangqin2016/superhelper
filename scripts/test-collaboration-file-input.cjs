"use strict";
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {pathToFileURL}=require('node:url');const {app,BrowserWindow}=require('electron');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'collab-file-input-'));app.setPath('userData',path.join(dir,'data'));app.disableHardwareAcceleration();let win;
const timer=setTimeout(()=>finish(1),30000);function finish(code){clearTimeout(timer);win?.destroy();fs.rmSync(dir,{recursive:true,force:true});app.exit(code);}
app.whenReady().then(async()=>{
 const file=path.join(dir,'index.html');fs.writeFileSync(file,'<section class="collaboration-conversation"><div class="collaboration-composer"><div id="files"></div><textarea></textarea><button id="attach"></button></div></section>');
 win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});await win.loadFile(file);
 const url=pathToFileURL(path.resolve(__dirname,'../src/renderer/modules/collaboration-attachments.js')).href;
 const r=await win.webContents.executeJavaScript(`(async()=>{
 const {initCollaborationAttachments}=await import('${url}');let rows=[],calls=[],lateResolve;
 const api={getTransfers:async()=>({ok:true,transfers:rows}),prepareDroppedAttachment:async(id,file)=>{calls.push(['drop',id,file.name]);const row={ok:true,id:'f'+calls.length,conversationId:id,originalName:file.name,purpose:'attachment',direction:'upload',state:'prepared'};rows.push(row);return row;},preparePastedImage:async(id,bytes)=>{calls.push(['paste',id,bytes.length]);return new Promise(resolve=>{lateResolve=resolve;});}};
 const root=document.getElementById('files'),target=document.querySelector('section'),text=document.querySelector('textarea');
 const c=initCollaborationAttachments({root,attachButton:document.getElementById('attach'),api,composerMode:true});c.setConversation({id:'a'},{attachments:true});const wait=()=>new Promise(r=>setTimeout(r,25));await wait();
 const data=new DataTransfer();data.items.add(new File(['a'],'report.pdf'));data.items.add(new File(['b'],'archive.zip'));
 const drop=new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true});target.dispatchEvent(drop);await wait();const names=Array.from(root.querySelectorAll('strong')).map(n=>n.textContent);
 const plain=new DataTransfer();plain.setData('text/plain','normal text');const plainEvent=new ClipboardEvent('paste',{clipboardData:plain,bubbles:true,cancelable:true});text.dispatchEvent(plainEvent);
 const image=new DataTransfer();image.items.add(new File([new Uint8Array([137,80,78,71])],'image.png',{type:'image/png'}));const paste=new ClipboardEvent('paste',{clipboardData:image,bubbles:true,cancelable:true});text.dispatchEvent(paste);await wait();
 c.setConversation({id:'b'},{attachments:true});lateResolve({ok:true,id:'late'});await wait();const isolated=!root.textContent.includes('report.pdf')&&!c.hasDraft();
 c.setPolicy({attachments:false});target.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));await wait();
 const result={names,calls,dropPrevented:drop.defaultPrevented,pastePrevented:paste.defaultPrevented,textUntouched:!plainEvent.defaultPrevented,isolated};c.destroy();return result;})()`);
 assert.deepEqual(r,{names:['report.pdf','archive.zip'],calls:[['drop','a','report.pdf'],['drop','a','archive.zip'],['paste','a',4]],dropPrevented:true,pastePrevented:true,textUntouched:true,isolated:true});
 console.log('IM file gestures: multi-file drop, screenshot paste, text passthrough, policy and conversation fences passed');finish(0);
}).catch(e=>{console.error(e);finish(1);});
