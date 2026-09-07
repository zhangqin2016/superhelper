const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');const {app,BrowserWindow}=require('electron');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'presence-center-'));app.setPath('userData',path.join(temp,'profile'));app.disableHardwareAcceleration();
let win;const timeout=setTimeout(()=>app.exit(1),30000);
app.whenReady().then(async()=>{
 const source=fs.readFileSync(path.resolve('src/renderer/index.html'),'utf8');
 const body=source.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
 const fixture=path.join(temp,'fixture.html');fs.writeFileSync(fixture,`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.resolve('src/renderer/styles.css')).href}"></head><body>${body}</body></html>`);
 win=new BrowserWindow({show:false,width:1050,height:800,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});await win.loadFile(fixture,{query:{view:'collaboration'}});
 const result=await win.webContents.executeJavaScript(`(async()=>{
 const {initCollaborationCenter}=await import(${JSON.stringify(pathToFileURL(path.resolve('src/renderer/modules/collaboration-center.js')).href)});
 const {setLocale}=await import(${JSON.stringify(pathToFileURL(path.resolve('src/renderer/i18n/index.js')).href)});await setLocale('zh-CN',{persist:false});
 let callback,lists=0,opens=0,loggedIn=true;const calls=[];
 const conversation={id:'private',kind:'direct',scopeId:'personal',memberUserIds:['self','peer'],title:'林悦'};
 const directory={ok:true,profile:{userId:'self',lilyId:'self',displayName:'我'},contacts:[{userId:'peer',lilyId:'lin-yue',displayName:'林悦',relationship:'friend',ownBlocked:false}],teams:[{id:'team',scopeId:'team:team',name:'产品团队',role:'member',members:[{userId:'self',displayName:'我',role:'member'},{userId:'peer',displayName:'林悦',role:'member'}]}]};
 const presence=()=>({ok:true,observedAt:new Date().toISOString(),states:[{userId:'peer',presence:'online',onlineUntil:new Date(Date.now()+60000).toISOString()}]});
 window.assistantClient={collaboration:{onStateChange:fn=>{callback=fn;return()=>{};},getDirectory:async()=>loggedIn?directory:{ok:false},getSocialCommands:async()=>({ok:true,commands:[]}),list:async()=>{lists++;return {ok:true,conversations:loggedIn?[conversation]:[]};},getDraft:async()=>({ok:true,text:'待发送的草稿'}),saveDraft:async()=>({ok:true}),getPresence:async({userIds})=>{calls.push(userIds);return {...presence(),states:userIds.map(userId=>({userId,presence:'online',onlineUntil:new Date(Date.now()+60000).toISOString()}))};},open:async()=>{opens++;return {ok:true,conversation,messages:[]};},getTransfers:async()=>({ok:true,transfers:[]})}};
 let center=initCollaborationCenter({getPolicy:async()=>({collaboration:{enabled:true}})});
 const tick=()=>new Promise(r=>setTimeout(r,35));center.show();await tick();
 document.getElementById('collaborationPeopleTab').click();await tick();
 const friend=document.querySelector('#collaborationFriends [data-presence-user="peer"]');const friendOnline=friend?.dataset.presence==='online';
 await center.open('private');await tick();
 const header=document.querySelector('.collaboration-header-presence');const headerOnline=header?.querySelector('[data-presence-user="peer"]')?.dataset.presence==='online';
 const composer=document.getElementById('collaborationComposer');composer.focus();composer.setSelectionRange(2,4);const before={lists,opens};
 callback({type:'online-presence',state:{ok:true,onlinePresence:{ok:true,states:[{userId:'peer',presence:'offline',onlineUntil:null}]},typing:{}}});await tick();
 const updateInPlace=header.querySelector('[data-presence-user="peer"]').dataset.presence==='offline'&&composer===document.getElementById('collaborationComposer')&&composer.selectionStart===2&&composer.value==='待发送的草稿'&&lists===before.lists&&opens===before.opens;
 callback({type:'typing',state:{ok:true,typing:{private:['peer']},onlinePresence:presence()}});const typingPriority=header.hidden&&!document.getElementById('collaborationTyping').hidden;
 callback({type:'typing',state:{ok:true,typing:{},onlinePresence:presence()}});const typingCleared=!header.hidden;
 document.getElementById('collaborationTeamsTab').click();await tick();const roster=document.querySelector('.enterprise-roster');roster.open=true;await tick();
 const teamOnline=roster.querySelector('[data-presence-user="peer"]')?.dataset.presence==='online';
 const navigationChecks={};
 callback({type:'sync',state:{ok:true}});await tick();await tick();
 navigationChecks.backgroundKeepsTeam=document.getElementById('collaborationConversation').hidden;
 let releaseOpen;
 const originalOpen=window.assistantClient.collaboration.open;
 window.assistantClient.collaboration.open=async(id,before,options)=>options?.cached?{ok:false}:new Promise(resolve=>{releaseOpen=resolve;});
 const delayed=center.open('private');await tick();
 document.getElementById('collaborationTeamsTab').click();
 releaseOpen({ok:true,conversation,messages:[]});await delayed;await tick();
 navigationChecks.lateOpenKeepsTeam=document.getElementById('collaborationConversation').hidden;
 window.assistantClient.collaboration.open=originalOpen;
 await center.open('private');await tick();
 navigationChecks.explicitOpenWorks=!document.getElementById('collaborationConversation').hidden;
 document.getElementById('collaborationConversationBack').click();
 callback({type:'sync',state:{ok:true}});await tick();await tick();
 navigationChecks.backStaysBack=document.getElementById('collaborationConversation').hidden;
 window.assistantClient.collaboration.list=async()=>({ok:true,conversations:[{...conversation,id:'team-direct',scopeId:'team:team'},{id:'channel',kind:'channel',scopeId:'team:team',title:'Project channel'}]});
 await center.refresh();center.show();await tick();document.getElementById('collaborationTeamsTab').click();await tick();
 navigationChecks.channelsOnly=!document.querySelector('.collaboration-team-channels').textContent.includes('林悦')&&document.querySelector('.collaboration-team-channels').textContent.includes('Project channel');
 document.getElementById('collaborationPeopleTab').click();await tick();
 document.querySelector('#collaborationFriends [data-action="new-friends"]').click();
 document.getElementById('collaborationDetailBack').click();
 callback({type:'sync',state:{ok:true}});await tick();await tick();
 navigationChecks.requestsBackStaysBack=document.getElementById('collaborationDetail').hidden;
 document.querySelector('#collaborationFriends [data-action="new-friends"]').click();
 document.getElementById('collaborationTeamsTab').click();await tick();
 document.getElementById('collaborationPeopleTab').click();await tick();
 navigationChecks.requestsSectionStaysList=document.getElementById('collaborationDetail').hidden;
 await setLocale('en',{persist:false});await tick();
 navigationChecks.requestsLocaleStaysList=document.getElementById('collaborationDetail').hidden;
 await setLocale('zh-CN',{persist:false});await tick();
 window.presenceNavigationChecks=navigationChecks;
 window.presenceCenterTest={center,setLocale,callback,presence,
   async showSurface(type){if(type==='chat')await center.open('private');else document.getElementById(type==='people'?'collaborationPeopleTab':'collaborationTeamsTab').click();await tick();},
   async dockedNarrow(){center.destroy();history.replaceState(null,'',location.pathname);delete document.getElementById('appShell').dataset.appView;localStorage.setItem('lily.collaboration.panelWidth','420');center=initCollaborationCenter({getPolicy:async()=>({collaboration:{enabled:true}})});center.show();await tick();document.getElementById('collaborationTeamsTab').click();await tick();document.querySelector('.enterprise-roster').open=true;window.presenceCenterTest.center=center;}
 };
 const clearAccount=()=>{loggedIn=false;callback({type:'availability',state:{ok:false}});return !document.querySelector('#collaborationCenter [data-presence="online"]');};
 window.presenceCenterTest.clearAccount=clearAccount;
 return {friendOnline,headerOnline,updateInPlace,typingPriority,typingCleared,teamOnline,bounded:calls.every(ids=>ids.length<=200)};
 })()`);
 assert.deepEqual(result,{friendOnline:true,headerOnline:true,updateInPlace:true,typingPriority:true,typingCleared:true,teamOnline:true,bounded:true});
 const navigationChecks=await win.webContents.executeJavaScript('window.presenceNavigationChecks');
 assert.deepEqual(navigationChecks,{backgroundKeepsTeam:true,lateOpenKeepsTeam:true,explicitOpenWorks:true,backStaysBack:true,channelsOnly:true,requestsBackStaysBack:true,requestsSectionStaysList:true,requestsLocaleStaysList:true},'background and delayed history must not navigate; enterprise channels exclude direct chats');
 const screenshotDir=process.env.PRESENCE_SCREENSHOTS;
 if(screenshotDir){fs.mkdirSync(screenshotDir,{recursive:true});await win.webContents.executeJavaScript('document.documentElement.dataset.theme="light"');for(const surface of ['people','chat']){await win.webContents.executeJavaScript('window.presenceCenterTest.showSurface('+JSON.stringify(surface)+')');fs.writeFileSync(path.join(screenshotDir,'presence-'+surface+'-light.png'),(await win.webContents.capturePage()).toPNG());}await win.webContents.executeJavaScript('window.presenceCenterTest.showSurface("teams")');}
 for(const [locale,theme,width] of [['zh-CN','light',1050],['en','dark',1050],['ar','light',420],['zh-CN','dark',420]]){
  win.setSize(width,800);if(width===420)await win.webContents.executeJavaScript('window.presenceCenterTest.dockedNarrow()');await win.webContents.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(theme)};window.presenceCenterTest.setLocale(${JSON.stringify(locale)},{persist:false})`);await new Promise(r=>setTimeout(r,80));
  const overflow=await win.webContents.executeJavaScript(`(()=>{const n=document.getElementById('collaborationCenter');return n.scrollWidth>n.clientWidth+1;})()`);assert.equal(overflow,false,locale+'/'+theme+'/'+width+' no panel overflow');
  if(width===420)assert.equal(await win.webContents.executeJavaScript('document.getElementById("collaborationCenter").dataset.collaborationPanes'),'one','actual narrow docked/overlay shell uses one pane');
  if(screenshotDir){fs.mkdirSync(screenshotDir,{recursive:true});fs.writeFileSync(path.join(screenshotDir,`presence-${locale}-${theme}-${width}.png`),(await win.webContents.capturePage()).toPNG());}
 }
 assert.equal(await win.webContents.executeJavaScript('window.presenceCenterTest.clearAccount()'),true,'logout first frame removes every green');
 await win.webContents.executeJavaScript('window.presenceCenterTest.center.destroy()');
 console.log('actual presence center: friend/Team/direct header, in-place events, typing priority, logout, light/dark/narrow passed');
}).then(()=>{clearTimeout(timeout);win?.destroy();fs.rmSync(temp,{recursive:true,force:true});app.exit(0);}).catch(error=>{console.error(error);clearTimeout(timeout);win?.destroy();app.exit(1);});
