const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'session-task-cards-'));
app.setPath('userData',path.join(tmp,'profile'));app.disableHardwareAcceleration();
let win;const timer=setTimeout(()=>finish(1),30000);
function finish(code){clearTimeout(timer);win?.destroy();fs.rmSync(tmp,{recursive:true,force:true});app.exit(code);}
app.whenReady().then(async()=>{
 const renderer=path.resolve('src/renderer'),base=pathToFileURL(renderer+'/').href;
 const page=path.join(tmp,'test.html');fs.writeFileSync(page,`<!doctype html><link rel="stylesheet" href="${base}styles.css"><body></body>`);
 win=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{contextIsolation:true}});await win.loadFile(page);
 await win.webContents.executeJavaScript(`(async()=>{
  const parsed=new DOMParser().parseFromString(${JSON.stringify(fs.readFileSync(path.join(renderer,'index.html'),'utf8'))},'text/html');
  parsed.querySelectorAll('script').forEach(el=>el.remove());document.body.replaceChildren(...parsed.body.childNodes);
  const base=${JSON.stringify(base)},check=(x,s)=>{if(!x)throw Error(s);},tick=async()=>{for(let i=0;i<20;i++)await new Promise(r=>setTimeout(r,0));};
  const listeners=new Set(),commands=[];let loggedIn=true,release=null,defer=false,online=true;
  let rows=[{id:'draft',taskId:null,conversationId:'chat',createdAt:10,title:'Review budget',revision:0,state:'preparing'}];
  window.assistantClient={getAccountStatus:async()=>({loggedIn,user:{id:'owner'}}),collaboration:{
   onStateChange:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
   listTasks:async id=>{check(id==='chat','binding conversation refreshed');return{ok:online};},
   taskWorkflow:async input=>{commands.push(input);check(input.operation==='sessionCards','only local card projection');
     if(defer)return new Promise(resolve=>{release=resolve;});
     return{ok:true,cards:input.sessionId==='origin'?structuredClone(rows):[],conversationIds:input.sessionId==='origin'?['chat']:[]};}
  }};
  const {setLocale}=await import(base+'i18n/index.js');await setLocale('en',{persist:false});
  const store=(await import(base+'modules/state.js')).default;
  const {syncCommittedMessages,getRuntimeSession}=await import(base+'modules/session-runtime-store.js');
  const {showSessionMessages,renderConversation,removeSessionMessages}=await import(base+'modules/message.js');
  const {registerWorkspaceCollaborationController}=await import(base+'modules/workspace-collaboration-entry.js');
  let opened;const navigation=registerWorkspaceCollaborationController({openCard:async card=>{opened=card;return{ok:true};}});
  store.set('activeSessionId','origin');syncCommittedMessages('origin',[]);showSessionMessages('origin');await tick();
  const panel=document.querySelector('.session-messages[data-session-id="origin"]');
  const card=panel.querySelector('.collaboration-task-card');check(card,'source task appears in actual session panel');
  check(card.getBoundingClientRect().height>40&&card.getBoundingClientRect().width>100,'card has visible layout');
  check(!panel.querySelector('.runtime-messages .collaboration-task-card'),'card is not an engine message');
  card.querySelector('button').click();await tick();check(opened.id==='draft'&&opened.conversationId==='chat','click retains exact task anchor');
  rows=[{...rows[0],taskId:'task',revision:2,state:'active'}];for(const fn of listeners)fn({type:'task'});await tick();
  check(panel.querySelector('.collaboration-task-card')===card&&card.dataset.revision==='2','ACK and progress preserve node');
  rows=[{...rows[0],integration:{stage:'published',deliveryId:'delivery',canRetry:false,localStage:'waiting'}}];for(const fn of listeners)fn({type:'task'});await tick();
  check(card.querySelector('p').textContent.includes('Waiting for foreground work'),'published shared state still shows local waiting');
  rows=[{...rows[0],integration:{...rows[0].integration,localStage:'applied'}}];for(const fn of listeners)fn({type:'task'});await tick();
  check(card.querySelector('p').textContent.includes('Applied to the local workspace'),'local receipt updates the same card');
  rows=[{...rows[0],integration:{...rows[0].integration,localStage:'undone'}}];for(const fn of listeners)fn({type:'task'});await tick();
  check(card.querySelector('p').textContent.includes('Contribution undone locally'),'undone contribution updates the same card');
  rows=[{...rows[0],integration:{...rows[0].integration,localStage:'applied'}}];for(const fn of listeners)fn({type:'task'});await tick();
  renderConversation('origin',{force:true});check(panel.querySelector('.collaboration-task-card')===card,'conversation rebuild preserves card');
  check(getComputedStyle(panel.querySelector('.workbench-empty')).display==='none','task content replaces empty-session onboarding');
  check(getRuntimeSession('origin').committedMessages.length===0,'task cards never become engine context');
  online=false;for(const fn of listeners)fn({type:'task'});await tick();
  check(card.querySelector('p').textContent.includes('Last saved status'),'offline card labels cached state');
  await setLocale('zh-CN',{persist:false});check(card.querySelector('p').textContent!=='Active','locale updates without losing node');
  check(card.querySelector('p').textContent.includes('已写入本地工作空间'),'Chinese local receipt label');
  await setLocale('ar',{persist:false});check(card.querySelector('p').textContent.includes('تم التطبيق على مساحة العمل المحلية'),'Arabic local receipt label');
  defer=true;for(const fn of listeners)fn({type:'task'});await tick();check(release,'pending request exists');
  loggedIn=false;for(const fn of listeners)fn({type:'availability'});check(!panel.querySelector('.collaboration-task-card'),'account change clears immediately');
  release({ok:true,cards:rows,conversationIds:[]});await tick();check(!panel.querySelector('.collaboration-task-card'),'late response cannot revive old account');
  defer=false;loggedIn=true;showSessionMessages('other');await tick();check(!document.querySelector('.session-messages.is-active .collaboration-task-card'),'unbound session has no card');
  removeSessionMessages('origin');removeSessionMessages('other');navigation.destroy();check(listeners.size===0,'panel deletion removes subscriptions');
 })()`);
 console.log('session task cards: actual message panel, node identity, engine-context exclusion, locale, navigation, account fence and teardown passed');
}).then(()=>finish(0)).catch(error=>{console.error(error);finish(1);});
