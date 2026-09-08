const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-visible-read-'));
app.setPath('userData', path.join(temp, 'profile'));
app.disableHardwareAcceleration();
let win;
const timeout = setTimeout(() => app.exit(1), 30000);
app.whenReady().then(async () => {
  const source = fs.readFileSync(path.resolve('src/renderer/index.html'), 'utf8');
  const body = source.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const fixture = path.join(temp, 'fixture.html');
  fs.writeFileSync(fixture, `<!doctype html><html><head><link rel="stylesheet" href="${pathToFileURL(path.resolve('src/renderer/styles.css')).href}"></head><body>${body}</body></html>`);
  win = new BrowserWindow({ show: true, width: 1050, height: 800, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(fixture, { query: { view: 'collaboration' } });
  win.focus();
  const results = await win.webContents.executeJavaScript(`(async () => {
    const { initCollaborationCenter } = await import(${JSON.stringify(pathToFileURL(path.resolve('src/renderer/modules/collaboration-center.js')).href)});
    // Exercise the focus gate deterministically; OS focus may move to the host
    // while this isolated window runs. Layout/scroll/DOM remain actual Chromium.
    document.hasFocus = () => true;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let callback, seq = 1, reads = [], fail = false, many = false;
    const conversation = { id: 'c', kind: 'direct', title: 'Peer', scopeId: 'personal', memberUserIds: ['self', 'peer'], activityKnown: true, projectionSeq: 1, lastReadSeq: 0, unreadCount: 1, mentionCount: 0 };
    window.assistantClient = { collaboration: {
      onStateChange: fn => { callback = fn; return () => {}; },
      list: async () => ({ ok: true, conversations: [{ ...conversation }] }),
      getDirectory: async () => ({ ok: true, profile: { userId: 'self' }, contacts: [], teams: [] }),
      getSocialCommands: async () => ({ ok: true, commands: [] }),
      getDraft: async () => ({ ok: true, text: '' }), saveDraft: async () => ({ ok: true }),
      open: async () => ({ ok: true, conversation: { ...conversation }, messages: many
        ? Array.from({ length: 80 }, (_, i) => ({ id: 'm' + (i + 10), conversationId: 'c', seq: i + 10, senderUserId: 'peer', bodyText: 'message ' + i, revision: 1 }))
        : [{ id: 'm' + seq, conversationId: 'c', seq, senderUserId: 'peer', bodyText: 'hi', revision: 1 }] }),
      getTransfers: async () => ({ ok: true, transfers: [] }),
      markRead: async (id, observed) => {
        reads.push([id, observed]);
        if (fail) return { ok: false, code: 'COLLAB_READ_PENDING' };
        conversation.lastReadSeq = observed; conversation.unreadCount = 0;
        callback({ type: 'read', state: { ok: true } });
        return { ok: true, conversationId: id, seq: observed };
      },
    } };
    const center = initCollaborationCenter({ getPolicy: async () => ({ collaboration: { enabled: true } }) });
    center.show(); await sleep(100);
    const listOnly = reads.length === 0 && !document.getElementById('collaborationRailUnread').hidden;
    await center.open('c'); await sleep(1300);
    const visibleRead = reads.some(([id, n]) => id === 'c' && n === 1);
    const badgeCleared = document.getElementById('collaborationRailUnread').hidden && !document.querySelector('#collaborationInbox .collaboration-row-unread');
    const count = reads.length; await sleep(1100);
    const dedup = reads.length === count;
    document.getElementById('collaborationPeopleTab').click(); seq = 2; conversation.unreadCount = 1;
    callback({ type: 'sync', state: { ok: true } }); await sleep(1300);
    const hiddenNotRead = reads.length === count;
    await center.open('c'); await sleep(1300);
    const reopenRead = reads.some(([, n]) => n === 2);
    // A real layout is still not read evidence while the document is unfocused.
    const nativeFocus = document.hasFocus.bind(document);
    document.hasFocus = () => false;
    seq = 3; await center.open('c'); await sleep(1100);
    const unfocusedNotRead = !reads.some(([, n]) => n === 3);
    document.hasFocus = nativeFocus; window.dispatchEvent(new Event('focus')); await sleep(200);
    const focusRead = reads.some(([, n]) => n === 3);
    const search = document.getElementById('collaborationConversationSearch');
    search.value = 'hi'; search.dispatchEvent(new Event('input'));
    seq = 4; await center.open('c', { userNavigation: false }); await sleep(1100);
    const searchNotRead = !reads.some(([, n]) => n === 4);
    search.value = ''; search.dispatchEvent(new Event('input')); await sleep(200);
    const searchExitRead = reads.some(([, n]) => n === 4);
    fail = true; seq = 5; await center.open('c'); await sleep(1200);
    const failedAttempt = reads.filter(([, n]) => n === 5).length;
    fail = false; await sleep(5200);
    const retried = failedAttempt === 1 && reads.filter(([, n]) => n === 5).length === 2;
    document.hasFocus = () => false; many = true; await center.open('c');
    const timeline = document.getElementById('collaborationTimeline'); timeline.scrollTop = 0;
    document.hasFocus = nativeFocus; timeline.dispatchEvent(new Event('scroll')); await sleep(200);
    const topRead = reads.at(-1)[1];
    timeline.scrollTop = timeline.scrollHeight; timeline.dispatchEvent(new Event('scroll')); await sleep(200);
    const viewportOnly = topRead >= 10 && topRead < 89 && reads.at(-1)[1] === 89;
    center.destroy(); const beforeDestroy = reads.length; await sleep(1100);
    return { listOnly, visibleRead, badgeCleared, dedup, hiddenNotRead, reopenRead, unfocusedNotRead, focusRead, searchNotRead, searchExitRead, retried, viewportOnly, disposed: reads.length === beforeDestroy };
  })()`);
  assert.deepEqual(results, { listOnly: true, visibleRead: true, badgeCleared: true, dedup: true, hiddenNotRead: true, reopenRead: true, unfocusedNotRead: true, focusRead: true, searchNotRead: true, searchExitRead: true, retried: true, viewportOnly: true, disposed: true });
  console.log('visible read: actual center read submission, unread badge, hidden-section fence and teardown passed');
}).then(() => { clearTimeout(timeout); win?.destroy(); fs.rmSync(temp, { recursive: true, force: true }); app.exit(0); })
  .catch(error => { console.error(error); clearTimeout(timeout); win?.destroy(); app.exit(1); });
