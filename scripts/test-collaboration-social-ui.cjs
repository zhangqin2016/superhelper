"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
if (!app?.whenReady) { console.error('Run with Electron'); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-dom-'));
app.setPath('userData', path.join(dir, 'data')); app.disableHardwareAcceleration();
let win;
const deadline = setTimeout(() => finish(1), 40000);
function finish(code) { clearTimeout(deadline); win?.destroy(); fs.rmSync(dir, { recursive: true, force: true }); app.exit(code); }
app.whenReady().then(async () => {
  const page = path.join(dir, 'index.html');
  fs.writeFileSync(page, '<!doctype html><div id="friends"></div><div id="teams"></div>');
  win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadFile(page);
  const url = (name) => pathToFileURL(path.join(__dirname, '../src/renderer/modules/', name)).href;
  const result = await win.webContents.executeJavaScript(`(async () => {
    const { initCollaborationFriends } = await import(${JSON.stringify(url('collaboration-friends.js'))});
    if (typeof initCollaborationFriends !== 'function') throw Error('Friends controller is missing');
    const { initCollaborationTeams } = await import(${JSON.stringify(url('collaboration-teams.js'))});
    const root = document.getElementById('friends'), teamsRoot = document.getElementById('teams');
    const calls = [], opened = [];
    let mode = 'completed', resolveLate;
    const api = { friend: async (input) => { calls.push(input); if (mode === 'late') return new Promise(r=>resolveLate=r); return {ok:mode!=='failed',state:mode,clientCommandId:'durable',code:mode==='failed'?'COLLAB_INVITE_FORBIDDEN':undefined}; },
      retrySocial: async (id) => { calls.push({retry:id}); return {ok:true,state:'completed'}; },
      openFriend: async (id) => { calls.push({peer:id}); return {ok:true,conversationId:'canonical'}; },
      conversation: async (input) => { calls.push(input); return mode==='failed'?{ok:false,state:'failed',code:'COLLAB_INVITE_FORBIDDEN'}:{ok:true,state:'completed',conversationId:'created'}; },
      getConversationDetails: async (id) => ({ok:true,conversation:{id,scopeId:'team:org',kind:'channel',title:'Private'},visibility:'private',canManage:true,members:[{userId:'self',role:'owner'},{userId:'peer',role:'member'}]}),
    };
    const directory={profile:{userId:'self',lilyId:'my-exact-id'},contacts:[{userId:'peer',lilyId:'peer-id',displayName:'<img src=x>',relationship:'friend',ownBlocked:false},
      {userId:'incoming',lilyId:'in-id',relationship:'incoming',requestId:'req',ownBlocked:false},{userId:'outgoing',relationship:'outgoing',requestId:'out',ownBlocked:false},
      {userId:'blocked',relationship:null,ownBlocked:true}],teams:[{id:'org',scopeId:'team:org',name:'Exact Team',role:'member',members:[{userId:'self',displayName:'Me'},{userId:'peer',lilyId:'peer-id',displayName:'Peer'}]}]};
    const settle=()=>new Promise(r=>setTimeout(r,20));
    const friends=initCollaborationFriends(root,{api,onChanged:async()=>{},onOpen:id=>opened.push(id)});
    friends.update({directory,commands:[{kind:'friend',clientCommandId:'restarted',state:'confirming',input:{action:'request',lilyId:'restored-id'}}]});
    const ownId=root.textContent.includes('my-exact-id'), safe=!root.querySelector('img');
    const input=root.querySelector('[name="lilyId"]'); input.value='Exact-ID';
    root.querySelector('form').requestSubmit(); await settle();
    const request=calls.at(-1);
    root.querySelector('[data-action="accept"]').click(); await settle(); const accept=calls.at(-1);
    root.querySelector('[data-action="chat"]').click(); await settle();
    const before=calls.length; root.querySelector('[data-action="block"]').click(); await settle();
    const notBeforeConfirm=calls.length===before;
    root.querySelector('[data-action="confirm"]').click(); await settle(); const block=calls.at(-1);
    root.querySelector('[data-action="unblock"]').click(); await settle(); root.querySelector('[data-action="confirm"]').click(); await settle(); const unblock=calls.at(-1);
    root.querySelector('[data-action="retry"]').click(); await settle(); const retry=calls.at(-1);
    input.value='keep-id'; mode='confirming'; root.querySelector('form').requestSubmit(); await settle();
    const retained=input.value, confirming=root.querySelector('[role="status"]').textContent;
    mode='late'; input.value='old-account'; root.querySelector('form').requestSubmit(); await settle(); friends.reset();
    resolveLate({ok:true,state:'completed',conversationId:'foreign'}); await settle();
    const fenced=root.textContent.includes('my-exact-id')===false && input.value==='';
    mode='completed'; const teams=initCollaborationTeams(teamsRoot,{api,onChanged:async()=>{},onOpen:id=>opened.push(id)});
    teams.update({directory,conversations:[{id:'private',scopeId:'team:org',kind:'channel',title:'Private'}],commands:[{kind:'conversation',scopeId:'team:org',state:'confirming',clientCommandId:'team-pending',input:{action:'create',scopeType:'organization',organizationId:'org',kind:'channel',visibility:'private',title:'Pending'}}]});
    const pendingScopeLabel=teamsRoot.querySelector('.collaboration-pending').textContent.includes('Exact Team · team:org');
    const scopeLabel=teamsRoot.textContent.includes('Exact Team')&&teamsRoot.textContent.includes('team:org');
    const publicUnavailable=!teamsRoot.querySelector('[data-team-id="org"] option[value="public"]');
    teamsRoot.querySelector('[data-action="team-chat"]').click(); await settle(); const direct=calls.at(-1);
    const groupForm=teamsRoot.querySelector('[data-form="group"]'); groupForm.querySelector('[name="title"]').value='Personal group'; groupForm.requestSubmit(); await settle(); const group=calls.at(-1);
    const channelForm=teamsRoot.querySelector('[data-form="channel"]'); channelForm.querySelector('[name="title"]').value='Private channel'; channelForm.requestSubmit(); await settle(); const channel=calls.at(-1);
    await teams.showConversation('private');
    const ownerImmutable=!teamsRoot.querySelector('[data-user-id="self"] [data-action="remove-member"]');
    teamsRoot.querySelector('[data-action="remove-member"]').click(); await settle(); teamsRoot.querySelector('[data-action="confirm"]').click(); await settle(); const remove=calls.at(-1);
    mode='failed'; channelForm.querySelector('[name="title"]').value='Permission denied'; channelForm.requestSubmit(); await settle();
    const permission=teamsRoot.querySelector('[role="status"]').textContent;
    teams.update({directory:{...directory,teams:[]},conversations:[],commands:[]});
    const revokedMembersCleared=!teamsRoot.querySelector('[data-action="remove-member"]');
    let releaseDetails;const oldDetails=api.getConversationDetails;api.getConversationDetails=()=>new Promise(r=>releaseDetails=r);
    const lateDetails=teams.showConversation('private');teams.update({directory:{...directory,teams:[]},conversations:[],commands:[]});
    releaseDetails(await oldDetails('private'));await lateDetails;const lateRevokedMembersCleared=!teamsRoot.querySelector('[data-action="remove-member"]');api.getConversationDetails=oldDetails;
    teams.reset();
    mode='completed';
    const liveTeams=initCollaborationTeams(teamsRoot,{api,onChanged:async()=>liveTeams.update({directory,conversations:[],commands:[]})});
    liveTeams.update({directory,conversations:[],commands:[]});
    teamsRoot.querySelector('[data-form="channel"] [name="title"]').value='Submitted once';
    teamsRoot.querySelector('[data-form="channel"]').requestSubmit();await settle();
    const confirmedDraftCleared=teamsRoot.querySelector('[data-form="channel"] [name="title"]').value==='';
    liveTeams.reset();
    const {createSocialUi}=await import(${JSON.stringify(url('collaboration-social-ui.js'))});
    let releaseRefresh;const refreshGate=new Promise(r=>releaseRefresh=r), ui=createSocialUi(teamsRoot,{onChanged:()=>refreshGate});let dispatchCount=0;
    const operation=()=>{dispatchCount++;return Promise.resolve({ok:true,state:'completed'});};
    const inProgress=ui.run(operation);await settle();const secondDispatch=ui.run(operation);await settle();const duplicateSuppressed=dispatchCount===1;releaseRefresh();await Promise.all([inProgress,secondDispatch]);ui.reset();
    const { initCollaborationCenter } = await import(${JSON.stringify(url('collaboration-center.js'))});
    document.body.replaceChildren();
    for (const [tag,id] of [['button','collaborationNavButton'],['button','workbenchNavButton'],['div','centerPanel'],['div','collaborationCenter'],['div','collaborationInboxColumn'],['div','collaborationInbox'],['div','collaborationFriends'],['div','collaborationTeams'],['button','collaborationInboxTab'],['button','collaborationPeopleTab'],['button','collaborationTeamsTab'],['h2','collaborationListTitle'],['div','collaborationStatus'],['div','collaborationLive'],['div','collaborationScopeBadge'],['div','collaborationTimeline'],['div','collaborationConversationEmpty'],['textarea','collaborationComposer'],['button','collaborationSendButton']]) {const n=document.createElement(tag);n.id=id;document.body.append(n);}
    let publish;window.assistantClient={collaboration:{...api,list:async()=>({ok:true,conversations:[]}),getDirectory:async()=>({ok:true,...directory}),getSocialCommands:async()=>({ok:true,commands:[]}),bootstrap:async()=>({ok:true}),onStateChange:cb=>{publish=cb;return()=>{};}}};
    const center=initCollaborationCenter({getPolicy:async()=>({collaboration:{enabled:true}})});center.show();await settle();
    document.getElementById('collaborationPeopleTab').click();await settle();
    const shellPeople=!document.getElementById('collaborationFriends').hidden&&document.getElementById('collaborationFriends').textContent.includes('my-exact-id');
    document.getElementById('collaborationTeamsTab').click();await settle();
    const shellTeams=!document.getElementById('collaborationTeams').hidden&&document.getElementById('collaborationTeams').textContent.includes('team:org');
    publish({type:'availability',state:{ok:false}});await settle();
    const unavailablePreservesWorkbench=document.getElementById('collaborationCenter').hidden&&!document.getElementById('centerPanel').classList.contains('collaboration-active')&&!document.getElementById('collaborationFriends').textContent.includes('my-exact-id');
    center.destroy();
    return {ownId,safe,request,accept,opened,notBeforeConfirm,block,unblock,retry,retained,confirming,fenced,scopeLabel,publicUnavailable,direct,group,channel,ownerImmutable,remove,permission,shellPeople,shellTeams,unavailablePreservesWorkbench,revokedMembersCleared,confirmedDraftCleared,duplicateSuppressed,lateRevokedMembersCleared,pendingScopeLabel};
  })()`);
  assert.equal(result.ownId, true); assert.equal(result.safe, true);
  assert.deepEqual(result.request, { action: 'request', lilyId: 'Exact-ID' });
  assert.deepEqual(result.accept, { action: 'respond', requestId: 'req', accept: true });
  assert.ok(result.opened.includes('canonical')); assert.equal(result.notBeforeConfirm, true);
  assert.deepEqual(result.block, { action: 'block', peerUserId: 'peer' }); assert.deepEqual(result.unblock, { action: 'unblock', peerUserId: 'blocked' });
  assert.deepEqual(result.retry, { retry: 'restarted' }); assert.equal(result.retained, 'keep-id'); assert.match(result.confirming, /confirming/);
  assert.equal(result.fenced, true); assert.equal(result.scopeLabel, true); assert.equal(result.publicUnavailable, true);
  assert.deepEqual(result.direct, { action:'create',scopeType:'organization',organizationId:'org',kind:'direct',memberUserIds:['peer'] });
  assert.equal(result.group.scopeType, 'personal'); assert.equal(result.group.kind, 'group');
  assert.equal(result.channel.organizationId, 'org'); assert.equal(result.channel.visibility, 'private');
  assert.equal(result.ownerImmutable, true); assert.deepEqual(result.remove,{action:'member',conversationId:'private',targetUserId:'peer',operation:'remove'});
  assert.match(result.permission, /permissionDenied/);
  assert.equal(result.revokedMembersCleared,true,'revoked Team clears cached member controls');assert.equal(result.confirmedDraftCleared,true,'snapshot refresh cannot revive a confirmed creation form');assert.equal(result.duplicateSuppressed,true,'refresh window remains single-intent busy');
  assert.equal(result.lateRevokedMembersCleared,true,'late authorized detail response cannot recreate removed Team controls');
  assert.equal(result.pendingScopeLabel,true,'pending recovery shows both Team name and scope');
  assert.equal(result.shellPeople,true,'friends navigation reaches actual controls');assert.equal(result.shellTeams,true,'Team navigation reaches current scope');assert.equal(result.unavailablePreservesWorkbench,true,'unavailable clears account data and restores workbench');
  console.log('collaboration social actual Electron DOM passed');
}).then(()=>finish(0)).catch(error=>{console.error(error);finish(1);});
