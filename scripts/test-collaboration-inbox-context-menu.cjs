"use strict";
/**
 * Right-click a conversation → 置顶 / 免打扰 / 删除, WeChat's list interaction.
 * Renders the real inbox with a prefs object, fires a contextmenu event, and
 * drives the menu, asserting the list reorders/annotates/hides accordingly.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");
if (!app?.whenReady) { console.error("Run with Electron"); process.exit(2); }
const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-ctx-"));
app.setPath("userData", path.join(dir, "ud"));
app.disableHardwareAcceleration();
const u = (p) => require("url").pathToFileURL(path.join(ROOT, p)).href;

app.whenReady().then(async () => {
  const { BrowserWindow } = require("electron");
  const win = new BrowserWindow({ show: false, width: 600, height: 700, webPreferences: { sandbox: false, contextIsolation: false } });
  await win.loadFile(path.join(ROOT, "src/renderer/index.html"));
  const out = await win.webContents.executeJavaScript(`(async () => {
    const i18n = await import(${JSON.stringify(u("src/renderer/i18n/index.js"))}); await i18n.initI18n?.({ locale: 'zh-CN' });
    const inbox = await import(${JSON.stringify(u("src/renderer/modules/collaboration-inbox.js"))});
    const { createConversationPrefs } = await import(${JSON.stringify(u("src/renderer/modules/collaboration-conversation-prefs.js"))});
    const store = (() => { const m = new Map(); return { getItem: (k) => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)) }; })();
    const prefs = createConversationPrefs('me', store);
    const node = document.getElementById('collaborationInbox');
    const convs = [
      { id: 'a', title: 'A', scopeId: 'personal', kind: 'direct', updatedAt: 100, unreadCount: 3, memberUserIds: ['me','k'], lastMessage: { senderUserId: 'k', text: 'x' } },
      { id: 'b', title: 'B', scopeId: 'personal', kind: 'direct', updatedAt: 300, memberUserIds: ['me','k'], lastMessage: { senderUserId: 'k', text: 'y' } },
    ];
    inbox.renderCollaborationInbox(node, convs, { onOpen: () => {}, currentUserId: 'me', resolveSender: () => 'k', prefs, onPrefsChange: () => {} });
    const order = () => [...node.querySelectorAll('.collaboration-inbox-item')].map((el) => el.dataset.conversationId);
    const before = order();
    // Right-click row 'a' (the older one) and pick 置顶 (first item).
    const rowA = node.querySelector('[data-conversation-id="a"]');
    rowA.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));
    await new Promise(r => setTimeout(r, 30));
    const menuItems = () => [...document.querySelectorAll('.app-context-menu-item')];
    const pinLabel = menuItems()[0]?.textContent;
    menuItems()[0].click();  // 置顶
    await new Promise(r => setTimeout(r, 30));
    const afterPin = order();
    const pinnedClass = node.querySelector('[data-conversation-id="a"]').classList.contains('is-pinned');
    // Right-click 'a' again, mute (2nd item).
    node.querySelector('[data-conversation-id="a"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));
    await new Promise(r => setTimeout(r, 30));
    menuItems()[1].click();  // 免打扰
    await new Promise(r => setTimeout(r, 30));
    const mutedClass = node.querySelector('[data-conversation-id="a"]').classList.contains('is-muted');
    const dot = Boolean(node.querySelector('[data-conversation-id="a"] .collaboration-row-unread.is-dot'));
    // Right-click 'a', delete (last item).
    node.querySelector('[data-conversation-id="a"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));
    await new Promise(r => setTimeout(r, 30));
    const items = menuItems(); items[items.length - 1].click();  // 删除
    await new Promise(r => setTimeout(r, 30));
    const afterDelete = order();
    return JSON.stringify({ before, pinLabel, afterPin, pinnedClass, mutedClass, dot, afterDelete });
  })()`);
  const r = JSON.parse(out);
  assert.deepEqual(r.before, ["b", "a"], "before: newest (b) first");
  assert.ok(r.pinLabel && r.pinLabel.length, "the first menu item has a label"); // locale varies under the probe; behaviour is asserted below
  assert.deepEqual(r.afterPin, ["a", "b"], "pinning floats the row to the top");
  assert.equal(r.pinnedClass, true, "the pinned row is marked");
  assert.equal(r.mutedClass, true, "muting marks the row");
  assert.equal(r.dot, true, "a muted row shows a dot, not a count");
  assert.deepEqual(r.afterDelete, ["b"], "deleting hides the conversation");
  win.destroy(); fs.rmSync(dir, { recursive: true, force: true });
  console.log("collaboration inbox context menu: pin floats, mute dots, delete hides");
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
