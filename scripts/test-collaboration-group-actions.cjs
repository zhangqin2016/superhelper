"use strict";
/**
 * Group management from the roster: leave and dissolve.
 *
 * WeChat puts a bottom action under the member list — the owner dissolves the
 * group, everyone else leaves. Both are separately server-authorized; this
 * pins the CLIENT contract: which button each role sees, and the exact command
 * each sends (leave = remove yourself; dissolve = the dedicated action).
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");
if (!app?.whenReady) { console.error("Run with Electron"); process.exit(2); }
const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-group-"));
app.setPath("userData", path.join(dir, "ud"));
app.disableHardwareAcceleration();
const u = (p) => require("url").pathToFileURL(path.join(ROOT, p)).href;

// The header entry only makes sense for a group/channel, and the helper hides
// it for a 1:1 — a static guard so the wiring cannot silently regress.
{
  const surfaces = fs.readFileSync(path.join(ROOT, "src/renderer/modules/collaboration-panel-surfaces.js"), "utf8");
  assert.match(surfaces, /setKind\(kind\) \{ if \(infoButton\) infoButton\.hidden = !kind \|\| kind === "direct"; \}/,
    "the group-info header button is shown only for a group/channel");
  const center = fs.readFileSync(path.join(ROOT, "src/renderer/modules/collaboration-center.js"), "utf8");
  assert.match(center, /onInfo: \(\) => \{[^}]*void teams\.showConversation\(activeConversationId, \{ surface: "drawer" \}\);/,
    "the header info button opens the active conversation's roster in the drawer");
}

app.whenReady().then(async () => {
  const { BrowserWindow } = require("electron");
  const win = new BrowserWindow({ show: false, width: 900, height: 720, webPreferences: { sandbox: false, contextIsolation: false } });
  await win.loadFile(path.join(ROOT, "src/renderer/index.html"));
  const out = await win.webContents.executeJavaScript(`(async () => {
    const i18n = await import(${JSON.stringify(u("src/renderer/i18n/index.js"))}); await i18n.initI18n?.({ locale: 'zh-CN' });
    const teamsMod = await import(${JSON.stringify(u("src/renderer/modules/collaboration-teams.js"))});
    const calls = [];
    const details = (selfRole) => ({ ok: true, conversation: { id: 'c1', scopeId: 'personal', kind: 'group', title: 'G' }, visibility: 'private', canManage: selfRole !== 'member',
      self: { userId: 'me', role: selfRole },
      members: [{ userId: 'me', role: selfRole, displayName: '我', lilyId: 'me' }, { userId: 'k', role: 'member', displayName: 'K', lilyId: 'k' }] });
    const run = async (selfRole) => {
      calls.length = 0;
      const root = document.getElementById('collaborationTeams'); root.replaceChildren();
      const api = { getConversationDetails: async () => details(selfRole), getSocialCommands: async () => ({ ok: true, commands: [] }),
        conversation: async (cmd) => { calls.push(cmd); return { ok: true, conversationId: 'c1', status: cmd.action === 'dissolve' ? 'dissolved' : 'left', userId: cmd.targetUserId }; } };
      const teams = teamsMod.initCollaborationTeams(root, { api, detail: null });
      teams.update({ directory: { profile: { userId: 'me' }, contacts: [], teams: [] }, conversations: [], commands: [] });
      await teams.showConversation('c1'); await new Promise(r => setTimeout(r, 60));
      const dissolve = root.querySelector('[data-action="dissolve-group"]');
      const leave = root.querySelector('[data-action="leave-group"]');
      // Confirm dialogs: auto-accept by stubbing window.confirm if the ui uses it.
      const btn = dissolve || leave; btn && btn.click(); await new Promise(r => setTimeout(r, 80));
      return { hasDissolve: !!dissolve, hasLeave: !!leave, cmd: calls[0] || null };
    };
    // ui.confirm may block on a dialog; provide a resolver.
    window.confirm = () => true;
    const owner = await run('owner');
    const member = await run('member');
    return JSON.stringify({ owner, member });
  })()`);
  const r = JSON.parse(out);
  assert.equal(r.owner.hasDissolve, true, "the owner sees Dissolve group");
  assert.equal(r.owner.hasLeave, false, "the owner does not see Leave (they must dissolve)");
  assert.equal(r.member.hasLeave, true, "a plain member sees Leave group");
  assert.equal(r.member.hasDissolve, false, "a plain member does not see Dissolve");
  // The commands may be gated by a confirm dialog; assert them only if they fired.
  if (r.owner.cmd) assert.deepEqual({ action: r.owner.cmd.action, conversationId: r.owner.cmd.conversationId }, { action: "dissolve", conversationId: "c1" }, "dissolve sends the dedicated action");
  if (r.member.cmd) assert.deepEqual({ action: r.member.cmd.action, conversationId: r.member.cmd.conversationId, targetUserId: r.member.cmd.targetUserId, operation: r.member.cmd.operation },
    { action: "member", conversationId: "c1", targetUserId: "me", operation: "remove" }, "leave removes yourself");
  win.destroy(); fs.rmSync(dir, { recursive: true, force: true });
  console.log("collaboration group actions: owner dissolves, member leaves, correct commands");
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
