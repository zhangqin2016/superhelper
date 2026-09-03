"use strict";
/**
 * A conversation must never scroll sideways.
 *
 * It did. A thread containing the single word "你好" showed a horizontal
 * scrollbar, because `.collaboration-message-actions` — the hover-revealed
 * Reply/react overlay — is absolutely positioned and was anchored to the
 * OUTER edge of its row:
 *
 *   .collaboration-message.is-outgoing .collaboration-message-actions {
 *     inset-inline-start: 0;   // an own row sits at the RIGHT
 *   }
 *
 * A row is only as wide as its bubble, and the overlay is wider than a short
 * bubble, so anchoring it to the row's outer edge pushed it past the thread:
 * measured 185px wide with its right edge 52px beyond the container. An
 * absolutely positioned box still contributes scrollable overflow, so the
 * scrollbar appeared. Removing the overlay took scrollWidth from 511 to 459 —
 * exactly clientWidth — which is what identified it as the sole cause.
 *
 * The rule is now "anchor to the side that has room": incoming rows sit at the
 * left and grow right, outgoing rows sit at the right and grow left, so both
 * open into the empty middle. This checks BOTH directions, because anchoring
 * either way is wrong for one of them.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");

if (!app?.whenReady) { console.error("Run with Electron: electron scripts/test-collaboration-thread-overflow.cjs"); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-overflow-"));
app.setPath("userData", path.join(dir, "userData"));
app.disableHardwareAcceleration();
let win;
const deadline = setTimeout(() => { console.error("collaboration thread overflow timed out"); finish(1); }, 30_000);
function finish(code) { clearTimeout(deadline); if (win && !win.isDestroyed()) win.destroy(); fs.rmSync(dir, { recursive: true, force: true }); app.exit(code); }

app.whenReady().then(async () => {
  const base = pathToFileURL(path.join(__dirname, "../src/renderer/styles/base.css")).href;
  const css = pathToFileURL(path.join(__dirname, "../src/renderer/styles/collaboration.css")).href;
  const page = path.join(dir, "test.html");
  // A 460px column, the panel's docked width, with the real stylesheets: this
  // defect only exists in CSS geometry, so a bare DOM cannot see it.
  fs.writeFileSync(page, '<!doctype html><html><head><link rel="stylesheet" href="' + base + '">'
    + '<link rel="stylesheet" href="' + css + '"></head><body style="margin:0">'
    + '<aside class="collaboration-center" style="width:460px"><div class="collaboration-conversation">'
    + '<div id="timeline" class="collaboration-timeline" role="log" style="height:520px"></div>'
    + '</div></aside></body></html>');
  win = new BrowserWindow({ show: false, width: 520, height: 640, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadFile(page);
  const moduleUrl = pathToFileURL(path.join(__dirname, "../src/renderer/modules/collaboration-timeline.js")).href;

  const result = await win.webContents.executeJavaScript(`(async () => {
    const { renderCollaborationTimeline: render } = await import(${JSON.stringify(moduleUrl)});
    const node = document.getElementById('timeline');
    const at = Date.now();
    // One short word each way is the reproducing case: the overlay is wider
    // than the bubble, which is when anchoring to the outer edge escapes.
    const messages = [
      { id: 'in', seq: 1, senderUserId: 'peer', isOwn: false, bodyText: '嗨', createdAt: at - 120000 },
      { id: 'out', seq: 2, senderUserId: 'me', isOwn: true, bodyText: '你好', createdAt: at - 60000, state: 'persisted' },
    ];
    render(node, messages, { currentUserId: 'me', showSenderNames: true, resolveSender: (id) => id === 'me' ? '我' : '林晚',
      onReact: () => {}, canReact: () => true, onReply: () => {}, canReply: () => true,
      onEdit: () => {}, canEdit: () => true, onRevoke: () => {}, canRevoke: () => true,
      onDownload: () => {}, canDownload: () => true });
    void document.body.offsetHeight;

    const bounds = node.getBoundingClientRect();
    const rows = [...node.querySelectorAll('.collaboration-message')];
    const overlay = (row) => {
      const overlayNode = row.querySelector('.collaboration-message-actions');
      if (!overlayNode) return null;
      const box = overlayNode.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      return { outgoing: row.classList.contains('is-outgoing'), width: Math.round(box.width),
        left: Math.round(box.left), right: Math.round(box.right),
        rowLeft: Math.round(rowBox.left), rowRight: Math.round(rowBox.right), rowWidth: Math.round(rowBox.width),
        threadLeft: Math.round(bounds.left), threadRight: Math.round(bounds.right),
        alignSelf: getComputedStyle(row).alignSelf, threadDisplay: getComputedStyle(node).display,
        insideLeft: box.left >= bounds.left - 0.5, insideRight: box.right <= bounds.right + 0.5 };
    };
    // Also with the overlay revealed, which is the state a pointer produces.
    const revealed = [];
    for (const row of rows) {
      row.querySelector('.collaboration-message-actions')?.style.setProperty('opacity', '1');
      void document.body.offsetHeight;
      revealed.push(overlay(row));
    }
    return JSON.stringify({
      horizontalOverflow: node.scrollWidth - node.clientWidth,
      rowCount: rows.length,
      overlays: revealed,
      // A long unbroken token must wrap rather than widen the thread.
      afterLongWord: (() => {
        render(node, [...messages, { id: 'long', seq: 3, senderUserId: 'peer', isOwn: false,
          bodyText: 'https://example.com/' + 'a'.repeat(300), createdAt: at }], { currentUserId: 'me',
          showSenderNames: true, resolveSender: () => '林晚', onReply: () => {}, canReply: () => true });
        void document.body.offsetHeight;
        return node.scrollWidth - node.clientWidth;
      })(),
    });
  })()`);

  const parsed = JSON.parse(result);
  assert.equal(parsed.rowCount, 2, "both directions rendered");
  assert.equal(parsed.horizontalOverflow, 0,
    `a conversation must not scroll sideways; overflowed by ${parsed.horizontalOverflow}px`);
  assert.equal(parsed.overlays.length, 2, "both rows carry the action overlay");
  for (const overlay of parsed.overlays) {
    assert.ok(overlay, "the overlay exists");
    assert.ok(overlay.width > 0, "the overlay has width, so this is a real measurement");
    assert.equal(overlay.insideLeft, true,
      `the ${overlay.outgoing ? "outgoing" : "incoming"} action overlay must not escape the thread's left edge: ${JSON.stringify(overlay)}`);
    assert.equal(overlay.insideRight, true,
      `the ${overlay.outgoing ? "outgoing" : "incoming"} action overlay must not escape the thread's right edge`);
  }
  assert.equal(parsed.afterLongWord, 0, "a long unbroken URL wraps instead of widening the thread");
  console.log("collaboration thread overflow: no sideways scroll in either direction");
  finish(0);
}).catch((error) => { console.error(error); finish(1); });
