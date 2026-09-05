"use strict";
/**
 * Wide enough, and the list and the thread sit side by side.
 *
 * The panel was capped at 560px, so the desktop-chat shape — rail, list and
 * thread all on screen — was not reachable by dragging at all; a conversation
 * always REPLACED the list. Asked whether the window was too small, that cap
 * was the answer: not a tuning problem, a structural one.
 *
 * Two panes are for the docked panel only. In overlay mode the panel covers
 * the workbench, and splitting it there would leave both halves narrow for no
 * gain, so the one-column behaviour is kept.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");

if (!app?.whenReady) { console.error("Run with Electron: electron scripts/test-collaboration-two-pane.cjs"); process.exit(2); }
const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-panes-"));
app.setPath("userData", path.join(dir, "userData"));
app.disableHardwareAcceleration();
let win;
const deadline = setTimeout(() => { console.error("collaboration two-pane timed out"); finish(1); }, 40_000);
function finish(code) { clearTimeout(deadline); if (win && !win.isDestroyed()) win.destroy(); fs.rmSync(dir, { recursive: true, force: true }); app.exit(code); }

app.whenReady().then(async () => {
  // Wide enough that the docked mode and a 1100px panel are both reachable.
  win = new BrowserWindow({ show: false, width: 1800, height: 1000,
    webPreferences: { sandbox: false, contextIsolation: false } });
  await win.loadFile(path.join(ROOT, "src/renderer/index.html"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const shellUrl = pathToFileURL(path.join(ROOT, "src/renderer/modules/collaboration-panel-shell.js")).href;

  const at = (width) => win.webContents.executeJavaScript(`(async () => { try {
    const mod = await import(${JSON.stringify(shellUrl)});
    window.__shell?.destroy?.();
    window.localStorage.setItem('lily.collaboration.panelWidth', String(${width}));
    window.__shell = mod.initCollaborationPanelShell({});
    window.__shell.openPanel();
    window.__shell.setConversationOpen(true);
    void document.body.offsetHeight;
    const panel = document.getElementById('collaborationCenter');
    const home = document.getElementById('collaborationHome');
    const conversation = document.getElementById('collaborationConversation');
    const back = document.getElementById('collaborationConversationBack');
    const rect = (node) => { const r = node.getBoundingClientRect(); return { width: Math.round(r.width), left: Math.round(r.left) }; };
    // With the thread closed again, the header must keep its own height: a
    // wrapped flex layout once split the panel's height between header and list.
    window.__shell.setConversationOpen(false);
    void document.body.offsetHeight;
    const headerHeightClosed = Math.round(panel.querySelector('.collaboration-panel-header').getBoundingClientRect().height);
    window.__shell.setConversationOpen(true);
    void document.body.offsetHeight;
    const headerEl = panel.querySelector('.collaboration-panel-header');
    const titleEl = document.getElementById('collaborationPanelTitle');
    const headerOpen = { position: getComputedStyle(headerEl).position, width: Math.round(headerEl.getBoundingClientRect().width),
      titleShown: titleEl ? getComputedStyle(titleEl).display !== 'none' : false };
    return JSON.stringify({
      headerOpen,
      headerHeightClosed,
      panes: panel.dataset.collaborationPanes,
      panelWidth: rect(panel).width,
      home: rect(home), conversation: rect(conversation),
      homeHidden: home.hidden, conversationHidden: conversation.hidden, backHidden: back.hidden,
      // Side by side means both are laid out and the thread begins where the
      // list ends — not merely that neither carries the hidden attribute.
      sideBySide: !home.hidden && !conversation.hidden
        && rect(conversation).left >= rect(home).left + rect(home).width - 1,
    });
  } catch (error) { return JSON.stringify({ error: String(error && error.stack || error) }); } })()`);

  const narrow = JSON.parse(await at(420));
  assert.ok(!narrow.error, `narrow: ${narrow.error || ""}`);
  assert.equal(narrow.panes, "one", "a 420px panel holds one column at a time");
  assert.equal(narrow.homeHidden, true, "and a conversation replaces the list, because nothing else fits");
  assert.equal(narrow.backHidden, false, "so there is a way back to the list");

  const wide = JSON.parse(await at(1100));
  assert.ok(!wide.error, `wide: ${wide.error || ""}`);
  assert.equal(wide.panes, "two", "a 1100px panel holds two");
  assert.ok(wide.headerHeightClosed <= 64,
    `two panes with no thread open keep the header at its own height (${wide.headerHeightClosed}px), not half the panel`);

  // With a thread OPEN in two panes the header must stay full and spanning, not
  // collapse to a corner button — that is the one-pane behaviour, and letting it
  // fire in two panes made the title bar present on People/Teams but gone on
  // Chats. It stays in flow (not absolute), spans the panel, and keeps its title.
  assert.equal(wide.headerOpen.position, "static",
    "two-pane header stays in flow with a conversation open, not collapsed to an absolute corner");
  assert.ok(wide.headerOpen.width >= wide.panelWidth - 2,
    `two-pane header spans the panel with a conversation open (${wide.headerOpen.width} of ${wide.panelWidth})`);
  assert.equal(wide.headerOpen.titleShown, true,
    "two-pane header keeps its destination title with a conversation open (consistent across tabs)");
  assert.equal(wide.sideBySide, true, "the list and the thread are both laid out, thread beside list");
  assert.equal(wide.homeHidden, false, "the list stays, so the selected row keeps its context");
  assert.equal(wide.backHidden, true, "and there is nothing to go back from, so no back button");
  assert.equal(wide.home.width, 344, "the desktop list uses the shared 344px column");
  const wider = JSON.parse(await at(1200));
  assert.ok(!wider.error, `wider: ${wider.error || ""}`);
  assert.equal(wider.home.width, wide.home.width, "widening the panel keeps the list width fixed");
  assert.ok(wider.conversation.width > wide.conversation.width, "widening the panel grows the thread");
  assert.ok(wide.conversation.width > wide.home.width,
    `the thread takes the remaining width (${wide.conversation.width}px vs ${wide.home.width}px)`);

  // Dragging back below the threshold must restore the one-column behaviour,
  // including the way out of a conversation.
  const backToNarrow = JSON.parse(await at(420));
  assert.equal(backToNarrow.panes, "one", "narrowing returns to one column");
  assert.equal(backToNarrow.homeHidden, true, "with the conversation covering the list again");
  assert.equal(backToNarrow.backHidden, false, "and the back button returns with it");

  // The ceiling leaves the workbench usable rather than letting the panel eat
  // the window. This has to be measured in a window where the RESERVE binds
  // rather than the absolute cap: at 1800px the 1240px cap is the smaller of
  // the two, so a window that wide cannot tell the difference — an earlier
  // version of this check passed with the reserve removed entirely.
  const WINDOW = 1360;
  win.setContentSize(WINDOW, 1000);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const huge = JSON.parse(await at(99999));
  assert.ok(!huge.error, `ceiling: ${huge.error || ""}`);
  assert.ok(huge.panelWidth <= WINDOW - 500,
    `the panel leaves room for the workbench beside it (${huge.panelWidth}px of ${WINDOW}px)`);
  assert.ok(huge.panelWidth >= 700, `and still uses what it can (${huge.panelWidth}px)`);
  assert.equal(huge.panes, "two", "and is still two panes at the ceiling");

  console.log("collaboration two-pane: side by side when wide, one column when not");
  finish(0);
}).catch((error) => { console.error(error); finish(1); });
