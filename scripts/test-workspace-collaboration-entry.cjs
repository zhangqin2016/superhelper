const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-collaboration-'));
app.setPath('userData', path.join(temp, 'data')); app.disableHardwareAcceleration();
let win; const timer = setTimeout(() => finish(1), 45000);
function finish(code) { clearTimeout(timer); win?.destroy(); try { require('./lib/electron-test-cleanup.cjs')(temp); } catch (error) { console.error(error); code = 1; } app.exit(code); }
app.whenReady().then(async () => {
  const renderer = path.join(__dirname, '../src/renderer');
  const markup = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  const page = path.join(temp, 'test.html');
  fs.writeFileSync(page, `<!doctype html><link rel="stylesheet" href="${pathToFileURL(path.join(renderer, 'styles.css')).href}"><body></body>`);
  win = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { sandbox: true, contextIsolation: true } }); await win.loadFile(page);
  const result = await win.webContents.executeJavaScript(`(async () => {
    const base = ${JSON.stringify(pathToFileURL(renderer + '/').href)};
    const {setLocale,t}=await import(base+'i18n/index.js');await setLocale('zh-CN');
    const real = new DOMParser().parseFromString(${JSON.stringify(markup)}, 'text/html');
    document.body.append(real.getElementById('collaborationCenter'));
    for (const id of ['collaborationPanelToggle','centerPanel','projectTree']) { const el = document.createElement('div'); el.id=id; document.body.append(el); }
    const calls=[]; let listener, enabled=true, directoryWait=null, commandMode='completed', commandWait=null, signedIn=true, detailsFailed=false, friendMissing=false;
    const directory={ok:true,profile:{userId:'self'},contacts:[{userId:'friend',displayName:'Fresh friend',relationship:'friend'}],teams:[{id:'team',name:'Design',scopeId:'organization:team',members:[{userId:'teammate',displayName:'Fresh colleague'}]}]};
    window.assistantClient={getAccountStatus:async()=>({loggedIn:signedIn,user:{id:'self'}}),collaboration:{onStateChange:fn=>(listener=fn,()=>{}),getDirectory:async()=>directoryWait?await directoryWait:directory,
      list:async()=>({ok:true,conversations:[{id:'chat',title:'Existing chat',kind:'group',scopeId:'personal'},...['newfriend','newteam'].filter(id=>calls.some(c=>c.operation==='open'&&c.id===id)).map(id=>({id,title:id,kind:'direct',scopeId:'personal'}))]}),getSocialCommands:async()=>({ok:true,commands:[]}),
      getDraft:async()=>({ok:true,text:''}),saveDraft:async()=>({ok:true}),
      open:async(id,_before,options)=>{if(!options?.cached)calls.push({operation:'open',id});return {ok:true,conversation:{id,title:'Chat',kind:'group'},messages:[]};},
      getConversationDetails:async id=>({ok:!detailsFailed,conversation:{id},members:[{userId:'self'},{userId:'other',displayName:'Other'},{userId:'friend',displayName:'Fresh friend'},{userId:'teammate',displayName:'Fresh colleague'}]}),
      openFriend:async id=>{calls.push({operation:'friend',id});return friendMissing?{ok:false,code:'COLLABORATION_NOT_FOUND'}:{ok:true,state:'completed',conversationId:'newfriend'};},
      conversation:async input=>{calls.push(input);if(commandWait)await commandWait;return {ok:true,state:commandMode,clientCommandId:input.clientCommandId,conversationId:commandMode==='completed'?'newteam':undefined};},
      listTasks:async()=>{calls.push({operation:'listTasks'});return {ok:true,tasks:[]};},
      taskWorkflow:async input=>{calls.push(input);return {ok:true,applications:[],drafts:[],draft:{id:'draft',files:[]}};}
    }};
    const {initCollaborationCenter}=await import(base+'modules/collaboration-center.js');
    const center=initCollaborationCenter({getPolicy:async()=>({collaboration:{enabled:true,tasks:enabled}})});
    const {default:store}=await import(base+'modules/state.js');
    const {renderProjectTree}=await import(base+'modules/project-tree.js');
    store.set('projects',[{id:'project',name:'Budget',path:'/must-not-cross-renderer-boundary',sessions:[]}]);store.set('sessions',[]);renderProjectTree();
    const tick=()=>new Promise(r=>setTimeout(r,60));
    const check=(value,message)=>{if(!value)throw Error(message);};
    const click=selector=>{const el=document.querySelector(selector);check(el,'Missing '+selector+' calls='+JSON.stringify(calls)+' '+document.querySelector('.remote-tasks')?.textContent+' '+document.querySelector('.workspace-collaboration-dialog')?.textContent);el.click();};
    const launch=async()=>{document.querySelector('.project-actions .project-action-btn:last-child').click(); const item=document.querySelector('[data-action=workspace-collaboration]');check(item,'Workspace menu must visibly offer 分享并发起协作…');item.click();await tick();};
    await tick();const returnTarget=document.querySelector('.project-actions .project-action-btn:last-child');returnTarget.focus();await launch();
    check(document.querySelector('.workspace-collaboration-dialog[open]'),'Entry opens native selector');
    check(document.querySelector('.workspace-collaboration-dialog').getBoundingClientRect().height>100,'Selector visibly occupies the viewport');
    check(document.querySelector('.workspace-collaboration-dialog').getBoundingClientRect().height<450,'Short recipient selector remains content-sized');
    check(getComputedStyle(document.querySelector('.workspace-collaboration-dialog .collaboration-form-note')).color===getComputedStyle(document.querySelector('.workspace-collaboration-dialog .collaboration-dialog-status')).color,'Workspace label uses readable theme secondary text');
    check(getComputedStyle(document.querySelector('.workspace-collaboration-dialog .collaboration-form-note')).opacity==='1','Workspace label must be readable immediately, opacity='+getComputedStyle(document.querySelector('.workspace-collaboration-dialog .collaboration-form-note')).opacity);
    const picker=()=>document.querySelector('[name=collaborationTarget]');
    check(picker().querySelector('[value="friend:friend"]')&&picker().querySelector('[value="team:team:teammate"]'),'People without prior chats are selectable');
    picker().value='friend:friend';picker().focus();for(const locale of ['en','ar','zh-CN']){await setLocale(locale);check(picker().querySelector('option[value=""]').textContent===t('collaboration.workspace.choose'),'Live locale updates chooser placeholder');check(picker().value==='friend:friend'&&document.activeElement===picker(),'Live locale preserves recipient and focus');}
    check(!calls.some(c=>c.operation==='open'||c.operation==='prepare'),'Opening selector does not navigate or prepare');
    click('[data-action=workspace-collaboration-cancel]');await tick();check(!document.querySelector('dialog[open]'),'Cancel closes');check(document.activeElement===returnTarget,'Cancel preserves prior workspace keyboard focus');
    await launch();picker().value='friend:friend';picker().dispatchEvent(new Event('change'));click('[data-action=workspace-collaboration-continue]');await tick();
    check(document.querySelector('[name=assigneeUserId]')?.value==='friend','Chosen friend remains recipient');
    check(document.activeElement===document.querySelector('[name=assigneeUserId]'),'Successful chooser handoff focuses the new task form: '+document.activeElement?.outerHTML.slice(0,300));
    click('[data-action=task-prepare]');await tick();
    const prepared=calls.find(c=>c.operation==='prepare');check(prepared?.projectId==='project'&&!('path' in prepared),'Prepare carries project ID only');
    check(!calls.some(c=>c.operation==='send'),'No automatic send');click('[data-action=task-back]');await tick();
    detailsFailed=true;await launch();picker().value='friend:friend';picker().dispatchEvent(new Event('change'));click('[data-action=workspace-collaboration-continue]');await tick();check(!document.querySelector('.workspace-collaboration-dialog'),'Task surface takes ownership after recipient read failure');
    detailsFailed=false;click('[data-action=task-refresh]');await tick();check(document.querySelector('[name=assigneeUserId]')?.value==='friend','Task recipient retry survives selector dismissal');click('[data-action=task-back]');await tick();
    friendMissing=true;await launch();picker().value='friend:friend';picker().dispatchEvent(new Event('change'));const createsBefore=calls.filter(c=>c.action==='create').length;click('[data-action=workspace-collaboration-continue]');await tick();check(calls.filter(c=>c.action==='create').length===createsBefore,'Missing canonical friend cannot invent unsupported personal direct creation');friendMissing=false;click('[data-action=workspace-collaboration-retry]');await tick();check(document.querySelector('[name=assigneeUserId]')?.value==='friend','Missing canonical friend retries existing resolver');click('[data-action=task-back]');await tick();
    await launch();picker().value='team:team:teammate';picker().dispatchEvent(new Event('change'));commandMode='confirming';click('[data-action=workspace-collaboration-continue]');await tick();
    check(document.querySelector('.workspace-collaboration-dialog[open]'),'Unknown creation stays reviewable');
    const first=calls.filter(c=>c.action==='create').at(-1);commandMode='completed';click('[data-action=workspace-collaboration-retry]');await tick();
    const second=calls.filter(c=>c.action==='create').at(-1);check(first.clientCommandId===second.clientCommandId&&first.organizationId==='team','Unknown team result retries immutable command');
    check(document.querySelector('[name=assigneeUserId]')?.value==='teammate','Team recipient preserved');
    const title=document.querySelector('[name=title]');title.value='Keep this draft';title.dispatchEvent(new Event('input'));listener({type:'sync',state:{ok:true}});await tick();
    check(document.querySelector('[name=title]')===title&&title.value==='Keep this draft','Sync preserves task draft DOM');
    click('[data-action=task-back]');await tick();
    await launch();picker().value='team:team:teammate';picker().dispatchEvent(new Event('change'));commandMode='failed';click('[data-action=workspace-collaboration-continue]');await tick();
    check(document.querySelector('[data-action=workspace-collaboration-retry]').hidden,'Definite social rejection cannot offer ineffective same-command retry');check(!picker().disabled,'Definite rejection allows choosing another recipient');check(document.querySelector('.workspace-collaboration-dialog .collaboration-dialog-status').textContent===t('collaboration.workspace.rejected'),'Definite rejection is explained');
    const rejected=calls.filter(c=>c.action==='create').at(-1);picker().value='friend:friend';picker().dispatchEvent(new Event('change'));picker().value='team:team:teammate';picker().dispatchEvent(new Event('change'));commandMode='completed';click('[data-action=workspace-collaboration-continue]');await tick();check(calls.filter(c=>c.action==='create').at(-1).clientCommandId!==rejected.clientCommandId,'Explicit reselection creates a new intent after definite rejection');click('[data-action=task-back]');await tick();
    await launch();let finishRead;directoryWait=new Promise(resolve=>finishRead=resolve);click('[data-action=workspace-collaboration-cancel]');
    await launch();document.querySelector('.workspace-collaboration-dialog').dispatchEvent(new Event('cancel',{cancelable:true}));finishRead(directory);directoryWait=null;await tick();
    check(!document.querySelector('dialog[open]'),'Escape/cancel fences a delayed directory read');
    await launch();picker().value='team:team:teammate';picker().dispatchEvent(new Event('change'));let finishCommand;commandWait=new Promise(resolve=>finishCommand=resolve);
    click('[data-action=workspace-collaboration-continue]');await tick();const beforeOpen=calls.filter(c=>c.operation==='open').length;
    click('[data-action=workspace-collaboration-cancel]');finishCommand();commandWait=null;await tick();check(calls.filter(c=>c.operation==='open').length===beforeOpen,'Canceled late command cannot navigate');
    await launch();picker().value='team:team:teammate';picker().dispatchEvent(new Event('change'));commandWait=new Promise(resolve=>finishCommand=resolve);
    click('[data-action=workspace-collaboration-continue]');await tick();center.hide();finishCommand();commandWait=null;await tick();check(calls.filter(c=>c.operation==='open').length===beforeOpen,'Manual navigation fences command completion');click('[data-action=workspace-collaboration-cancel]');
    signedIn=false;await launch();check(document.querySelector('.workspace-collaboration-dialog').textContent.includes('登录'),'Signed out entry explains login');signedIn=true;click('[data-action=workspace-collaboration-retry]');await tick();check(picker().options.length>1,'Login status is freshly checked on retry');click('[data-action=workspace-collaboration-cancel]');
    enabled=false;await center.refresh();calls.length=0;await launch();check(document.querySelector('.workspace-collaboration-dialog').textContent.includes('尚未启用'),'Disabled state explains availability');check(!calls.some(c=>c.operation==='listTasks'),'Disabled entry cannot fetch tasks');
    enabled=true;click('[data-action=workspace-collaboration-retry]');await tick();picker().value='friend:friend';picker().dispatchEvent(new Event('change'));click('[data-action=workspace-collaboration-continue]');await tick();check(document.querySelector('[data-action=task-prepare]'),'Policy retry refreshes center before opening task form');click('[data-action=task-back]');await tick();
    for(const event of [{type:'availability',state:{ok:false}},{type:'access-revoked',state:{ok:true}}]){
      await launch();check(picker().textContent.includes('Fresh friend'),'Authorized names visible before event');listener(event);check(!document.querySelector('.workspace-collaboration-dialog'),'Account/service/revocation event immediately removes old directory');await tick();
      let release;directoryWait=new Promise(resolve=>release=resolve);await launch();listener(event);release(directory);directoryWait=null;await tick();check(!document.querySelector('.workspace-collaboration-dialog'),'Event fences delayed directory names');
      await launch();picker().value='team:team:teammate';picker().dispatchEvent(new Event('change'));commandWait=new Promise(resolve=>release=resolve);click('[data-action=workspace-collaboration-continue]');await tick();const opens=calls.filter(c=>c.operation==='open').length;listener(event);release();commandWait=null;await tick();check(!document.querySelector('.workspace-collaboration-dialog')&&calls.filter(c=>c.operation==='open').length===opens,'Event dismisses and fences late social navigation');
    }
    window.entryLayout=async(locale,theme)=>{await setLocale(locale);document.documentElement.dataset.theme=theme;document.body.dataset.appView='collaboration';await launch();const dialog=document.querySelector('dialog[open]'),rect=dialog.getBoundingClientRect();check(rect.width>0&&rect.left>=0&&rect.right<=innerWidth+1&&rect.top>=0&&rect.bottom<=innerHeight+1,'Visible dialog within narrow viewport');const footer=dialog.querySelector('footer').getBoundingClientRect();check(footer.bottom<=rect.bottom+1,'Dialog actions remain visible');check(getComputedStyle(dialog).backgroundColor!=='rgba(0, 0, 0, 0)','Dialog uses opaque theme surface');const cancel=dialog.querySelector('[data-action=workspace-collaboration-cancel]');cancel.focus();dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));check(document.activeElement===picker(),'Tab wraps to recipient when continue disabled');dialog.dispatchEvent(new Event('cancel',{cancelable:true}));delete document.body.dataset.appView;};
    const layout=window.entryLayout;window.entryLayout=async(locale,theme)=>{await layout(locale,theme);await launch();const dialog=document.querySelector('.workspace-collaboration-dialog');check(dialog.getBoundingClientRect().height<450,'Short narrow selector does not stretch vertically');check(getComputedStyle(dialog.querySelector('.collaboration-form-note')).color===getComputedStyle(dialog.querySelector('.collaboration-dialog-status')).color,'Workspace label follows theme secondary text');click('[data-action=workspace-collaboration-cancel]');};
    window.cleanupEntry=()=>center.destroy();return true;
  })()`);
  assert.equal(result, true);
  for(const width of [1100,380])for(const theme of ['light','dark'])for(const locale of ['zh-CN','en','ar']){win.setSize(width,620);await win.webContents.executeJavaScript('window.entryLayout('+JSON.stringify(locale)+','+JSON.stringify(theme)+')');}
  await win.webContents.executeJavaScript('window.cleanupEntry()');console.log('workspace collaboration entry: real menu, selector, explicit creation, retry identity, stale callbacks, draft preservation and three-locale narrow/light/dark layout passed'); finish(0);
}).catch(error => { console.error(error); finish(1); });
