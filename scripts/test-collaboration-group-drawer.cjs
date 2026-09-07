"use strict";
/**
 * 群信息 opens as a right-side drawer over the thread, with the members as a
 * grid of faces — WeChat's shape — instead of replacing the chat list with a
 * vertical roster. The same roster content is reused, so add/remove/leave and
 * the read-only note all still work; only the surface and layout change.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");
if (!app?.whenReady) { console.error("Run with Electron"); process.exit(2); }
const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-drawer-"));
app.setPath("userData", path.join(dir, "ud"));
app.disableHardwareAcceleration();
const u = (p) => require("url").pathToFileURL(path.join(ROOT, p)).href;

// The header button opens the roster on the DRAWER, not the list-column detail.
{
  const center = fs.readFileSync(path.join(ROOT, "src/renderer/modules/collaboration-center.js"), "utf8");
  assert.match(center, /teams\.showConversation\(activeConversationId, \{ surface: "drawer" \}\)/,
    "group info from a conversation opens on the drawer");
  assert.match(center, /createDrawerSurface\(\{ view: byId\("collaborationGroupDrawer"\)/, "the centre builds the drawer surface");
}

app.whenReady().then(async () => {
  const { BrowserWindow } = require("electron");
  const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: false, contextIsolation: false } });
  await win.loadFile(path.join(ROOT, "src/renderer/index.html"));
  const out = await win.webContents.executeJavaScript(`(async () => {
    const i18n = await import(${JSON.stringify(u("src/renderer/i18n/index.js"))}); await i18n.initI18n?.({ locale: 'zh-CN' });
    const teamsMod = await import(${JSON.stringify(u("src/renderer/modules/collaboration-teams.js"))});
    const sfx = await import(${JSON.stringify(u("src/renderer/modules/collaboration-panel-surfaces.js"))});
    const view = document.getElementById('collaborationGroupDrawer');
    const drawer = sfx.createDrawerSurface({ view, title: document.getElementById('collaborationGroupDrawerTitle'),
      body: document.getElementById('collaborationGroupDrawerBody'), close: document.getElementById('collaborationGroupDrawerClose') });
    const members = ['me','k','q','w','z'].map((id, i) => ({ userId: id, role: id === 'k' ? 'owner' : 'member', displayName: 'N' + i, lilyId: id }));
    const api = { getConversationDetails: async (id) => ({ ok: true, conversation: { id, scopeId: 'personal', kind: 'group', title: 'G' },
        visibility: 'private', canManage: false, self: { userId: 'me', role: 'member' }, members }),
      getSocialCommands: async () => ({ ok: true, commands: [] }), conversation: async () => ({ ok: true }) };
    const teams = teamsMod.initCollaborationTeams(document.getElementById('collaborationTeams'), { api, detail: null, drawer });
    teams.update({ directory: { profile: { userId: 'me' }, contacts: [], teams: [] }, conversations: [{ id: 'c1' }], commands: [] });
    const hiddenBefore = view.hidden;
    await teams.showConversation('c1', { surface: 'drawer' });
    await new Promise(r => setTimeout(r, 80));
    const body = document.getElementById('collaborationGroupDrawerBody');
    const cs = getComputedStyle(body);
    const tiles = [...body.querySelectorAll(':scope > .collaboration-social-row')];
    const tileCs = tiles[0] ? getComputedStyle(tiles[0].querySelector('.collaboration-row-open')) : null;
    const leave = body.querySelector('[data-action="leave-group"]');
    const result = {
      hiddenBefore, drawerOpen: !view.hidden,
      display: cs.display,
      tiles: tiles.length, tileDirection: tileCs?.flexDirection,
      // Roles stay visible in the stable row layout, independent of hover.
      roleHidden: tiles[0] ? getComputedStyle(tiles[0].querySelector('.collaboration-row-content small')).display === 'none' : null,
      hasLeave: Boolean(leave), leaveFits: leave ? leave.getBoundingClientRect().right <= body.getBoundingClientRect().right : false,
      // The drawer names the group; the scope suffix belongs to the list-column detail.
      title: document.getElementById('collaborationGroupDrawerTitle').textContent,
    };
    // Closing the drawer empties it and hides it again.
    document.getElementById('collaborationGroupDrawerClose').click();
    await new Promise(r => setTimeout(r, 30));
    result.closed = view.hidden && body.children.length === 0;
    return JSON.stringify(result);
  })()`);
  const r = JSON.parse(out);
  assert.equal(r.hiddenBefore, true, "the drawer starts closed");
  assert.equal(r.drawerOpen, true, "group info opens the drawer");
  assert.equal(r.display, "flex", "members use stable full-width rows with explicit management");
  assert.equal(r.tiles, 5, "one tile per member");
  assert.equal(r.tileDirection, "row", "each member keeps avatar and name horizontally aligned");
  assert.equal(r.roleHidden, false, "roles remain readable without hovering");
  assert.equal(r.hasLeave, true, "the leave action is in the drawer");
  assert.equal(r.leaveFits, true, "the leave action stays within the drawer");
  assert.equal(r.title, "G", "the drawer names the group without a scope suffix");
  assert.equal(r.closed, true, "closing hides and empties the drawer");
  win.destroy(); fs.rmSync(dir, { recursive: true, force: true });
  console.log("collaboration group drawer: right-side surface, stable member rows, leave action, closes clean");
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
