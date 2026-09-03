"use strict";
/**
 * The collaboration panel, detached into its own window.
 *
 * It loads the SAME `index.html` with `?view=collaboration` rather than a
 * second copy of the panel's markup: two copies would drift and every fix
 * would have to be made twice.
 *
 * Nothing in the data layer changed, and that was checked before building
 * this: `collaboration:subscribe` already keys its subscriptions by `sender`
 * and hands each one its own unsubscribe, so a second window subscribes
 * independently and gets its own state events.
 *
 * Two things this pins that are easy to lose:
 *   - the window must present ONLY the panel. Reusing the entry means the
 *     workbench markup is present in the document, so anything left in the
 *     layout would appear behind or beside the panel.
 *   - it must not BUILD the workbench either. The same entry runs the same
 *     boot function, which starts pollers, model lists, mail accounts and
 *     session UI that a second window would duplicate for nothing.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

if (!app?.whenReady) { console.error("Run with Electron: electron scripts/test-collaboration-detached-window.cjs"); process.exit(2); }
const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-detached-"));
app.setPath("userData", path.join(dir, "userData"));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error("collaboration detached window timed out"); finish(1); }, 45_000);
let manager = null;
function finish(code) { clearTimeout(deadline); try { manager?.close(); } catch { /* closing */ } fs.rmSync(dir, { recursive: true, force: true }); app.exit(code); }

app.whenReady().then(async () => {
  const { createCollaborationWindowManager, MIN_WIDTH, MIN_HEIGHT } = require(path.join(ROOT, "src/main/collaboration-window.js"));
  assert.ok(MIN_WIDTH >= 760, `a detached window starts wide enough for two panes (${MIN_WIDTH}px)`);
  assert.ok(MIN_HEIGHT >= 480, `and tall enough for a thread (${MIN_HEIGHT}px)`);

  let remembered = null;
  let closedReported = 0;
  manager = createCollaborationWindowManager({
    readBounds: () => remembered,
    writeBounds: (bounds) => { remembered = bounds; },
    onClosed: () => { closedReported += 1; },
  });

  assert.equal(manager.isOpen(), false, "nothing is open before it is asked for");
  const win = manager.open();
  // A second window would be two views of the same list fighting over focus.
  assert.equal(manager.open(), win, "opening again focuses the existing window rather than making a second");
  assert.equal(manager.isOpen(), true);

  await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const raw = await win.webContents.executeJavaScript(`(() => {
    const shell = document.getElementById('appShell');
    const panel = document.getElementById('collaborationCenter');
    const rect = (node) => { const r = node.getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height) }; };
    // Anything in the shell other than the panel must be out of the layout.
    const strays = [...shell.children]
      .filter((el) => el.id !== 'collaborationCenter' && !el.classList.contains('collaboration-panel-scrim'))
      .filter((el) => el.getBoundingClientRect().width > 0 || el.getBoundingClientRect().height > 0)
      .map((el) => el.id || String(el.className));
    return JSON.stringify({
      search: window.location.search,
      view: shell.dataset.appView,
      panelHidden: panel.hidden,
      panel: rect(panel),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      panes: panel.dataset.collaborationPanes,
      strays,
      // The docked-only controls have no meaning in a window of its own.
      closeHidden: document.getElementById('collaborationPanelClose').hidden,
      detachHidden: document.getElementById('collaborationPanelDetach').hidden,
      resizeHidden: document.getElementById('collaborationResizeHandle').hidden,
      // Proof the workbench was not BUILT: these are only populated by the
      // parts of boot that a detached window skips.
      workbenchBuilt: {
        projectTree: (document.getElementById('projectTree')?.children.length || 0) > 0,
        sessionList: (document.getElementById('sessionList')?.children.length || 0) > 0,
      },
    });
  })()`);
  const result = JSON.parse(raw);

  assert.equal(result.search, "?view=collaboration", "the window is told which view to present");
  assert.equal(result.view, "collaboration", "and the shell records it");
  assert.equal(result.panelHidden, false, "the panel is open without anyone toggling it");
  assert.equal(result.panes, "two", "a window of its own is always wide enough for two panes");
  assert.ok(result.panel.width >= result.viewport.width - 1 && result.panel.height >= result.viewport.height - 1,
    `the panel fills the window (${result.panel.width}x${result.panel.height} of ${result.viewport.width}x${result.viewport.height})`);
  assert.deepEqual(result.strays, [], "nothing but the panel is laid out; the workbench markup is present but not shown");
  assert.equal(result.closeHidden, true, "no close button: the window's own chrome closes it");
  assert.equal(result.detachHidden, true, "no detach button: it is already detached");
  assert.equal(result.resizeHidden, true, "no drag handle: the window edge resizes it");
  assert.equal(result.workbenchBuilt.projectTree, false, "the workbench is not built, only hidden");
  assert.equal(result.workbenchBuilt.sessionList, false, "so a second window does not duplicate its pollers and lists");

  // Position and size survive, and a display that has gone away does not
  // strand the window off screen.
  win.setBounds({ x: 140, y: 100, width: 980, height: 720 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(remembered && remembered.width === 980 && remembered.height === 720,
    `bounds are remembered (${JSON.stringify(remembered)})`);
  // Tested as a pure predicate, not by creating a window: macOS clamps an
  // off-screen window into a display on its own, so reading bounds back cannot
  // tell whether this check ran. Windows and Linux do not always clamp.
  const { boundsOnAVisibleDisplay } = require(path.join(ROOT, "src/main/collaboration-window.js"));
  const desktop = { x: 0, y: 0, width: 1920, height: 1080 };
  const area = () => desktop;
  assert.deepEqual(boundsOnAVisibleDisplay({ x: 100, y: 100, width: 900, height: 700 }, area),
    { x: 100, y: 100, width: 900, height: 700 }, "a position on the desktop is reused");
  for (const gone of [
    { x: -9000, y: -9000, width: 900, height: 700 },
    { x: 1900, y: 100, width: 900, height: 700 },
    { x: 100, y: 1075, width: 900, height: 700 },
    { x: -890, y: 100, width: 900, height: 700 },
  ]) {
    assert.equal(boundsOnAVisibleDisplay(gone, area), null,
      `a position that leaves nothing reachable is not reused: ${JSON.stringify(gone)}`);
  }
  for (const junk of [null, undefined, {}, { x: 1, y: 1 }, { x: NaN, y: 0, width: 900, height: 700 }]) {
    assert.equal(boundsOnAVisibleDisplay(junk, area), null, `malformed bounds are not reused: ${JSON.stringify(junk)}`);
  }
  assert.equal(boundsOnAVisibleDisplay({ x: 100, y: 100, width: 900, height: 700 }, () => null), null,
    "no resolvable display means the default position, not a guess");

  assert.equal(manager.close(), true, "closing reports that it closed");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(manager.isOpen(), false, "and it is gone");
  assert.equal(closedReported, 1, "the main window is told once, so its docked panel can come back");
  assert.equal(manager.close(), false, "closing again is a no-op rather than an error");

  console.log("collaboration detached window: presents only the panel, and does not build the workbench");
  finish(0);
}).catch((error) => { console.error(error); finish(1); });
