"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");
if (!app?.whenReady) { console.error("Run with Electron: electron scripts/test-collaboration-timeline.cjs"); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-timeline-dom-"));
app.setPath("userData", path.join(dir, "userData"));
app.disableHardwareAcceleration();
let win;
const deadline = setTimeout(() => { console.error("collaboration timeline DOM timed out"); finish(1); }, 30_000);
function finish(code) { clearTimeout(deadline); if (win && !win.isDestroyed()) win.destroy(); fs.rmSync(dir, { recursive: true, force: true }); app.exit(code); }
app.whenReady().then(async () => {
  const page = path.join(dir, "test.html");
  fs.writeFileSync(page, '<!doctype html><html><body><div id="timeline" role="log"></div></body></html>');
  win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadFile(page);
  const moduleUrl = pathToFileURL(path.join(__dirname, "../src/renderer/modules/collaboration-timeline.js")).href;
  const result = await win.webContents.executeJavaScript(`(async () => {
    const { renderCollaborationTimeline: render } = await import(${JSON.stringify(moduleUrl)});
    const root = document.getElementById('timeline');
    const first = { id: 'one', seq: 1, bodyText: '<img src=x onerror=alert(1)>' };
    const pending = { id: 'local', clientCommandId: 'cmd', seq: null, state: 'confirming', bodyText: 'draft' };
    render(root, [first, pending], { currentUserId: 'me', resolveSender: (id) => id === 'alice' ? 'Alice' : id });
    const initialOrder = [...root.children].map(n => n.dataset.messageKey);
    const row = root.querySelector('[data-message-key="cmd"]');
    const body = row.querySelector('.collaboration-message-body');
    render(root, [{...first,senderUserId:'me',isOwn:false,createdAt:1788250000000},{...pending,senderUserId:'delayed-profile',isOwn:true,createdAt:1788250001000}], { currentUserId:'me', resolveSender:(id)=>id==='me'?'Alice':id });
    const visualContract = {
      incomingAuthor: root.querySelector('[data-message-key="one"] .collaboration-message-author')?.textContent,
      outgoing: root.querySelector('[data-message-key="cmd"]')?.classList.contains('is-outgoing'),
      avatar: Boolean(root.querySelector('[data-message-key="one"] .collaboration-message-avatar')),
      time: Boolean(root.querySelector('[data-message-key="one"] .collaboration-message-meta > time')),
      actions: Boolean(root.querySelector('[data-message-key="one"] .collaboration-message-actions')),
      everyBubbleHasTime: Boolean(root.querySelector('[data-message-key="cmd"] .collaboration-message-meta > time')),
      metaInsideBubble: Boolean(root.querySelector('[data-message-key="cmd"] .collaboration-message-bubble > .collaboration-message-meta')),
      noFloatingRowTime: !root.querySelector('[data-message-key="cmd"] > time'),
      // The meta line owns the timestamp so it is built early, but it must END
      // the bubble: appending it before the body existed once put the delivery
      // tick to the LEFT of the message text.
      metaIsLastInBubble: root.querySelector('[data-message-key="cmd"] .collaboration-message-bubble')?.lastElementChild?.classList.contains('collaboration-message-meta') === true,
      ownIdentityHidden: !root.querySelector('[data-message-key="cmd"] .collaboration-message-author'),
    };
    const groupedRoot=document.createElement('div');document.body.append(groupedRoot);
    render(groupedRoot,[
      {id:'g1',seq:1,senderUserId:'usr_internal',isOwn:false,bodyText:'a',createdAt:1788250000000},
      {id:'g2',seq:2,senderUserId:'usr_internal',isOwn:false,bodyText:'b',createdAt:1788250001000},
      {id:'g3',seq:3,senderUserId:'usr_internal',isOwn:false,bodyText:'c',createdAt:1788250301000},
    ],{currentUserId:'usr_internal',showSenderNames:false});
    const groupingContract={
      authoritativeFalse:!groupedRoot.querySelector('[data-message-key="g1"]').classList.contains('is-outgoing'),
      grouped:groupedRoot.querySelector('[data-message-key="g2"]').classList.contains('is-grouped'),
      fiveMinuteTime:Boolean(groupedRoot.querySelector('[data-message-key="g3"] .collaboration-message-meta > time')),
      directIdentityHidden:!groupedRoot.querySelector('.collaboration-message-author')&&!groupedRoot.textContent.includes('usr_internal'),
    };
    render(root, [first, { ...pending, id: 'server', seq: 2, state: 'persisted' }]);
    const sameRow = row === root.querySelector('[data-message-key="cmd"]');
    const sameBody = body === row.querySelector('.collaboration-message-body');
    const safeText = root.querySelector('img') === null;
    render(root, [first, { ...pending, id: 'server', seq: 2, state: 'persisted', bodyText: '', revokedAt: '2026-08-31T00:00:00Z' }]);
    const tombstone = row.querySelector('.collaboration-message-body').textContent;
    root.style.cssText = 'height:120px; overflow:auto; margin-top:400px; overflow-anchor:none';
    const style = document.createElement('style'); style.textContent = '.collaboration-message { min-height:40px; margin:0 } .collaboration-message-body { margin:0; line-height:40px; white-space:pre }'; document.head.append(style);
    const history = Array.from({length:30}, (_, i) => ({id:'h'+i,seq:i+10,bodyText:'line '+i}));
    render(root, history);
    root.scrollTop = 415;
    const visible = root.querySelector('[data-message-key="h10"]');
    const before = visible.getBoundingClientRect().top;
    // An edit to an offscreen message changes its height without changing its
    // identity. The currently visible message must not jump.
    render(root, history.map((message,i) => i===5 ? {...message,bodyText:'line 5\\nextra line'} : message));
    const after = visible.getBoundingClientRect().top;
    root.scrollTop = root.scrollHeight;
    render(root, [...history,{id:'new',seq:41,bodyText:'last'}]);
    const bottomGap = root.scrollHeight-root.scrollTop-root.clientHeight;
    const { initCollaborationCenter } = await import(${JSON.stringify(pathToFileURL(path.join(__dirname, "../src/renderer/modules/collaboration-center.js")).href)});
    document.body.innerHTML = '<button id="collaborationNavButton"></button><button id="workbenchNavButton"></button><div id="centerPanel"><div id="collaborationCenter"><div id="collaborationInboxColumn"><div id="collaborationInbox"></div></div><div id="collaborationStatus"></div><div id="collaborationLive"></div><div id="collaborationScopeBadge"></div><button id="collaborationLoadOlder"></button><div id="collaborationTimeline"></div><p id="collaborationConversationEmpty"></p><textarea id="collaborationComposer"></textarea><button id="collaborationSendButton"></button></div></div>';
    const calls = [];
    const cacheCalls = [];
    window.assistantClient = { collaboration: {
      getDraft: async () => ({ok:true,text:''}), onStateChange: () => () => {},
      readMessages: async (request) => { cacheCalls.push(request); return {ok:true,messages:request.messageIds.map(id=>({id,seq:Number(id.slice(4)),revision:2,bodyText:'',revokedAt:'now'})),unavailableMessageIds:[]}; },
      open: async (id,beforeSeq) => { calls.push(beforeSeq ?? null); return {ok:true,conversation:{id},hasMore:beforeSeq==null,nextBeforeSeq:beforeSeq==null?3:1,
        messages:(beforeSeq==null?[3,4]:[1,2]).map(seq=>({id:'page'+seq,seq,bodyText:'page '+seq}))}; },
    } };
    const center = initCollaborationCenter({getPolicy:async()=>({collaboration:{enabled:true}})});
    await center.open('c'); await center.loadOlder(); await center.open('c');
    const pagedOrder = [...document.getElementById('collaborationTimeline').children].map(n=>n.dataset.messageKey);
    const olderHidden = document.getElementById('collaborationLoadOlder').hidden;
    const updatedOldBody = document.querySelector('[data-message-key="page1"] .collaboration-message-body').textContent;
    document.getElementById('collaborationComposer').value = 'revoked private draft';
    window.assistantClient.collaboration.open = async () => ({ok:false,code:'COLLAB_ACCESS_REVOKED'});
    await center.open('c');
    const revokedView = { rows:document.getElementById('collaborationTimeline').children.length, draft:document.getElementById('collaborationComposer').value,
      disabled:document.getElementById('collaborationSendButton').disabled, scope:document.getElementById('collaborationScopeBadge').textContent };
    center.destroy();
    return { initialOrder, visualContract, groupingContract, sameRow, sameBody, safeText, tombstone, anchorDelta:after-before, bottomGap, pagedOrder, olderHidden, calls, cacheCalls, updatedOldBody, revokedView };
  })()`);
  assert.deepEqual(result.initialOrder, ["one", "cmd"], "pending messages follow authoritative server sequence, not invented zero");
  assert.deepEqual(result.visualContract, { incomingAuthor: "Alice", outgoing: true, avatar: true, time: true, actions: true, everyBubbleHasTime: true, metaInsideBubble: true, noFloatingRowTime: true, metaIsLastInBubble: true, ownIdentityHidden: true }, "timeline uses reliable own-message alignment and one in-bubble meta line (time + tick) per Telegram, not a floating row timestamp");
  assert.deepEqual(result.groupingContract, { authoritativeFalse:true, grouped:true, fiveMinuteTime:true, directIdentityHidden:true }, "authoritative direction, grouping, five-minute timestamps and direct-chat identity stay deterministic");
  assert.equal(result.sameRow, true, "ACK keeps the optimistic DOM identity");
  assert.equal(result.sameBody, true, "unchanged content is not removed/re-announced on ACK");
  assert.equal(result.safeText, true, "untrusted message markup remains text");
  assert.equal(result.tombstone, "collaboration.messageRevoked", "revoked message has an explicit tombstone");
  assert.equal(result.anchorDelta, 0, "offscreen edits preserve the visible anchor even when the scroller has a page offset");
  assert.ok(result.bottomGap <= 1, "new messages follow only when already at the bottom, allowing subpixel layout rounding");
  assert.deepEqual(result.pagedOrder, ["page1", "page2", "page3", "page4"], "older history remains after a newest-window refresh");
  assert.equal(result.olderHidden, true, "exhausted history hides the load-more action");
  assert.deepEqual(result.calls, [null, 3, null], "actual UI passes the exclusive cursor to preload");
  assert.deepEqual(result.cacheCalls, [{conversationId:"c",messageIds:["page1","page2"]}]);
  assert.equal(result.updatedOldBody, "collaboration.messageRevoked", "old loaded history reflects a revocation outside the latest page");
  assert.deepEqual(result.revokedView, { rows: 0, draft: "", disabled: true, scope: "" }, "revocation clears actual DOM content and disables send");
  console.log("collaboration timeline: actual Electron DOM passed");
}).then(() => finish(0)).catch((error) => { console.error(error); finish(1); });
