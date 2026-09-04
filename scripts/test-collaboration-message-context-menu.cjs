"use strict";
/**
 * Right-click a message → WeChat's action menu: copy / quote / edit / recall.
 * It must surface the same guarded handlers as the hover chips, and never offer
 * edit/recall on someone else's message.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");
if (!app?.whenReady) { console.error("Run with Electron"); process.exit(2); }
const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-msgctx-"));
app.setPath("userData", path.join(dir, "ud"));
app.disableHardwareAcceleration();
const u = (p) => require("url").pathToFileURL(path.join(ROOT, p)).href;

app.whenReady().then(async () => {
  const { BrowserWindow } = require("electron");
  const win = new BrowserWindow({ show: false, width: 700, height: 600, webPreferences: { sandbox: false, contextIsolation: false } });
  await win.loadFile(path.join(ROOT, "src/renderer/index.html"));
  const out = await win.webContents.executeJavaScript(`(async () => {
    const i18n = await import(${JSON.stringify(u("src/renderer/i18n/index.js"))}); await i18n.initI18n?.({ locale: 'zh-CN' });
    const tl = await import(${JSON.stringify(u("src/renderer/modules/collaboration-timeline.js"))});
    const node = document.getElementById('collaborationTimeline');
    const calls = []; const at = Date.now();
    tl.renderCollaborationTimeline(node, [
      { id: 'm1', seq: 1, senderUserId: 'k', bodyText: '对方消息', createdAt: at - 60000 },
      { id: 'm2', seq: 2, senderUserId: 'me', isOwn: true, bodyText: '我的消息', createdAt: at - 5000, state: 'persisted' },
      { id: 'm3', seq: 3, senderUserId: 'k', bodyText: '', revokedAt: at - 1000, createdAt: at - 1000 },
    ], { currentUserId: 'me', showSenderNames: true, resolveSender: (id) => id === 'me' ? '我' : 'K', peerReadSeq: 1,
       onReply: (m) => calls.push(['reply', m.id]), canReply: () => true,
       onRevoke: (m) => calls.push(['revoke', m.id]), canRevoke: (m) => m.isOwn === true,
       onEdit: (m) => calls.push(['edit', m.id]), canEdit: (m) => m.isOwn === true,
       onDeleteLocal: (m) => calls.push(['deleteLocal', m.id]) });
    const menuFor = async (key) => {
      node.querySelector('[data-message-key="' + key + '"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 80 }));
      await new Promise(r => setTimeout(r, 25));
      const items = [...document.querySelectorAll('.app-context-menu-item')];
      return { count: items.length, danger: items.filter(b => b.classList.contains('is-danger')).length, items };
    };
    const own = await menuFor('m2');
    const ownCount = own.count, ownDanger = own.danger;
    own.items.find(b => b.classList.contains('is-danger')).click();  // recall
    await new Promise(r => setTimeout(r, 25));
    const other = await menuFor('m1');
    const otherCount = other.count, otherDanger = other.danger;
    document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));  // close
    // A revoked message has no body, so copy/reply/edit/recall are all withheld;
    // only the local delete remains, which is how you clear the placeholder.
    node.querySelector('[data-message-key="m3"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 80 }));
    await new Promise(r => setTimeout(r, 25));
    const revokedItems = [...document.querySelectorAll('.app-context-menu-item')].map(b => b.textContent);
    const revokedMenu = revokedItems.length;
    return JSON.stringify({ ownCount, ownDanger, otherCount, otherDanger, calls, revokedMenu, revokedItems, deleteLabel: i18n.t('collaboration.deleteMessage') });
  })()`);
  const r = JSON.parse(out);
  const i18nDeleteLabel = r.deleteLabel;
  assert.equal(r.ownCount, 5, "own message: copy, reply, edit, recall, delete");
  assert.equal(r.ownDanger, 2, "recall and delete are the destructive items");
  assert.deepEqual(r.calls, [["revoke", "m2"]], "clicking recall calls the guarded revoke handler");
  assert.equal(r.otherCount, 3, "someone else's message: copy, reply and delete (delete is local, so it applies to any message)");
  assert.equal(r.otherDanger, 1, "only delete is destructive on another's message — never recall");
  assert.equal(r.revokedMenu, 1, `a revoked message offers only the local delete (${JSON.stringify(r.revokedItems)})`);
  assert.equal(r.revokedItems[0], i18nDeleteLabel, "and that one action is delete, never copy/reply/edit/recall");
  win.destroy(); fs.rmSync(dir, { recursive: true, force: true });
  console.log("collaboration message context menu: copy/quote/edit/recall, ownership-gated");
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
