"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain } = require("electron");
const { createFixture } = require("./lib/remote-task-ui-fixture.cjs");
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "remote-task-dual-ui-")));
app.setPath("userData", path.join(temporary, "electron")); app.disableHardwareAcceleration();
const windows = [], identities = new Map();
let fixture;
const timeout = setTimeout(() => { console.error("dual-client UI acceptance timed out"); finish(1); }, 90000);
function finish(code) {
  clearTimeout(timeout); for (const win of windows) if (!win.isDestroyed()) win.destroy();
  try { fixture?.close(); require('./lib/electron-test-cleanup.cjs')(temporary); } catch (error) { console.error(error); code = 1; } app.exit(code);
}
const renderer = path.resolve(__dirname, "../src/renderer");
const url = file => pathToFileURL(path.join(renderer, file)).href;
async function waitFor(win, expression, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error(`${label}: ${await win.webContents.executeJavaScript("document.body.innerText")}`);
}
async function click(win, selector) {
  await waitFor(win, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&!e.disabled&&e.getClientRects().length>0&&!e.closest('[hidden]')})()`, `button not available ${selector}`);
  // Native input events: renderer business methods are never called by the driver.
  const point = await win.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  win.webContents.sendInputEvent({ type: "mouseMove", ...point });
  await waitFor(win, `document.querySelector(${JSON.stringify(selector)})?.contains(document.elementFromPoint(${point.x},${point.y}))`, `target covered ${selector}`);
  win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
  win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
}
const action = (win, name) => click(win, `[data-action="${name}"]`);
function assertOriginalSource(label) {
  assert.equal(fs.readFileSync(path.join(fixture.source, "budget.txt"), "utf8"), "original budget\n", label);
  assert.equal(fs.readFileSync(path.join(fixture.source, "remove.txt"), "utf8"), "remove only with consent\n", label);
  assert.equal(fs.existsSync(path.join(fixture.source, "evidence.txt")), false, label);
}
async function capture(win, name) {
  if (!process.env.REMOTE_TASK_UI_SCREENSHOTS) return;
  await win.webContents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  const output = path.resolve(process.env.REMOTE_TASK_UI_SCREENSHOTS); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG());
}
async function fill(win, name, value) {
  await click(win, `.remote-tasks [name="${name}"]`);
  await win.webContents.insertText(value);
}
async function makeWindow(accountId) {
  const account = fixture.account(accountId), preload = path.join(temporary, `${accountId}-preload.cjs`);
  fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('taskFixture',{invoke:(channel,payload)=>ipcRenderer.invoke('dual-ui-command',channel,payload)});`);
  const page = path.join(temporary, `${accountId}.html`);
  fs.writeFileSync(page, `<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="${url("styles.css")}"><body${accountId === "helper" ? ' data-app-view="collaboration"' : ""}></body></html>`);
  const win = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { contextIsolation: true, sandbox: true, preload, backgroundThrottling: false, partition: `dual-ui-${accountId}` } });
  windows.push(win); identities.set(win.webContents.id, account); await win.loadFile(page);
  await win.webContents.executeJavaScript(`(async()=>{
    const real=new DOMParser().parseFromString(${JSON.stringify(fs.readFileSync(path.join(renderer, "index.html"), "utf8"))},'text/html');
    if(${JSON.stringify(accountId)}==='owner') {
      real.querySelectorAll('script').forEach(script=>script.remove());document.body.append(...real.body.childNodes);
    } else {
      document.body.append(real.getElementById('collaborationCenter'));
      for(const id of ['collaborationPanelToggle','collaborationNavButton','workbenchNavButton','centerPanel']){const n=document.createElement('div');n.id=id;document.body.append(n);}
    }
    const invoke=(channel,payload)=>window.taskFixture.invoke('collaboration:'+channel,payload);
    const peer=${JSON.stringify(accountId === "owner" ? "helper" : "owner")};
    window.assistantClient={focusSession:async()=>({ok:true}),getAccountStatus:async()=>({loggedIn:true,user:{id:${JSON.stringify(accountId)}}}),collaboration:{
      onStateChange:()=>()=>{},getState:async()=>({ok:true}),getDirectory:async()=>({ok:true,profile:{userId:${JSON.stringify(accountId)}},contacts:[{userId:peer,displayName:peer,relationship:'friend'}],teams:[]}),
      getSocialCommands:async()=>({ok:true,commands:[]}),list:async()=>({ok:true,conversations:[{id:'chat',scopeId:'personal',kind:'direct',title:peer}]}),
      getDraft:async()=>({ok:true,text:''}),saveDraft:async()=>({ok:true}),
      open:async(id,_before,options)=>options?.cached?{ok:false}:{ok:true,conversation:{id,title:peer,scopeId:'personal',kind:'direct'},messages:[]},
      getConversationDetails:async()=>({ok:true,members:[{userId:'owner',displayName:'Owner'},{userId:'helper',displayName:'Helper'}]}),
      openFriend:async()=>({ok:true,conversationId:'chat'}),
      taskWorkflow:c=>invoke('task-workflow',c),listTasks:conversationId=>invoke('list-tasks',{conversationId}),
      getTask:payload=>invoke('get-task',payload),getTaskCommands:conversationId=>invoke('get-task-commands',{conversationId}),
      changeTask:c=>invoke('change-task',c),retryTask:clientCommandId=>invoke('retry-task',{clientCommandId})
    }};
    const {setLocale}=await import(${JSON.stringify(url("i18n/index.js"))});await setLocale('en',{persist:false});
    const {initCollaborationCenter}=await import(${JSON.stringify(url("modules/collaboration-center.js"))});
    const center=initCollaborationCenter({getPolicy:async()=>({collaboration:{enabled:true,tasks:true,workspaceShares:true}})});
    if(${JSON.stringify(accountId)}==='helper')center.show();
    else {
      const {default:store}=await import(${JSON.stringify(url("modules/state.js"))});
      const {renderProjectTree}=await import(${JSON.stringify(url("modules/project-tree.js"))});
      store.set('projects',[{id:'budget-project',name:'Budget workspace',sessions:[]}]);store.set('activeProjectId','budget-project');renderProjectTree();
    }
  })()`);
  return { win, account };
}
async function openTask(win) {
  await click(win, '[data-conversation-id="chat"]');
  await action(win, "task-entry"); await action(win, "task-open");
}
app.whenReady().then(async () => {
  fixture = createFixture(temporary);
  ipcMain.handle("dual-ui-command", async (event, channel, payload) => {
    const account = identities.get(event.sender.id); assert.ok(account);
    return account.invoke(channel, payload);
  });
  const owner = await makeWindow("owner"), helper = await makeWindow("helper");
  await click(owner.win, '.project-actions .project-action-btn:last-child');
  await action(owner.win, "workspace-collaboration");
  await waitFor(owner.win, "!!document.querySelector('[name=collaborationTarget] option[value=\"friend:helper\"]')", "friend available in workspace picker");
  await capture(owner.win, "workspace-recipient");
  // The OS-owned select popup is outside webContents' native-input surface.
  // Select its visible form control and dispatch change; no business API call.
  await owner.win.webContents.executeJavaScript("(()=>{const select=document.querySelector('[name=collaborationTarget]');select.value='friend:helper';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await action(owner.win, "workspace-collaboration-continue");
  await fill(owner.win, "title", "Review budget"); await fill(owner.win, "objective", "Revise the supplied budget"); await fill(owner.win, "acceptanceCriteria", "Provide checked totals");
  await action(owner.win, "task-prepare");
  await waitFor(owner.win, "document.querySelectorAll('.remote-task-files li').length===2", "actual ZIP preview");
  assert.equal(fixture.events.find(e => e.operation === "prepare")?.projectId, "budget-project");
  assert.equal(fixture.events.some(e => e.chooser), false, "workspace entry uses project identity, never a second folder picker");
  assert.equal(fixture.uploads.size, 0, "preview never uploads"); assert.equal(fixture.serverTasks.size, 0);
  await capture(owner.win, "workspace-preview");
  await action(owner.win, "task-send");
  await waitFor(owner.win, "document.querySelector('.remote-tasks [name=title]')?.disabled===true && !document.querySelector('[data-action=task-send]')?.disabled", "unknown receipt keeps immutable draft");
  assert.equal(fixture.serverTasks.size, 1, "lost receipt committed one task");
  await action(owner.win, "task-send");
  await waitFor(owner.win, "!!document.querySelector('.remote-task-hero')", "send retry resolves");
  assert.equal(fixture.events.filter(e => e.action === "create").length, 1, "retry does not duplicate the task");
  const task = [...fixture.serverTasks.values()][0];
  await openTask(helper.win); await action(helper.win, "accept"); await action(helper.win, "task-confirm");
  await action(helper.win, "task-receive");
  await waitFor(helper.win, "!!document.querySelector('[data-action=task-workspace-open]') && !document.querySelector('[data-action=task-workspace-open]').disabled", "receive completes");
  await action(helper.win, "task-workspace-open");
  await waitFor(helper.win, "document.querySelector('.remote-tasks').hidden", "open independent workspace");
  const work = helper.account.opened().rootPath, binding = helper.account.records.get(`task:${task.id}`);
  assert.notEqual(work, fixture.source); assert.notEqual(work, binding.snapshotRoot);
  // Synthetic external editing step, NOT an AI-run or editor-UI claim. All
  // collaboration lifecycle actions above and below are actual button clicks.
  fs.writeFileSync(path.join(work, "budget.txt"), "reviewed budget\n");
  fs.unlinkSync(path.join(work, "remove.txt")); fs.writeFileSync(path.join(work, "evidence.txt"), "totals checked\n");
  assert.equal(fs.readFileSync(path.join(binding.snapshotRoot, "budget.txt"), "utf8"), "original budget\n");
  assertOriginalSource("editing helper copy leaves all requester files unchanged");
  await action(helper.win, "task-entry"); await action(helper.win, "task-open");
  await action(helper.win, "task-prepare-delivery"); await action(helper.win, "task-submit-delivery");
  await waitFor(helper.win, "!!document.querySelector('.remote-task-status.is-review')", "delivered for review");
  assertOriginalSource("submitting delivery leaves all requester files unchanged");
  await action(owner.win, "task-back"); await action(owner.win, "task-open");
  await action(owner.win, "approve"); await action(owner.win, "task-confirm");
  await action(owner.win, "task-preview");
  await waitFor(owner.win, "!!document.querySelector('[name=confirmDeletions]')", "actual application plan");
  await capture(owner.win, "application-preview");
  assertOriginalSource("approval/preview must not modify any source file");
  assert.equal(await owner.win.webContents.executeJavaScript("document.querySelector('[data-action=task-apply]').disabled"), true);
  await click(owner.win, "[name=confirmDeletions]"); await action(owner.win, "task-apply");
  await waitFor(owner.win, "!!document.querySelector('[data-action=task-rollback]')", "applied with rollback");
  assert.equal(fs.readFileSync(path.join(fixture.source, "budget.txt"), "utf8"), "reviewed budget\n");
  assert.equal(fs.existsSync(path.join(fixture.source, "remove.txt")), false);
  assert.equal(fs.readFileSync(path.join(fixture.source, "evidence.txt"), "utf8"), "totals checked\n");
  await action(owner.win, "task-rollback");
  await waitFor(owner.win, "document.querySelector('.remote-tasks').innerText.includes('rolled back')", "rollback rendered");
  assertOriginalSource("rollback restores every original and removes the added file");
  assert.equal(fixture.serverTasks.get(task.id).state, "accepted", "local rollback does not change remote approval");
  await capture(owner.win, "rolled-back");
  assert.deepEqual(fixture.events.filter(e => e.action).map(e => e.action), ["create", "accept", "submit", "approve"]);
  console.log("dual-client UI: native clicks create/retry/accept/receive/open/deliver/approve/preview/apply/rollback; real IPC, SQLite, ZIP and source-file assertions passed. Transport, accounts and editing are explicit fixtures; not production or physical-device acceptance.");
  finish(0);
}).catch(error => { console.error(error); finish(1); });
