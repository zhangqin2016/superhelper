"use strict";
/**
 * 转发: right-click a message → Forward → pick a chat → the text is sent there.
 * The source conversation must never be offered, and picking must send exactly
 * once with the message's text.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");
if (!app?.whenReady) { console.error("Run with Electron"); process.exit(2); }
const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-fwd-"));
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
    const fwd = await import(${JSON.stringify(u("src/renderer/modules/collaboration-forward.js"))});
    const sent = [];
    const conversations = [
      { id: 'here', title: '当前会话', kind: 'direct', memberUserIds: ['me', 'k'] },
      { id: 'other', title: '乔鹏', kind: 'direct', memberUserIds: ['me', 'q'] },
      { id: 'grp', title: '牛逼讨论组', kind: 'group', memberUserIds: ['me', 'k', 'q'] },
    ];
    const forward = fwd.createForwardAction({
      getConversations: () => conversations, getActiveConversationId: () => 'here',
      getCurrentUserId: () => 'me', resolveSender: (id) => id,
      send: ({ conversationId, bodyText }) => { sent.push([conversationId, bodyText]); return Promise.resolve({ ok: true }); },
    });
    const node = document.getElementById('collaborationTimeline');
    tl.renderCollaborationTimeline(node, [
      { id: 'm1', seq: 1, senderUserId: 'k', bodyText: '要转发的正文', createdAt: Date.now() - 1000 },
    ], { currentUserId: 'me', resolveSender: (id) => id, onForward: forward });
    // Right-click -> the menu carries a Forward item.
    node.querySelector('[data-message-key="m1"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 60 }));
    await new Promise(r => setTimeout(r, 25));
    const labels = [...document.querySelectorAll('.app-context-menu-item')].map(b => b.textContent);
    const forwardBtn = [...document.querySelectorAll('.app-context-menu-item')].find(b => b.textContent === i18n.t('collaboration.forward'));
    forwardBtn.click();
    await new Promise(r => setTimeout(r, 40));
    const rows = [...document.querySelectorAll('.collab-forward-row')].map(r => r.dataset.conversationId);
    // Search narrows the list.
    const search = document.querySelector('.collab-forward-search');
    search.value = '乔'; search.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 25));
    const filtered = [...document.querySelectorAll('.collab-forward-row')].map(r => r.dataset.conversationId);
    document.querySelector('.collab-forward-row').click();
    await new Promise(r => setTimeout(r, 25));
    const pickerGone = document.querySelectorAll('.collab-forward-scrim').length === 0;
    return JSON.stringify({ labels, rows, filtered, sent, pickerGone });
  })()`);
  const r = JSON.parse(out);
  assert.ok(r.labels.length >= 2, "the message menu offers actions including forward");
  assert.deepEqual(r.rows, ["other", "grp"], "the picker offers every chat except the source");
  assert.deepEqual(r.filtered, ["other"], "the search box narrows the targets");
  assert.deepEqual(r.sent, [["other", "要转发的正文"]], "picking sends the message's text to that chat, once");
  assert.equal(r.pickerGone, true, "picking closes the picker");
  win.destroy(); fs.rmSync(dir, { recursive: true, force: true });
  console.log("collaboration forward: picker excludes the source, search narrows, picking sends once");
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
