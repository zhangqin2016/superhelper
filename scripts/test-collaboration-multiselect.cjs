"use strict";
/**
 * 多选: right-click → Select more puts the thread in batch mode. Rows become
 * checkbox targets, the bar counts them, and forward/delete act on the set —
 * delete removes them from YOUR view only (it is not a recall).
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");
if (!app?.whenReady) { console.error("Run with Electron"); process.exit(2); }
const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-multi-"));
app.setPath("userData", path.join(dir, "ud"));
app.disableHardwareAcceleration();
const u = (p) => require("url").pathToFileURL(path.join(ROOT, p)).href;

app.whenReady().then(async () => {
  const { BrowserWindow } = require("electron");
  const win = new BrowserWindow({ show: false, width: 800, height: 700, webPreferences: { sandbox: false, contextIsolation: false } });
  await win.loadFile(path.join(ROOT, "src/renderer/index.html"));
  const out = await win.webContents.executeJavaScript(`(async () => {
    const i18n = await import(${JSON.stringify(u("src/renderer/i18n/index.js"))}); await i18n.initI18n?.({ locale: 'zh-CN' });
    const tl = await import(${JSON.stringify(u("src/renderer/modules/collaboration-timeline.js"))});
    const ms = await import(${JSON.stringify(u("src/renderer/modules/collaboration-multiselect.js"))});
    const { createConversationPrefs } = await import(${JSON.stringify(u("src/renderer/modules/collaboration-conversation-prefs.js"))});
    const store = (() => { const m = new Map(); return { getItem: (k) => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)) }; })();
    const prefs = createConversationPrefs('me', store);
    const node = document.getElementById('collaborationTimeline');
    const messages = [
      { id: 'm1', seq: 1, senderUserId: 'k', bodyText: '一', createdAt: 1 },
      { id: 'm2', seq: 2, senderUserId: 'k', bodyText: '二', createdAt: 2 },
      { id: 'm3', seq: 3, senderUserId: 'k', bodyText: '三', createdAt: 3 },
    ];
    let forwarded = null, deleted = null, selection;
    const paint = () => tl.renderCollaborationTimeline(node, prefs.applyMessages(messages), { currentUserId: 'me', resolveSender: (id) => id, selection, onForward: () => {} });
    selection = ms.createMessageMultiSelect({ container: document.getElementById('collaborationConversation'),
      onChange: () => paint(), onForward: (ids) => { forwarded = ids; }, onDelete: (ids) => { deleted = ids; prefs.hideMessages(ids); selection.exit(); } });
    paint();
    const bar = document.querySelector('.collaboration-select-bar');
    const barHiddenBefore = bar.hidden;
    // Right-click m2 -> the menu offers 多选.
    node.querySelector('[data-message-key="m2"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }));
    await new Promise(r => setTimeout(r, 25));
    const multiItem = [...document.querySelectorAll('.app-context-menu-item')].find(b => b.textContent === i18n.t('collaboration.multiSelect'));
    const hasMultiItem = Boolean(multiItem);
    multiItem.click(); await new Promise(r => setTimeout(r, 30));
    const afterEnter = { barShown: !bar.hidden, selected: node.querySelectorAll('.collaboration-message.is-selected').length,
      selectable: node.querySelectorAll('.collaboration-message.is-selectable').length, count: document.querySelector('.collaboration-select-count').textContent };
    // Clicking another row adds it; clicking it again removes it.
    node.querySelector('[data-message-key="m3"]').click(); await new Promise(r => setTimeout(r, 25));
    const two = node.querySelectorAll('.collaboration-message.is-selected').length;
    node.querySelector('[data-message-key="m3"]').click(); await new Promise(r => setTimeout(r, 25));
    const backToOne = node.querySelectorAll('.collaboration-message.is-selected').length;
    // Forward the set.
    node.querySelector('[data-message-key="m1"]').click(); await new Promise(r => setTimeout(r, 25));
    document.querySelector('[data-action="forward-selected"]').click(); await new Promise(r => setTimeout(r, 25));
    // Delete the set: they leave this view and stay gone across a re-render.
    document.querySelector('[data-action="delete-selected"]').click(); await new Promise(r => setTimeout(r, 30));
    const remaining = [...node.querySelectorAll('.collaboration-message')].map(el => el.dataset.messageKey);
    const barAfterDelete = document.querySelector('.collaboration-select-bar').hidden;
    return JSON.stringify({ barHiddenBefore, hasMultiItem, afterEnter, two, backToOne, forwarded, deleted, remaining, barAfterDelete });
  })()`);
  const r = JSON.parse(out);
  assert.equal(r.barHiddenBefore, true, "the batch bar starts hidden");
  assert.equal(r.hasMultiItem, true, "the message menu offers 多选");
  assert.equal(r.afterEnter.barShown, true, "entering selection shows the bar");
  assert.equal(r.afterEnter.selected, 1, "the right-clicked message starts selected");
  assert.equal(r.afterEnter.selectable, 3, "every message becomes a checkbox target");
  assert.match(r.afterEnter.count, /1/, `the bar counts the selection (${r.afterEnter.count})`);
  assert.equal(r.two, 2, "clicking another row adds it");
  assert.equal(r.backToOne, 1, "clicking it again removes it");
  assert.deepEqual([...r.forwarded].sort(), ["m1", "m2"], "forward acts on the whole set");
  assert.deepEqual([...r.deleted].sort(), ["m1", "m2"], "delete acts on the whole set");
  assert.deepEqual(r.remaining, ["m3"], "deleted messages leave this view only");
  assert.equal(r.barAfterDelete, true, "the batch ends after acting");
  win.destroy(); fs.rmSync(dir, { recursive: true, force: true });
  console.log("collaboration multiselect: enter from the menu, toggle rows, batch forward and local delete");
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
