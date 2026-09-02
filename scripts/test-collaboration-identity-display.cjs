"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
if (!app?.whenReady) { console.error('Run with Electron'); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-display-'));
app.setPath('userData', path.join(dir, 'data')); app.disableHardwareAcceleration();
let win;
const deadline = setTimeout(() => finish(1), 40000);
function finish(code) { clearTimeout(deadline); win?.destroy(); fs.rmSync(dir, { recursive: true, force: true }); app.exit(code); }
app.whenReady().then(async () => {
  const page = path.join(dir, 'index.html');
  fs.writeFileSync(page, '<!doctype html><div id="teams"></div>');
  win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadFile(page);
  const url = (name) => pathToFileURL(path.join(__dirname, '../src/renderer/modules/', name)).href;
  const result = await win.webContents.executeJavaScript(`(async () => {
    const { identityName, socialPerson, resolvePerson } = await import(${JSON.stringify(url('collaboration-social-ui.js'))});
    const { initCollaborationTeams } = await import(${JSON.stringify(url('collaboration-teams.js'))});

    const neverLeaks = (fn, label) => {
      const out = String(fn());
      if (out.includes('usr_')) throw Error(label + ' leaked raw id: ' + out);
      return out;
    };

    const unnamed = neverLeaks(() => identityName({ userId: 'usr_abc123def456' }), 'identityName unnamed');
    const noName = neverLeaks(() => identityName({}), 'identityName empty');
    const social = neverLeaks(() => socialPerson({ userId: 'usr_abc123def456' }), 'socialPerson unnamed');
    const tailVisible = unnamed.includes('def456');

    const directory = { profile: { userId: 'self', displayName: 'Me' }, contacts: [{ userId: 'peer-a', displayName: 'Peer A' }], teams: [{ id: 'org', scopeId: 'team:org', name: 'Team', members: [{ userId: 'peer-b', lilyId: 'peer-b-id' }] }] };
    const self = resolvePerson(directory, 'self');
    const contact = resolvePerson(directory, 'peer-a');
    const teamMember = resolvePerson(directory, 'peer-b');
    const stranger = resolvePerson(directory, 'usr_zzz999');
    const resolvesAcross = self?.displayName === 'Me' && contact?.displayName === 'Peer A' && teamMember?.lilyId === 'peer-b-id' && stranger?.userId === 'usr_zzz999';

    const teamsRoot = document.getElementById('teams');
    const api = { conversation: async () => ({ ok: true }), getConversationDetails: async () => ({ ok: true }), retrySocial: async () => ({ ok: true }) };
    const teams = initCollaborationTeams(teamsRoot, { api, onChanged: async () => {} });
    teams.update({ directory: { profile: { userId: 'self' }, contacts: [], teams: [{ id: 'org', scopeId: 'team:org', name: 'Team', role: 'member', members: [{ userId: 'usr_abc123def456' }] }] }, conversations: [], commands: [] });
    const renderedNoLeak = !teamsRoot.textContent.includes('usr_');

    return { unnamed, noName, social, tailVisible, resolvesAcross, renderedNoLeak };
  })()`);
  assert.equal(result.tailVisible, true, 'friendly placeholder keeps a visible tail');
  assert.equal(result.resolvesAcross, true, 'resolvePerson finds self, contact, team member, and falls back safely');
  assert.equal(result.renderedNoLeak, true, 'team member list never renders a raw usr_ id');
  assert.equal(result.noName.includes('usr_'), false);
  assert.equal(result.social.includes('usr_'), false);
  console.log('collaboration identity display (no raw usr_ id) passed');
}).then(() => finish(0)).catch((error) => { console.error(error); finish(1); });
