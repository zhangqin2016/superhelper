"use strict";
/**
 * Clicking a conversation moves the list highlight immediately.
 *
 * openConversation switches the thread and title at once, but it does not
 * rebuild the inbox — the list is only re-rendered on a later state event. So
 * the active-row highlight used to lag: after clicking a second conversation
 * the thread switched but the highlighted row did not move until the next sync
 * (e.g. sending a message triggered a server sync -> load -> re-render). That
 * read as "clicking does not switch; only sending switches".
 *
 * setActiveConversation moves the highlight without rebuilding the list, and
 * openConversation calls it the moment a conversation becomes active.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");
if (!app?.whenReady) { console.error("Run with Electron"); process.exit(2); }
const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-active-"));
app.setPath("userData", path.join(dir, "ud"));
app.disableHardwareAcceleration();
const u = (p) => require("url").pathToFileURL(path.join(ROOT, p)).href;

// The centre must call the sync the moment a conversation becomes active —
// right where it takes ownership of activeConversationId.
{
  const center = fs.readFileSync(path.join(ROOT, "src/renderer/modules/collaboration-center.js"), "utf8");
  assert.match(center, /activeConversationId = conversationId;\n\s*setActiveConversation\(byId\("collaborationInbox"\), conversationId\);/,
    "openConversation moves the inbox highlight when it takes ownership of the active conversation");
}

app.whenReady().then(async () => {
  const { BrowserWindow } = require("electron");
  const win = new BrowserWindow({ show: false, width: 480, height: 640, webPreferences: { sandbox: false, contextIsolation: false } });
  await win.loadFile(path.join(ROOT, "src/renderer/index.html"));
  const out = await win.webContents.executeJavaScript(`(async () => {
    const inbox = await import(${JSON.stringify(u("src/renderer/modules/collaboration-inbox.js"))});
    const node = document.getElementById('collaborationInbox');
    const at = Date.now();
    inbox.renderCollaborationInbox(node, [
      { id: 'a', title: 'A', scopeId: 'personal', kind: 'direct', updatedAt: at, memberUserIds: ['me','k'], lastMessage: { senderUserId: 'k', text: 'x' } },
      { id: 'b', title: 'B', scopeId: 'personal', kind: 'direct', updatedAt: at, memberUserIds: ['me','k'], lastMessage: { senderUserId: 'k', text: 'y' } },
    ], { activeConversationId: 'a', currentUserId: 'me', resolveSender: () => 'k' });
    const activeId = () => [...node.querySelectorAll('.collaboration-inbox-item')].find((el) => el.classList.contains('is-active'))?.dataset.conversationId || null;
    const initial = activeId();
    inbox.setActiveConversation(node, 'b');
    const moved = activeId();
    const exactlyOne = node.querySelectorAll('.collaboration-inbox-item.is-active').length;
    const bCurrent = node.querySelector('[data-conversation-id="b"]')?.getAttribute('aria-current');
    const aCurrent = node.querySelector('[data-conversation-id="a"]')?.getAttribute('aria-current');
    // A conversation not in the list clears the highlight rather than throwing.
    inbox.setActiveConversation(node, 'missing');
    const afterMissing = activeId();
    return JSON.stringify({ initial, moved, bCurrent, aCurrent, afterMissing, exactlyOne });
  })()`);
  const r = JSON.parse(out);
  assert.equal(r.initial, "a", "the render highlights the active conversation");
  assert.equal(r.moved, "b", "setActiveConversation moves the highlight to the opened conversation");
  assert.equal(r.exactlyOne, 1, "exactly one row is highlighted");
  assert.equal(r.bCurrent, "page", "the opened row is aria-current");
  assert.equal(r.aCurrent, "false", "the previous row is no longer aria-current");
  assert.equal(r.afterMissing, null, "an id not in the list clears the highlight without error");
  win.destroy(); fs.rmSync(dir, { recursive: true, force: true });
  console.log("collaboration active-highlight: clicking moves the list highlight immediately");
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
