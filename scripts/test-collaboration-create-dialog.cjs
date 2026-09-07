const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');const {app,BrowserWindow}=require('electron');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'im-create-dialog-'));app.setPath('userData',path.join(temp,'profile'));app.disableHardwareAcceleration();
let win;const timeout=setTimeout(()=>app.exit(1),30000);
app.whenReady().then(async()=>{
 const source=fs.readFileSync(path.resolve('src/renderer/index.html'),'utf8');
 const body=source.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
 const fixture=path.join(temp,'fixture.html');fs.writeFileSync(fixture,`<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.resolve('src/renderer/styles.css')).href}"></head><body>${body}</body></html>`);
 win=new BrowserWindow({show:false,width:1200,height:820,webPreferences:{sandbox:true,contextIsolation:true}});await win.loadFile(fixture);
 await win.webContents.executeJavaScript(`(async()=>{
 const {initCollaborationTeams}=await import(${JSON.stringify(pathToFileURL(path.resolve('src/renderer/modules/collaboration-teams.js')).href)});
 const {setLocale}=await import(${JSON.stringify(pathToFileURL(path.resolve('src/renderer/i18n/index.js')).href)});await setLocale('zh-CN',{persist:false});
 const root=document.getElementById('collaborationTeams');root.hidden=false;document.getElementById('collaborationCenter').hidden=false;
 const members=Array.from({length:40},(_,i)=>({userId:'u'+i,displayName:['林悦','陈思远','周宁','许知遥'][i%4]+' '+i,role:'member'}));
 const directory={profile:{userId:'self'},contacts:members.map(m=>({...m,relationship:'friend'})),teams:[{id:'team',name:'产品设计',scopeId:'team:team',role:'owner',members}]};
 const api={conversation:async()=>({ok:false,code:'UNAVAILABLE'})},opened=[];
 const teams=initCollaborationTeams(root,{api,onOpen:id=>opened.push(id)});teams.update({directory,conversations:[]});
 const entry=root.querySelector('section.collaboration-team details.collaboration-disclosure');entry.querySelector('summary').click();
 window.dialogTest={teams,directory,entry,setLocale,api,opened};
 })()`);
 await new Promise(r=>setTimeout(r,60));
 assert.equal(await win.webContents.executeJavaScript('!!document.querySelector("dialog.collaboration-create-dialog:modal")'),true,'channel creation uses an actual modal, not an expanded sidebar form');
 await win.webContents.executeJavaScript(`(()=>{const form=document.querySelector('dialog[open] form');form.querySelector('[name=title]').value='产品讨论';for(const box of [...form.querySelectorAll('input[type=checkbox]')].slice(0,15))box.click();})()`);
 const translated=await win.webContents.executeJavaScript(`(async()=>{const field=document.querySelector('dialog[open] [name=title]');field.focus();await window.dialogTest.setLocale('en',{persist:false});const d=document.querySelector('dialog[open]');return {title:d.querySelector('h2').textContent,label:field.parentElement.textContent,cancel:d.querySelector('footer [data-dialog-dismiss]').textContent,private:d.querySelector('option[value=private]').textContent,draft:field.value,focus:document.activeElement===field};})()`);
 assert.deepEqual(translated,{title:'Create channel',label:'Name',cancel:'Cancel',private:'Private — invited members only',draft:'产品讨论',focus:true},'live locale switch updates modal chrome without replacing draft or focus');
 await win.webContents.executeJavaScript(`window.dialogTest.setLocale('zh-CN',{persist:false})`);
 for(const [width,height,theme] of [[1200,820,'light'],[420,700,'light'],[760,600,'dark']]){
  win.setSize(width,height);await win.webContents.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);await new Promise(r=>setTimeout(r,300));
  const geometry=await win.webContents.executeJavaScript(`(()=>{const d=document.querySelector('dialog[open]'),f=d.querySelector('button[type=submit]'),r=d.getBoundingClientRect(),b=f.getBoundingClientRect();return {fits:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,footer:b.bottom<=r.bottom&&b.top>=r.top,overflow:d.scrollWidth>d.clientWidth+1,chip:Math.max(...[...d.querySelectorAll('.collaboration-picker-chip .collaboration-row-avatar')].map(n=>n.getBoundingClientRect().height))};})()`);
  assert.equal(geometry.fits,true,JSON.stringify(geometry));assert.equal(geometry.footer,true);assert.equal(geometry.overflow,false);assert.ok(geometry.chip>0&&geometry.chip<=28,'selected avatars stay compact');
  assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('dialog[open] .collaboration-picker-chip')).opacity`),'1','selection is immediately readable, not faded in');
  if(process.env.IM_DESIGN_SCREENSHOTS){fs.mkdirSync(process.env.IM_DESIGN_SCREENSHOTS,{recursive:true});fs.writeFileSync(path.join(process.env.IM_DESIGN_SCREENSHOTS,`channel-${width}-${theme}.png`),(await win.webContents.capturePage()).toPNG());}
 }
 const checks=await win.webContents.executeJavaScript(`(async()=>{const {teams,directory}=window.dialogTest;const d=document.querySelector('dialog[open]'),field=d.querySelector('[name=title]');field.focus();field.setSelectionRange(1,2);teams.update({directory:{...directory,teams:directory.teams.map(t=>({...t,name:'产品设计更新'}))},conversations:[]});const stable=d===document.querySelector('dialog[open]')&&document.activeElement===field&&field.value==='产品讨论';d.querySelector('[data-dialog-dismiss]').click();await new Promise(r=>setTimeout(r,20));const closed=!document.querySelector('dialog:modal');teams.reset();return {stable,closed};})()`);
 assert.deepEqual(checks,{stable:true,closed:true});
 const pickerFocus=await win.webContents.executeJavaScript(`(async()=>{const {teams,directory}=window.dialogTest;teams.update({directory,conversations:[]});const form=document.querySelector('[data-form=channel]');form.closest('details').querySelector('summary').click();await new Promise(r=>setTimeout(r,30));const box=form.querySelector('input[type=checkbox]');box.focus();const id=box.closest('[data-user-id]').dataset.userId;teams.update({directory,conversations:[]});return document.activeElement?.closest('[data-user-id]')?.dataset.userId===id;})()`);
 assert.equal(pickerFocus,true,'background directory refresh preserves keyboard focus in member picker');
 await win.webContents.executeJavaScript(`window.dialogTest.teams.reset()`);
 const canceled=await win.webContents.executeJavaScript(`(async()=>{
 const {teams,directory,api,opened}=window.dialogTest,wait=()=>new Promise(r=>setTimeout(r,30));teams.update({directory,conversations:[]});
 for(const kind of ['channel','group']){
  const form=document.querySelector('[data-form="'+kind+'"]'),entry=form.closest('details');entry.querySelector('summary').click();await wait();
  form.querySelector('[name=title]').value='提交的草稿';form.querySelector('input[type=checkbox]').click();let release;api.conversation=()=>new Promise(r=>release=r);form.requestSubmit();await wait();
  form.closest('dialog').querySelector('[data-dialog-dismiss]').click();await wait();entry.querySelector('summary').click();await wait();
  form.querySelector('[name=title]').value='重新打开的新草稿';release({ok:true,state:'completed',conversationId:'late'});await wait();
  if(form.querySelector('[name=title]').value!=='重新打开的新草稿'||opened.length) return false;
  form.closest('dialog').querySelector('[data-dialog-dismiss]').click();await wait();
 }
 teams.reset();return true;})()`);
 assert.equal(canceled,true,'late creation never navigates or clears a reopened draft');
 console.log('create dialog: modal, stable refresh, compact selection, narrow/dark geometry and canceled channel/group response fencing passed');
}).then(()=>{clearTimeout(timeout);win?.destroy();app.quit();}).catch(e=>{console.error(e);app.exit(1);});
