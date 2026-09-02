"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
if (!app?.whenReady) { console.error('Run with Electron'); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-navigation-'));
app.setPath('userData', path.join(dir, 'data')); app.disableHardwareAcceleration();
let win;
const deadline = setTimeout(() => finish(1), 30000);
function finish(code) { clearTimeout(deadline); win?.destroy(); fs.rmSync(dir, { recursive: true, force: true }); app.exit(code); }
app.whenReady().then(async () => {
  const page = path.join(dir, 'index.html'); fs.writeFileSync(page, '<!doctype html><body></body>');
  win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } }); await win.loadFile(page);
  const moduleUrl = pathToFileURL(path.join(__dirname, '../src/renderer/modules/collaboration-center.js')).href;
  const result = await win.webContents.executeJavaScript(`(async () => {
    const {initCollaborationCenter}=await import(${JSON.stringify(moduleUrl)});
    for(const id of ['collaborationNavButton','workbenchNavButton','centerPanel','collaborationCenter','collaborationInboxColumn','collaborationInbox','collaborationFriends','collaborationTeams','collaborationInboxTab','collaborationPeopleTab','collaborationTeamsTab','collaborationListTitle','collaborationStatus','collaborationLive','collaborationScopeBadge','collaborationTimeline','collaborationConversationEmpty','collaborationComposer','collaborationSendButton']){const n=document.createElement(id==='collaborationComposer'?'textarea':id.endsWith('Tab')||id.endsWith('Button')?'button':'div');n.id=id;document.body.append(n);}
    const directory={ok:true,profile:{userId:'self',lilyId:'self-id'},contacts:[],teams:[{id:'org',scopeId:'team:org',name:'Team',role:'member',members:[{userId:'self'},{userId:'peer'}]}]};
    const opened=[],commands=[];let resolve;
    window.assistantClient={collaboration:{getDirectory:async()=>directory,getSocialCommands:async()=>({ok:true,commands:[]}),list:async()=>({ok:true,conversations:[{id:'B',scopeId:'personal',kind:'group'}]}),
      onStateChange:()=>()=>{},getDraft:async()=>({ok:true,text:'B draft'}),saveDraft:async()=>({ok:true}),
      open:async id=>{opened.push(id);return{ok:true,conversation:{id,title:id,scopeId:'personal'},messages:[]};},
      conversation:input=>{commands.push(input);return new Promise(r=>resolve=r);},
    }};
    const tick=()=>new Promise(r=>setTimeout(r,25));const center=initCollaborationCenter({getPolicy:async()=>({collaboration:{enabled:true}})});
    center.show();await tick();
    async function start(kind='direct'){document.getElementById('collaborationTeamsTab').click();await tick();if(kind==='direct'){/* The roster moved out of the list: a team of any size made the channels unreachable. Open it first. */document.querySelector('[data-action="open-team"]').click();await tick();document.querySelector('[data-action="team-chat"]').click();}else{const form=document.querySelector('[data-form="'+kind+'"]');form.querySelector('[name="title"]').value='Pending '+kind;form.requestSubmit();}await tick();}
    await start();await center.open('B');await tick();resolve({ok:true,state:'completed',conversationId:'A-manual'});await tick();
    const manual=[...opened],draft=document.getElementById('collaborationComposer').value;
    await start('group');center.hide();resolve({ok:true,state:'completed',conversationId:'A-hidden'});await tick();const hidden=[...opened],workbench=document.getElementById('collaborationCenter').hidden;
    center.show();await tick();await start('channel');document.getElementById('collaborationInboxTab').click();await tick();resolve({ok:true,state:'completed',conversationId:'A-tab'});await tick();const tab=[...opened];
    await start();resolve({ok:true,state:'completed',conversationId:'A-current'});await tick();const current=[...opened];
    center.destroy();return{manual,draft,hidden,workbench,tab,current,commands:commands.length};
  })()`);
  assert.deepEqual(result.manual,['B'],'late social completion cannot replace a manually opened conversation');
  assert.equal(result.draft,'B draft','manual conversation draft remains owned by B');
  assert.deepEqual(result.hidden,['B'],'workbench navigation invalidates pending social navigation');assert.equal(result.workbench,true);
  assert.deepEqual(result.tab,['B'],'switching sections invalidates pending social navigation');
  assert.deepEqual(result.current,['B','A-current'],'completion still opens its result when user navigation is unchanged');
  assert.equal(result.commands,4,'navigation fences do not cancel or duplicate submitted commands');
  console.log('collaboration social actual center navigation fences passed');
}).then(()=>finish(0)).catch(error=>{console.error(error);finish(1);});
