"use strict";
/**
 * A hidden panel view must occupy nothing, and the reader is never shown a
 * made-up identity.
 *
 * Both were reported from the running app in one screenshot: the contacts
 * screen showed TWO columns — the list plus an empty second column with just a
 * back button — and its first row read "未知用户 / 暂不可用".
 *
 *   - The second column was the detail view. Its `hidden` attribute was set,
 *     but `.collaboration-detail { display: flex }` outranks the UA's
 *     `[hidden] { display: none }`, so it still took 192px. The stylesheet
 *     already had this guard for the other views (`.collaboration-home[hidden]`
 *     and friends); the new view was added without joining it.
 *   - "unknown user" is `identityName`'s fallback. It is a fair placeholder for
 *     SOMEONE ELSE and nonsense for yourself, and it appeared because a fresh
 *     account has no profile yet.
 *
 * The first check is behavioural on purpose — measuring the rendered box rather
 * than grepping for a `[hidden]` rule — because that is the property that
 * matters and it cannot be satisfied by a rule that does not apply.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");

if (!app?.whenReady) { console.error("Run with Electron: electron scripts/test-collaboration-hidden-views.cjs"); process.exit(2); }
const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-hidden-"));
app.setPath("userData", path.join(dir, "userData"));
app.disableHardwareAcceleration();
let win;
const deadline = setTimeout(() => { console.error("collaboration hidden views timed out"); finish(1); }, 30_000);
function finish(code) { clearTimeout(deadline); if (win && !win.isDestroyed()) win.destroy(); fs.rmSync(dir, { recursive: true, force: true }); app.exit(code); }

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1180, height: 900, webPreferences: { sandbox: false, contextIsolation: false } });
  await win.loadFile(path.join(ROOT, "src/renderer/index.html"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  const friendsUrl = pathToFileURL(path.join(ROOT, "src/renderer/modules/collaboration-friends.js")).href;
  const raw = await win.webContents.executeJavaScript(`(async () => { try {
    const panel = document.getElementById('collaborationCenter');
    panel.hidden = false;
    panel.style.position = 'fixed'; panel.style.inset = '0 auto 0 0';
    panel.style.maxWidth = '460px'; panel.style.width = '100%';

    // Every top-level view the panel toggles with the hidden attribute. Each
    // one sets its own display, so each one has to opt back in.
    const views = ['collaborationHome', 'collaborationDetail', 'collaborationConversation'];
    const boxes = {};
    for (const id of views) {
      const node = document.getElementById(id);
      if (!node) { boxes[id] = 'missing'; continue; }
      // The detail view is nested inside the home view, so its ancestors have
      // to be visible or it measures zero whether or not the fix is present.
      for (let up = node.parentElement; up && up !== document.body; up = up.parentElement) up.hidden = false;
      node.hidden = false;
      void document.body.offsetHeight;
      const shown = node.getBoundingClientRect();
      node.hidden = true;
      void document.body.offsetHeight;
      const box = node.getBoundingClientRect();
      boxes[id] = { shownWidth: Math.round(shown.width), width: Math.round(box.width),
        height: Math.round(box.height), display: getComputedStyle(node).display };
    }

    // Elements the code hides at RUNTIME rather than in the markup. A static
    // scan cannot see these, and they are where the guard was missed twice:
    // the thread's back button (hidden for the two-pane layout) and the attach
    // button (hidden by policy) both carry classes that set their own display.
    const runtimeHidden = {};
    for (const id of ['collaborationConversationBack', 'collaborationAttachButton', 'collaborationScrollLatest', 'collaborationTyping']) {
      const node = document.getElementById(id);
      if (!node) { runtimeHidden[id] = 'missing'; continue; }
      for (let up = node.parentElement; up && up !== document.body; up = up.parentElement) up.hidden = false;
      node.hidden = false;
      void document.body.offsetHeight;
      const shown = Math.round(node.getBoundingClientRect().width);
      node.hidden = true;
      void document.body.offsetHeight;
      const box = node.getBoundingClientRect();
      runtimeHidden[id] = { shownWidth: shown, width: Math.round(box.width), height: Math.round(box.height),
        display: getComputedStyle(node).display };
    }

    // The reader's own row, with no profile loaded.
    const friends = await import(${JSON.stringify(friendsUrl)});
    const root = document.getElementById('collaborationFriends');
    const api = { friend: async () => ({ ok: true }), openFriend: async () => ({ ok: true }), lookupFriend: async () => ({ ok: false }) };
    const controller = friends.initCollaborationFriends(root, { api });
    const profileState = (directory) => {
      controller.update({ directory, commands: [] });
      const row = root.querySelector('.is-profile');
      return { present: Boolean(row) && !row.hidden,
        name: row?.querySelector('strong')?.textContent || '' };
    };
    const noProfile = profileState({ contacts: [], teams: [] });
    const emptyProfile = profileState({ profile: {}, contacts: [], teams: [] });
    const realProfile = profileState({ profile: { userId: 'me', lilyId: 'lily_me', displayName: '我' }, contacts: [], teams: [] });
    // Back to nothing: an identity that arrived must not linger after a reset
    // to an account that has none.
    const backToNone = profileState({ contacts: [], teams: [] });
    controller.reset();

    return JSON.stringify({ boxes, runtimeHidden, noProfile, emptyProfile, realProfile, backToNone });
  } catch (error) { return JSON.stringify({ error: String(error && error.stack || error) }); } })()`);

  const result = JSON.parse(raw);
  assert.ok(!result.error, `the harness must run: ${result.error || ""}`);

  for (const [id, box] of Object.entries(result.boxes)) {
    assert.notEqual(box, "missing", `${id} exists in the panel`);
    // Shown first, so a view that is broken in some other way cannot pass this
    // by measuring zero in both states.
    assert.ok(box.shownWidth > 0, `${id} occupies space when shown (${box.shownWidth}px)`);
    assert.equal(box.width, 0, `${id} must occupy no width while hidden; its own display: ${box.display} outranks the UA rule`);
    assert.equal(box.height, 0, `${id} must occupy no height while hidden`);
  }

  for (const [id, box] of Object.entries(result.runtimeHidden)) {
    assert.notEqual(box, "missing", `${id} exists in the panel`);
    assert.ok(box.shownWidth > 0, `${id} occupies space when shown (${box.shownWidth}px)`);
    assert.equal(box.width, 0, `${id} is hidden at runtime and must then occupy nothing; its display: ${box.display} outranks the UA rule`);
    assert.equal(box.height, 0, `${id} must occupy no height while hidden`);
  }

  assert.equal(result.noProfile.present, false, "with no profile there is no identity row: the fallback names an unknown user, which is nonsense for yourself");
  assert.equal(result.emptyProfile.present, false, "an empty profile object is still no identity");
  assert.equal(result.realProfile.present, true, "a real profile does get a row");
  assert.equal(result.realProfile.name, "我", "and shows the actual name");
  assert.equal(result.backToNone.present, false, "an identity does not linger once the account has none again");

  console.log("collaboration hidden views: nothing hidden takes space, no invented identity");
  finish(0);
}).catch((error) => { console.error(error); finish(1); });
