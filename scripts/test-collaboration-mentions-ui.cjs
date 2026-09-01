"use strict";
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");
if (!app?.whenReady) { console.error("Run with Electron"); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-mentions-ui-"));
app.setPath("userData", path.join(dir, "userData")); app.disableHardwareAcceleration();
let win;
const deadline = setTimeout(() => { console.error("mentions UI timed out"); finish(1); }, 30_000);
function finish(code) { clearTimeout(deadline); if (win && !win.isDestroyed()) win.destroy(); fs.rmSync(dir, { recursive: true, force: true }); app.exit(code); }
async function exerciseAuthorizationRefresh(moduleUrl) {
  const { initCollaborationCenter: init } = await import(new URL('./collaboration-center.js',moduleUrl));
  const { t } = await import(new URL('../i18n/index.js',moduleUrl));
  const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
  const check=(ok,why)=>{if(!ok)throw new Error(why);};
  for (const eventType of ['sync','access-revoked','bootstrap','relationship']) {
    document.body.replaceChildren();
    const make=(id,tag='div',parent=document.body)=>{const node=document.createElement(tag);node.id=id;parent.append(node);return node;};
    make('collaborationNavButton','button');make('workbenchNavButton','button');const shell=make('centerPanel'),panel=make('collaborationCenter','div',shell);
    for(const id of ['collaborationInbox','collaborationFriends','collaborationTeams','collaborationStatus','collaborationLive','collaborationTimeline'])make(id,'div',panel);
    make('collaborationComposer','textarea',panel);make('collaborationSendButton','button',panel);
    let publish,holdList=false,resolveList,holdCandidates=false,resolveCandidates;const writes=[];
    window.assistantClient={collaboration:{
      list:()=>holdList?new Promise(resolve=>{resolveList=resolve;}):Promise.resolve({ok:true,conversations:[{id:'A'}]}),
      getDirectory:async()=>({ok:true,profile:{userId:'self'},teams:[],friends:[]}),
      open:async id=>({ok:true,conversation:{id},messages:[{id:'m',conversationId:id,seq:1,bodyText:'no textual mention',mentionUserIds:['self']}]}),
      getDraft:async()=>({ok:true,text:'draft',replyToMessageId:null,mentionUserIds:[]}),saveDraft:value=>{writes.push(value);return Promise.resolve({ok:true});},
      getMentionCandidates:id=>holdCandidates?new Promise(resolve=>{resolveCandidates=resolve;}):Promise.resolve({ok:true,conversationId:id,mentionCandidates:{status:'complete',items:[{userId:'old',lilyId:'old-Lily',displayName:'OLD PROFILE',avatarObjectId:null}]}}),
      onStateChange:callback=>{publish=callback;return()=>{};},
    }};
    const center=init({getPolicy:async()=>({collaboration:{enabled:true}})});await tick();center.show();await tick();await center.open('A');await tick();
    check(document.querySelector('.collaboration-message-mentions').textContent===t('collaboration.mentions.you'),'actual center obtains current user from directory profile');
    document.getElementById('collaborationMentionButton').click();await tick();const old=document.querySelector('[data-action="select-mention"]');
    holdCandidates=true;holdList=true;publish({type:eventType,state:{ok:true}});old.click();
    check(writes.length===0 && !document.getElementById('collaborationMentionPicker').textContent.includes('OLD PROFILE'),'authorization hint immediately fences prior candidate before directory waits: '+eventType);
    await tick();resolveCandidates({ok:true,conversationId:'A',mentionCandidates:{status:'complete',items:[]}});await tick();
    center.destroy();resolveList?.({ok:true,conversations:[{id:'A'}]});await tick();
  }
}
async function prepareNativeKeyboard(moduleUrl) {
  const { initCollaborationComposer: init }=await import(moduleUrl);
  document.body.replaceChildren();const box=document.createElement('div');box.className='collaboration-composer';document.body.append(box);
  const textarea=document.createElement('textarea'),sendButton=document.createElement('button');box.append(textarea,sendButton);
  window.nativeMentions={writes:[],sends:[],imeFlag:'',trustedKeydowns:0};
  window.assistantClient={collaboration:{getDraft:async()=>({ok:true,text:'native',mentionUserIds:[]}),saveDraft:value=>{window.nativeMentions.writes.push(value);return Promise.resolve({ok:true});},send:value=>{window.nativeMentions.sends.push(value);return Promise.resolve({ok:false,code:'OFFLINE'});},getMentionCandidates:async id=>({ok:true,conversationId:id,mentionCandidates:{status:'complete',items:[{userId:'self',lilyId:'LILY-self',displayName:'Self',avatarObjectId:null}]}})}};
  window.nativeMentions.composer=init({textarea,sendButton});window.nativeMentions.composer.setConversation('native');await new Promise(resolve=>setTimeout(resolve,0));
  document.getElementById('collaborationMentionButton').focus();
}
async function exercise(moduleUrl) {
  const { initCollaborationComposer: init } = await import(moduleUrl);
  const { renderCollaborationTimeline: render } = await import(new URL('./collaboration-timeline.js', moduleUrl));
  const { t, setLocale } = await import(new URL('../i18n/index.js', moduleUrl));
  const check = (ok, why) => { if (!ok) throw new Error(why); };
  const equal = (a,b,why) => check(JSON.stringify(a) === JSON.stringify(b), why + ': ' + JSON.stringify(a));
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const defer = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
  const textarea = document.querySelector('textarea'), sendButton = document.querySelector('#send');
  const writes=[], sends=[]; let reads=0;
  const people = [{userId:'a',lilyId:'LILY-A',displayName:'Same',avatarObjectId:null},{userId:'b',lilyId:'LILY-B',displayName:'Same',avatarObjectId:null},{userId:'self',lilyId:'',displayName:'<img src=x onerror=alert(1)> https://untrusted.invalid',avatarObjectId:'object-safe'}];
  let candidateRead = id => Promise.resolve({ok:true,conversationId:id,mentionCandidates:{status:'complete',items:people}});
  let draftRead = () => Promise.resolve({ok:true,text:'draft',replyToMessageId:'reply',mentionUserIds:[]});
  let sendReply = () => Promise.resolve({ok:false,code:'OFFLINE'});
  window.assistantClient={collaboration:{getMentionCandidates:id=>{reads++;return candidateRead(id);},getDraft:id=>draftRead(id),saveDraft:value=>{writes.push(value);return Promise.resolve({ok:true});},send:value=>{sends.push(value);return sendReply(value);}}};
  const composer=init({textarea,sendButton}); composer.setConversation('A'); await tick();
  const picker=()=>document.getElementById('collaborationMentionPicker');
  const entry=()=>document.getElementById('collaborationMentionButton');
  const choose=id=>picker().querySelector('[data-action="select-mention"][data-user-id="'+id+'"]').click();
  const remove=id=>document.querySelector('[data-action="remove-mention"][data-user-id="'+id+'"]').click();
  const type=value=>{textarea.value=value;textarea.setSelectionRange(value.length,value.length);textarea.dispatchEvent(new Event('input'));};
  const key=(key,opts={})=>{const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...opts});textarea.dispatchEvent(event);return event;};
  check(entry()?.tagName==='BUTTON','inline reminder entry exists as native button');
  check(getComputedStyle(entry()).display==='none' && getComputedStyle(document.getElementById('collaborationMentionHint')).display==='none','manual reminder entry and permanent explanation stay out of the default composer');
  entry().focus();entry().click();await tick();check(document.activeElement===textarea,'entry opens a usable textarea keyboard selection path');key('Escape');
  type('hello @Sa'); await tick();
  check(!picker().hidden && picker().querySelectorAll('[data-action="select-mention"]').length===2,'@ query filters authorized candidates');
  check(picker().textContent.includes('LILY-A') && picker().textContent.includes('LILY-B'),'duplicate names disambiguated by stable identity');
  key('ArrowDown'); key('Enter');
  equal(writes.at(-1),{conversationId:'A',text:'hello ',replyToMessageId:'reply',mentionUserIds:['b']},'keyboard selection consumes only query and preserves reply intent');
  check(picker().hidden && document.activeElement===textarea,'selection closes and restores textarea focus');
  entry().click();await tick();choose('b'); equal(writes.at(-1).mentionUserIds,['b'],'duplicate selection is a set');
  entry().click();await tick();choose('a'); equal(writes.at(-1).mentionUserIds,['a','b'],'IDs use canonical sort');
  check(!document.querySelector('img,a'),'profiles and avatar never become markup or remote URLs');
  remove('a');equal(writes.at(-1).mentionUserIds,['b'],'remove preserves remaining IDs');
  type('mail@example.com');check(picker().hidden,'email does not trigger picker');
  type('middle@Same');check(picker().hidden,'middle @ does not trigger picker');
  type('plain @someone');await tick();check(!picker().hidden && picker().textContent.includes(t('collaboration.mentions.noMatch')),'empty query results have explicit state');
  const count=sends.length;check(key('Enter').defaultPrevented && sends.length===count,'empty popup Enter cannot send');key('Escape');
  type('same body');sendButton.click();await tick();sendButton.click();await tick();check(sends.at(-1).clientCommandId===sends.at(-2).clientCommandId,'failed complete intent retry retains UUID');
  const oldId=sends.at(-1).clientCommandId;entry().click();await tick();choose('a');sendButton.click();await tick();check(sends.at(-1).clientCommandId!==oldId,'same body different mention set gets new UUID');
  const ack=defer();sendReply=()=>ack.promise;sendButton.click();await tick();remove('a');ack.resolve({ok:true});await tick();check(textarea.value==='same body' && writes.at(-1).mentionUserIds[0]==='b','late ACK cannot clear newer mention set');
  candidateRead=id=>Promise.resolve({ok:true,conversationId:id,mentionCandidates:{status:'unknown',items:[]}});entry().click();await tick();
  check(picker().textContent.includes(t('collaboration.mentions.unknown')) && document.querySelector('[data-action="remove-mention"][data-user-id="b"]'),'unknown keeps existing IDs removable');key('Escape');
  candidateRead=()=>Promise.reject(new Error('offline'));entry().click();await tick();check(picker().textContent.includes(t('collaboration.mentions.failed')),'candidate failure is local explicit state');
  const errorReads=reads;type('x @S');type('x @Sa');await tick();check(reads===errorReads,'typing after failure never retries network');key('Tab');check(picker().hidden,'Tab closes');
  const pending=defer();candidateRead=()=>pending.promise;entry().click();const loadingReads=reads;
  for(const value of ['x @','x @S','x @Sa'])type(value);
  check(reads===loadingReads,'quick query edits do not restart candidate fetch');check(key('Enter').defaultPrevented,'loading popup Enter suppressed');
  for(const options of [{isComposing:true},{keyCode:229},{shiftKey:true}])key('Enter',options);
  check(sends.length===count+4,'IME and ShiftEnter do not send');
  pending.resolve({ok:true,conversationId:'A',mentionCandidates:{status:'complete',items:people}});await tick();key('Escape');
  candidateRead=id=>Promise.resolve({ok:true,conversationId:id,mentionCandidates:{status:'complete',items:Array.from({length:1000},(_,i)=>({userId:'u'+String(i).padStart(4,'0'),lilyId:'',displayName:'',avatarObjectId:null}))}});
  entry().click();await tick();check(picker().querySelectorAll('[data-action="select-mention"]').length===1000,'all 1000 candidates reachable');
  check(document.getElementById('collaborationMentionTags').textContent.includes(t('collaboration.mentions.unavailable')),'complete absence marks old ID unavailable without deletion');
  choose('u0999');check(writes.at(-1).mentionUserIds.includes('u0999'),'last candidate selectable');
  type('x @u000');await tick();textarea.setSelectionRange(0,0);choose('u0000');check(textarea.value==='x @u000','stale caret query cannot delete body');
  const late=defer();candidateRead=()=>late.promise;entry().click();await tick();const detached=entry();composer.setActive(false);const n=reads;detached.click();late.resolve({ok:true,conversationId:'A',mentionCandidates:{status:'complete',items:people}});await tick();check(reads===n && !document.body.textContent.includes('LILY-A'),'hidden clears PII and fences entry/response');
  composer.setActive(true);candidateRead=id=>Promise.resolve({ok:true,conversationId:id,mentionCandidates:{status:'complete',items:people}});entry().click();await tick();const oldChoice=picker().querySelector('[data-action="select-mention"]');composer.reset();oldChoice.click();check(textarea.value==='' && !document.querySelector('[data-action="remove-mention"]'),'reset fences detached choice');
  const restore=defer();draftRead=()=>restore.promise;composer.setConversation('late');type('typed first');restore.resolve({ok:true,text:'OLD',replyToMessageId:'old',mentionUserIds:['old']});await tick();check(textarea.value==='typed first' && !document.querySelector('[data-user-id="old"]'),'late restore cannot overwrite typing');
  const timeline=document.getElementById('timeline');const msg={id:'m',seq:1,bodyText:'@self is only text',mentionUserIds:['a','self']};render(timeline,[msg],{currentUserId:'self'});const row=timeline.firstChild,body=row.querySelector('.collaboration-message-body');
  check(row.querySelector('.collaboration-message-mentions')?.textContent===t('collaboration.mentions.you'),'explicit current user reminder shown');
  render(timeline,[{...msg,mentionUserIds:['a']}],{currentUserId:'self'});check(row===timeline.firstChild && body===row.querySelector('.collaboration-message-body') && row.querySelector('.collaboration-message-mentions').textContent===t('collaboration.mentions.count',{count:1}),'keyed timeline preserves body and only explicit metadata count');
  render(timeline,[{...msg,visibilityMask:'unavailable'}],{currentUserId:'self'});check(!row.querySelector('.collaboration-message-mentions'),'masked message hides reminder');
  render(timeline,[{...msg,mentionUserIds:[]}],{currentUserId:'self'});check(!row.querySelector('.collaboration-message-mentions'),'body @ never inferred');
  composer.destroy();
  const restoredIds=Array.from({length:1000},(_,i)=>'u'+String(i).padStart(4,'0'));
  draftRead=()=>Promise.resolve({ok:true,text:'retained',replyToMessageId:'source',mentionUserIds:restoredIds});
  const allPeople=restoredIds.map(userId=>({userId,lilyId:'',displayName:'Person '+userId,avatarObjectId:null}));
  candidateRead=id=>Promise.resolve({ok:true,conversationId:id,mentionCandidates:{status:'complete',items:[{userId:'extra',lilyId:'',displayName:'Extra',avatarObjectId:null}]}});
  const restored=init({textarea,sendButton});restored.setConversation('restored');await tick();await tick();
  check(document.querySelectorAll('[data-action="remove-mention"]').length===1000,'all restored IDs stay individually removable');
  entry().click();await tick();const beforeLimit=writes.length;choose('extra');
  check(writes.length===beforeLimit && picker().textContent.includes(t('collaboration.mentions.limit')),'1000-selected limit rejects explicitly without truncating saved intent');key('Escape');
  const tagBox=document.getElementById('collaborationMentionTags');
  check(tagBox.getBoundingClientRect().height<=160 && tagBox.scrollHeight>tagBox.clientHeight,'1000 tags use bounded scroll without pushing composer off screen');
  restored.destroy();
  candidateRead=id=>Promise.resolve({ok:true,conversationId:id,mentionCandidates:{status:'complete',items:allPeople}});
  draftRead=()=>Promise.resolve({ok:true,text:'restored names',replyToMessageId:null,mentionUserIds:['u0999']});
  const named=init({textarea,sendButton});named.setConversation('named');await tick();await tick();
  check(document.getElementById('collaborationMentionTags').textContent.includes('Person u0999'),'late restored IDs obtain fresh authorized profile labels');
  named.destroy();
  const longId='user-'+ 'L'.repeat(195);
  draftRead=()=>Promise.resolve({ok:true,text:'unchanged',replyToMessageId:null,mentionUserIds:[longId]});
  candidateRead=id=>Promise.resolve({ok:true,conversationId:id,mentionCandidates:{status:'complete',items:[{userId:longId,lilyId:'',displayName:'Name'.repeat(125),avatarObjectId:null}]}});
  const localized=init({textarea,sendButton});localized.setConversation('localized');await tick();await tick();
  for(const language of ['zh-CN','en','ar']){
    await setLocale(language,{persist:false});entry().click();await tick();
    check(entry().getAttribute('aria-label')===t('collaboration.mentions.action') && document.getElementById('collaborationMentionHint').textContent===t('collaboration.mentions.hint'),'translated entry and explicit binding hint '+language);
    check(document.documentElement.dir===(language==='ar'?'rtl':'ltr'),'locale direction '+language);
    check(document.documentElement.scrollWidth<=document.documentElement.clientWidth && picker().getBoundingClientRect().width<=document.documentElement.clientWidth,'long identity and small-window picker never overflow '+language);
    check(document.querySelector('[data-action="remove-mention"]').getAttribute('aria-label').includes('Name'),'translated remove labels identify the member');
    key('Escape');
  }
  candidateRead=()=>Promise.reject(new Error('offline'));entry().click();await tick();
  const retryButton=picker().querySelector('[data-action="retry-mentions"]');check(!retryButton.hidden,'failed candidates provide manual retry');
  candidateRead=id=>Promise.resolve({ok:true,conversationId:id,mentionCandidates:{status:'complete',items:[]}});const beforeRetry=reads;retryButton.click();await tick();check(reads===beforeRetry+1 && picker().textContent.includes(t('collaboration.mentions.noMatch')),'manual retry reads once and recovers empty complete list');key('Escape');
  delete window.assistantClient.collaboration.getMentionCandidates;entry().click();await tick();check(picker().textContent.includes(t('collaboration.mentions.unknown')) && document.querySelector('[data-action="remove-mention"]'),'missing old API stays unknown and retains IDs');
  localized.destroy();
}
app.whenReady().then(async()=>{
  const css=pathToFileURL(path.join(__dirname,'../src/renderer/styles/collaboration.css')).href;
  const page=path.join(dir,'test.html');fs.writeFileSync(page,'<!doctype html><html><head><link rel="stylesheet" href="'+css+'"></head><body><div id="timeline"></div><div class="collaboration-composer"><textarea></textarea><button id="send">Send</button></div></body></html>');
  win=new BrowserWindow({show:false,width:460,height:640,webPreferences:{sandbox:true,contextIsolation:true}});await win.loadFile(page);
  await win.webContents.executeJavaScript(`(${exercise.toString()})(${JSON.stringify(pathToFileURL(path.join(__dirname,'../src/renderer/modules/collaboration-composer.js')).href)})`);
  const url=pathToFileURL(path.join(__dirname,'../src/renderer/modules/collaboration-composer.js')).href;
  await win.webContents.executeJavaScript(`(${exerciseAuthorizationRefresh.toString()})(${JSON.stringify(url)})`);
  await win.webContents.executeJavaScript(`(${prepareNativeKeyboard.toString()})(${JSON.stringify(url)})`);
  win.show();win.focus();win.webContents.focus();
  const press=async key=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:key});win.webContents.sendInputEvent({type:'char',keyCode:key==='Enter'?'\r':' '});win.webContents.sendInputEvent({type:'keyUp',keyCode:key});await new Promise(resolve=>setTimeout(resolve,25));};
  // Electron cannot supply IME flags. Annotate trusted keydowns while retaining
  // Chromium's real button default activation; this is not full OS IME coverage.
  await win.webContents.executeJavaScript(`document.addEventListener('keydown',event=>{
    const state=window.nativeMentions;
    if(!state.imeFlag)return;
    if(event.isTrusted)state.trustedKeydowns++;
    Object.defineProperty(event,state.imeFlag,{value:state.imeFlag==='isComposing'?true:229});
  },true)`);
  const imeFailures=[];
  for(const flag of ['isComposing','keyCode'])for(const key of ['Enter','Space'])for(const control of ['option','remove','close']){
    await win.webContents.executeJavaScript('window.nativeMentions.composer.destroy()');
    await win.webContents.executeJavaScript(`(${prepareNativeKeyboard.toString()})(${JSON.stringify(url)})`);
    await win.webContents.executeJavaScript(`(async()=>{
      document.getElementById('collaborationMentionButton').click();await new Promise(resolve=>setTimeout(resolve,0));
      if(${JSON.stringify(control)}==='remove')document.querySelector('[data-action="select-mention"]').click();
      const selectors={option:'[data-action="select-mention"]',remove:'[data-action="remove-mention"]',close:'[data-action="close-mentions"]'};
      document.querySelector(selectors[${JSON.stringify(control)}]).focus();
      window.nativeMentions.writes=[];window.nativeMentions.imeFlag=${JSON.stringify(flag)};
    })()`);
    await press(key);
    const result=await win.webContents.executeJavaScript(`({writes:window.nativeMentions.writes.length,sends:window.nativeMentions.sends.length,trusted:window.nativeMentions.trustedKeydowns,open:!document.getElementById('collaborationMentionPicker').hidden})`);
    if(result.writes || result.sends || result.trusted!==1 || result.open!==['option','close'].includes(control))imeFailures.push({flag,key,control,...result});
  }
  if(imeFailures.length)throw new Error('IME-marked native controls must not activate, choose, remove, close or send: '+JSON.stringify(imeFailures));
  await win.webContents.executeJavaScript('window.nativeMentions.imeFlag=""');
  await win.webContents.executeJavaScript('document.querySelector("[data-action=close-mentions]").click()');
  for(const key of ['Enter','Space']){
    await win.webContents.executeJavaScript(`(()=>{const area=document.querySelector('textarea');area.value='@';area.focus();area.setSelectionRange(1,1);area.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'@'}));})()`);
    await new Promise(resolve=>setTimeout(resolve,25));
    const open=await win.webContents.executeJavaScript("!document.getElementById('collaborationMentionPicker').hidden && document.activeElement.tagName==='TEXTAREA'");if(!open)throw new Error('typing @ opens keyboard selection');
    await win.webContents.executeJavaScript("document.querySelector('[data-action=\"select-mention\"]').focus()");
    await press(key);
    const selected=await win.webContents.executeJavaScript("window.nativeMentions.writes.at(-1)?.mentionUserIds.includes('self')");if(!selected)throw new Error('native option '+key+' chooses self');
    await win.webContents.executeJavaScript("document.querySelector('[data-action=\"remove-mention\"]').focus()");await press(key);
    const removed=await win.webContents.executeJavaScript("window.nativeMentions.writes.at(-1).mentionUserIds.length===0");if(!removed)throw new Error('native remove '+key+' removes explicit ID');
  }
  await win.webContents.executeJavaScript('window.nativeMentions.composer.destroy()');
  console.log('collaboration mentions UI: real Electron DOM passed (controlled preload; not full two-client acceptance)');
}).then(()=>finish(0)).catch(error=>{console.error(error);finish(1);});
