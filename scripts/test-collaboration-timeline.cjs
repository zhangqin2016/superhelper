"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");
const { exitAndRemove } = require("./electron-test-cleanup.cjs");
if (!app?.whenReady) { console.error("Run with Electron: electron scripts/test-collaboration-timeline.cjs"); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-timeline-dom-"));
app.setPath("userData", path.join(dir, "userData"));
app.disableHardwareAcceleration();
let win;
const deadline = setTimeout(() => { console.error("collaboration timeline DOM timed out"); finish(1); }, 30_000);
function finish(code) { exitAndRemove({ app, window: win, directory: dir, timer: deadline, code }); }
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
    // Unread divider + search highlight. The divider is anchored to a seq
    // captured when the conversation opened, so it marks where reading stopped
    // instead of sliding away as the checkpoint advances. Highlighting is built
    // from text nodes and <mark>, never innerHTML, so a needle typed into the
    // search box can never inject markup into a message body.
    const navRoot=document.createElement('div');document.body.append(navRoot);
    render(navRoot,[
      {id:'n1',seq:1,senderUserId:'other',bodyText:'alpha layout note',createdAt:1788250000000},
      {id:'n2',seq:2,senderUserId:'other',bodyText:'beta',createdAt:1788250600000},
      {id:'n3',seq:3,senderUserId:'other',bodyText:'gamma',createdAt:1788251200000},
    ],{currentUserId:'me',showSenderNames:false,unreadFromSeq:1,highlight:'<img src=x onerror=alert(1)>layout'});
    const dividers=[...navRoot.querySelectorAll('.collaboration-unread-divider')];
    const afterDivider=dividers[0]?.nextElementSibling?.dataset?.messageKey;
    render(navRoot,[
      {id:'n1',seq:1,senderUserId:'other',bodyText:'alpha layout note',createdAt:1788250000000},
      {id:'n2',seq:2,senderUserId:'other',bodyText:'beta',createdAt:1788250600000},
      {id:'n3',seq:3,senderUserId:'other',bodyText:'gamma',createdAt:1788251200000},
    ],{currentUserId:'me',showSenderNames:false,unreadFromSeq:0,highlight:'layout'});
    const threadNavContract={
      oneDivider:dividers.length===1,
      dividerBeforeFirstUnread:afterDivider==='n2',
      dividerGoneWithoutAnchor:navRoot.querySelectorAll('.collaboration-unread-divider').length===0,
      highlightMarksNeedle:navRoot.querySelector('[data-message-key="n1"] mark.collaboration-search-hit')?.textContent==='layout',
      highlightInjectsNoMarkup:navRoot.querySelector('[data-message-key="n1"] img')===null,
      bodyTextIntact:navRoot.querySelector('[data-message-key="n1"] .collaboration-message-body')?.textContent==='alpha layout note',
      noHighlightNoMark:navRoot.querySelector('[data-message-key="n2"] mark')===null,
    };
    // Reactions make the chip row full-width, so this is the case where the
    // meta line must move INTO that row rather than onto a third line.
    const reactionClicks=[];
    const reactRoot=document.createElement('div');document.body.append(reactRoot);
    render(reactRoot,[
      {id:'react',seq:1,senderUserId:'alice',isOwn:false,bodyText:'shipped',createdAt:1788250000000,
       reactions:[{emoji:'\u{1F44D}',count:2,mine:true},{emoji:'\u{1F389}',count:1,mine:false}]},
    ],{currentUserId:'me',resolveSender:(id)=>id,onReact:(m,e,a)=>reactionClicks.push([m.id,e,a]),canReact:()=>true});
    reactRoot.querySelector('[data-action="add-reaction"][data-emoji="😂"]').click();
    reactRoot.querySelector('[data-action="toggle-reaction"]').click();
    const reactionContract = {
      // The chip row is full-width, so a meta line left OUTSIDE it lands on a
      // third line with a void beside the chips. It moves in and ends the row:
      // chips from the start, time and tick pushed to the end by an auto margin.
      metaEndsChipRow: reactRoot.querySelector('[data-message-key="react"] .collaboration-message-reactions')
        ?.lastElementChild?.classList.contains('collaboration-message-meta') === true,
      chipsComeFirst: reactRoot.querySelector('[data-message-key="react"] .collaboration-message-reactions')
        ?.firstElementChild?.classList.contains('collaboration-reaction-chip') === true,
      // Exactly one timestamp per message — never one in the row and one in the bubble.
      singleMeta: reactRoot.querySelectorAll('[data-message-key="react"] .collaboration-message-meta').length,
    };
    const { mergeCollaborationHistory } = await import(${JSON.stringify(pathToFileURL(path.join(__dirname, "../src/renderer/modules/collaboration-history-view.js")).href)});
    const refreshed = mergeCollaborationHistory([{id:'react',seq:1,bodyText:'hi',reactions:[{emoji:'👍',count:1,mine:true}]}], [{id:'react',seq:1,bodyText:'hi',reactions:[]}]);
    render(reactRoot,refreshed,{onReact:()=>{},canReact:()=>true});
    const clearedReaction = !reactRoot.querySelector('.collaboration-reaction-chip');
    // Attachments: a card carries the name/size/type that decide whether
    // someone wants the file, and degrades to a plain download action when the
    // server sent no metadata (older server, or a revoked message).
    const attachRoot=document.createElement('div');document.body.append(attachRoot);
    let previewAsked=[];
    render(attachRoot,[
      {id:'att',seq:1,senderUserId:'alice',isOwn:false,kind:'attachment',bodyText:'here',createdAt:1788250000000,
       conversationId:'c1',attachmentIds:['o1','o2','o3'],
       attachments:[{objectId:'o1',originalName:'plan.png',mimeType:'image/png',sizeBytes:2097152},
                    {objectId:'o2',originalName:'notes.pdf',mimeType:'application/pdf',sizeBytes:4096}]},
    ],{currentUserId:'me',resolveSender:(id)=>id,onDownload:()=>{},canDownload:()=>true,
       resolveAttachmentPreview:(objectId)=>{previewAsked.push(objectId);
         return Promise.resolve(objectId==='o1'?{url:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7',mimeType:'image/gif'}:null);},
       onPreview:()=>{}});
    await new Promise((resolve)=>setTimeout(resolve,250));
    const attachmentContract={
      // One card per id, in id order, whether or not metadata exists.
      cards:[...attachRoot.querySelectorAll('.collaboration-attachment')].map((c)=>c.dataset.objectId).join(','),
      // The two things that decide whether to download are on the surface.
      firstTitle:attachRoot.querySelector('[data-object-id="o1"] strong')?.textContent,
      firstDetail:attachRoot.querySelector('[data-object-id="o1"] small')?.textContent,
      secondDetail:attachRoot.querySelector('[data-object-id="o2"] small')?.textContent,
      // An id the server described nothing about still renders an actionable
      // card — the pre-metadata behaviour, not an empty box.
      bareTitle:attachRoot.querySelector('[data-object-id="o3"] strong')?.textContent,
      bareAction:attachRoot.querySelector('[data-object-id="o3"]')?.dataset.action,
      // Thumbnails are asked for images only; a pdf must not cause a preview call.
      previewAsked:previewAsked.join(','),
      // The resolved thumbnail replaces the drawn glyph, and only for that card.
      imageHasImg:Boolean(attachRoot.querySelector('[data-object-id="o1"] .collaboration-attachment-thumb img')),
      fileHasSvg:Boolean(attachRoot.querySelector('[data-object-id="o2"] .collaboration-attachment-thumb svg')),
      // Icons are drawn, not emoji: emoji coverage differs per platform.
      noEmojiGlyph:!/[\u{1F300}-\u{1FAFF}]/u.test(attachRoot.textContent||''),
      // A resolved thumbnail means the bytes are local, so the card opens the
      // viewer instead of starting a download that would only re-fetch.
      previewedFlag:attachRoot.querySelector('[data-object-id="o1"]')?.dataset.previewed,
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
    return { reactionClicks, clearedReaction, threadNavContract, reactionContract, attachmentContract, initialOrder, visualContract, groupingContract, sameRow, sameBody, safeText, tombstone, anchorDelta:after-before, bottomGap, pagedOrder, olderHidden, calls, cacheCalls, updatedOldBody, revokedView };
  })()`);
  assert.deepEqual(result.initialOrder, ["one", "cmd"], "pending messages follow authoritative server sequence, not invented zero");
  assert.deepEqual(result.attachmentContract, { cards: "o1,o2,o3", firstTitle: "plan.png", firstDetail: "2.0 MB \u00b7 collaboration.transfer.image",
    secondDetail: "4.0 KB \u00b7 PDF", bareTitle: "collaboration.transfer.attachment", bareAction: "download-attachment",
    previewAsked: "o1", imageHasImg: true, fileHasSvg: true, noEmojiGlyph: true, previewedFlag: "1" },
    "an attachment renders as a card with name/size/type, thumbnails images, and still works with no metadata"
    + " (raw i18n keys: this harness imports the module without a locale, so a key here proves the label is translated, not hardcoded)");
  assert.deepEqual(result.reactionClicks, [['react','😂',true],['react','👍',false]], 'picker adds a reaction and own chip removes it');
  assert.equal(result.clearedReaction,true,'empty refreshed reactions clear the last chip');
  assert.deepEqual(result.reactionContract, { metaEndsChipRow: true, chipsComeFirst: true, singleMeta: 1 },
    "a reacted bubble puts chips and the time on ONE footer row, not the time on a third line");
  assert.deepEqual(result.visualContract, { incomingAuthor: "Alice", outgoing: true, avatar: true, time: true, actions: true, everyBubbleHasTime: true, metaInsideBubble: true, noFloatingRowTime: true, metaIsLastInBubble: true, ownIdentityHidden: true }, "timeline uses reliable own-message alignment and one in-bubble meta line (time + tick) per Telegram, not a floating row timestamp");
  assert.deepEqual(result.threadNavContract, {
    oneDivider: true, dividerBeforeFirstUnread: true, dividerGoneWithoutAnchor: true,
    highlightMarksNeedle: true, highlightInjectsNoMarkup: true, bodyTextIntact: true, noHighlightNoMark: true,
  }, "the unread divider anchors to the captured seq and search highlighting can never inject markup");
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
