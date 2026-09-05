"use strict";
/**
 * Two things the IM lists got wrong, both user-visible:
 *  1. A 1:1 conversation has no stored title, so every list and the thread
 *     header showed the raw conversation id — "a long string". It must be
 *     named after the other person, who in turn must be named by nickname,
 *     then enterprise login, then masked phone — never an opaque id.
 *  2. The Teams view rebuilt every section on every sync event and snapped to
 *     the top — "jumping". An update that changes nothing visible must leave
 *     the DOM alone; one that does rebuild must keep scroll and open forms.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
if (!app?.whenReady) { console.error('Run with Electron'); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-stability-'));
app.setPath('userData', path.join(dir, 'data')); app.disableHardwareAcceleration();
let win;
const deadline = setTimeout(() => finish(1), 40000);
function finish(code) { clearTimeout(deadline); win?.destroy(); fs.rmSync(dir, { recursive: true, force: true }); app.exit(code); }
app.whenReady().then(async () => {
  const page = path.join(dir, 'index.html');
  fs.writeFileSync(page, '<!doctype html><style>#inbox{height:120px;overflow-y:auto}#scroller{height:160px;overflow-y:auto}</style><div id="inbox"></div><div id="scroller"><div id="teams"></div></div>');
  win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadFile(page);
  const url = (name) => pathToFileURL(path.join(__dirname, '../src/renderer/modules/', name)).href;
  const result = await win.webContents.executeJavaScript(`(async () => {
    const { identityName, conversationDisplayTitle, resolvePerson } = await import(${JSON.stringify(url('collaboration-social-ui.js'))});
    const { renderCollaborationInbox } = await import(${JSON.stringify(url('collaboration-inbox.js'))});
    const { initCollaborationTeams } = await import(${JSON.stringify(url('collaboration-teams.js'))});
    const { t } = await import(${JSON.stringify(pathToFileURL(path.join(__dirname, '../src/renderer/i18n/index.js')).href)});
    const out = {};

    // --- identity chain -------------------------------------------------
    out.nickname = identityName({ displayName: '林晚', loginName: 'max_0001', phoneMasked: '138****5678', lilyId: 'lw' });
    out.login = identityName({ displayName: '', loginName: 'max_0001', phoneMasked: '138****5678', lilyId: 'lw' });
    out.phone = identityName({ displayName: '', loginName: '', phoneMasked: '138****5678', lilyId: 'lw', userId: 'usr_abc123def456' });
    out.handle = identityName({ lilyId: 'lw', userId: 'usr_abc123def456' });
    out.bare = identityName({ userId: 'usr_abc123def456' });

    // --- conversation title ---------------------------------------------
    const directory = { profile: { userId: 'self', displayName: 'Me' }, contacts: [
      { userId: 'peer-phone', displayName: '', loginName: '', phoneMasked: '138****5678' },
      { userId: 'peer-login', displayName: '', loginName: 'max_0002' },
      { userId: 'peer-named', displayName: '林晚' },
    ], teams: [] };
    const resolveName = (id) => identityName(resolvePerson(directory, id));
    const opts = { currentUserId: 'self', resolveName };
    out.directPhone = conversationDisplayTitle({ id: 'conv_9f8e7d6c5b4a3', kind: 'direct', title: '', memberUserIds: ['self', 'peer-phone'] }, opts);
    out.directLogin = conversationDisplayTitle({ id: 'conv_1', kind: 'direct', title: '', memberUserIds: ['peer-login', 'self'] }, opts);
    out.directUnknown = conversationDisplayTitle({ id: 'conv_2', kind: 'direct', title: '', memberUserIds: ['self', 'usr_zzz999'] }, opts);
    out.unknownPerson = identityName({ userId: 'usr_zzz999' });
    out.directNoMembers = conversationDisplayTitle({ id: 'conv_3', kind: 'direct', title: '' }, opts);
    out.titled = conversationDisplayTitle({ id: 'conv_4', kind: 'group', title: '交互小组', memberUserIds: ['self', 'peer-named'] }, opts);
    out.groupDerived = conversationDisplayTitle({ id: 'conv_5', kind: 'group', title: '', memberUserIds: ['self', 'peer-named', 'peer-login', 'peer-phone', 'usr_zzz'] }, opts);
    out.hydrated = conversationDisplayTitle({ id: 'conv_6', kind: 'direct', title: '', members: [{ userId: 'self' }, { userId: 'peer-named' }] }, opts);
    out.fallbackLabel = t('collaboration.conversation');

    // --- inbox rows: named after the person, scroll kept across a repaint --
    const inbox = document.getElementById('inbox');
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: 'conv_' + i, kind: 'direct', scopeId: 'personal', title: '', memberUserIds: ['self', i === 0 ? 'peer-phone' : 'peer-named'], updatedAt: 1000 + i }));
    renderCollaborationInbox(inbox, rows, { currentUserId: 'self', resolveSender: resolveName });
    out.inboxFirst = inbox.querySelector('.collaboration-inbox-item[data-conversation-id="conv_0"] strong')?.textContent;
    out.inboxLeaks = inbox.textContent.includes('conv_');
    // A synchronous clear+refill never lets Chromium observe the empty state,
    // so scrollTop survives on its own there. The helper matters when a rebuild
    // forces layout while the list is empty (reading offsets, focus, etc.):
    // the scroller clamps to 0 and stays there without an explicit restore.
    const { preserveScroll } = await import(${JSON.stringify(url('collaboration-social-ui.js'))});
    inbox.scrollTop = 200; const before = inbox.scrollTop;
    const refill = () => { const kept = [...inbox.children]; inbox.replaceChildren(); void inbox.offsetHeight; inbox.append(...kept); };
    refill(); const withoutHelper = inbox.scrollTop;
    inbox.scrollTop = 200; preserveScroll(inbox, refill);
    out.inboxScroll = [before, withoutHelper, inbox.scrollTop];
    // Search matches what the row SHOWS, not the empty stored title.
    renderCollaborationInbox(inbox, rows, { currentUserId: 'self', resolveSender: resolveName, filterText: '138' });
    out.inboxSearch = inbox.querySelectorAll('.collaboration-inbox-item').length;

    // --- teams: no-op on an identical payload, stable across a real rebuild --
    const teamsRoot = document.getElementById('teams');
    const api = { conversation: async () => ({ ok: true }), getConversationDetails: async () => ({ ok: true }), retrySocial: async () => ({ ok: true }) };
    const teams = initCollaborationTeams(teamsRoot, { api, onChanged: async () => {} });
    const members = Array.from({ length: 12 }, (_, i) => ({ userId: 'm' + i, displayName: 'Member ' + i, role: 'member', presence: 'offline', onlineUntil: null }));
    const teamDir = (extra = {}) => ({ profile: { userId: 'self' }, contacts: [], teams: [{ id: 'org', scopeId: 'team:org', name: 'Acme', role: 'admin', members: members.map((m) => ({ ...m, ...(extra[m.userId] || {}) })) }] });
    const channels = Array.from({ length: 8 }, (_, i) => ({ id: 'ch' + i, kind: 'channel', scopeId: 'team:org', title: '频道 ' + i }));
    teams.update({ directory: teamDir(), conversations: channels, commands: [] });
    const firstNode = teamsRoot.querySelector('section.collaboration-team');
    teamsRoot.querySelector('section.collaboration-team details.collaboration-disclosure').open = true;
    // Same content again (what a typing tick / read receipt / 15 s poll produces):
    teams.update({ directory: teamDir(), conversations: channels, commands: [] });
    out.noopKeepsNodes = teamsRoot.querySelector('section.collaboration-team') === firstNode;
    // onlineUntil advances on every poll while nothing visible changed:
    teams.update({ directory: teamDir({ m1: { onlineUntil: new Date(Date.now() + 60000).toISOString() } }), conversations: channels, commands: [] });
    out.onlineUntilIsNoise = teamsRoot.querySelector('section.collaboration-team') === firstNode;
    // Someone actually comes online → a rebuild, which must keep scroll + the open form:
    teams.update({ directory: teamDir({ m1: { presence: 'online', onlineUntil: new Date(Date.now() + 60000).toISOString() } }), conversations: channels, commands: [] });
    out.presenceRebuilds = teamsRoot.querySelector('section.collaboration-team') !== firstNode;
    out.formStillOpen = teamsRoot.querySelector('section.collaboration-team details.collaboration-disclosure').open;
    // Channel rows are named, never by id:
    out.channelLeaks = teamsRoot.textContent.includes('ch0');
    return out;
  })()`);
  assert.equal(result.nickname, '林晚', 'nickname first');
  assert.equal(result.login, 'max_0001', 'no nickname → enterprise login');
  assert.equal(result.phone, '138****5678', 'no login → masked phone, before the Lily handle');
  assert.equal(result.handle, 'lw', 'handle only when nothing more recognisable exists');
  assert.equal(result.bare.includes('usr_'), false, 'never the raw id');
  assert.equal(result.directPhone, '138****5678', 'a 1:1 is named after the other person');
  assert.equal(result.directLogin, 'max_0002');
  assert.equal(result.directUnknown, result.unknownPerson, 'an unresolvable peer is named the way that person is named everywhere (placeholder + tail)');
  assert.equal(result.directUnknown.includes('usr_'), false, 'never the raw id');
  assert.equal(result.directNoMembers, result.fallbackLabel);
  assert.equal(result.titled, '交互小组', 'a stored title always wins');
  assert.equal(result.groupDerived, '林晚、max_0002、138****5678', 'an untitled group is named by its recognisable members');
  assert.equal(result.hydrated, '林晚', 'hydrated shape ({members:[{userId}]}) works too');
  assert.equal(result.inboxFirst, '138****5678', 'inbox row heading is the person');
  assert.equal(result.inboxLeaks, false, 'no conversation id anywhere in the inbox');
  assert.equal(result.inboxScroll[0] > 0, true, 'fixture actually scrolled');
  assert.equal(result.inboxScroll[1], 0, 'control: a rebuild that forces layout while empty does lose the offset');
  assert.equal(result.inboxScroll[2], result.inboxScroll[0], 'preserveScroll puts the offset back');
  assert.equal(result.inboxSearch, 1, 'search matches the displayed name');
  assert.equal(result.noopKeepsNodes, true, 'an identical payload does not rebuild the Teams DOM');
  assert.equal(result.onlineUntilIsNoise, true, 'onlineUntil advancing alone is not a visible change');
  assert.equal(result.presenceRebuilds, true, 'a real presence change does repaint');
  assert.equal(result.formStillOpen, true, 'an open channel form survives a rebuild');
  assert.equal(result.channelLeaks, false);
  console.log('collaboration list stability (titles, identity chain, no-jump teams) passed');
}).then(() => finish(0)).catch((error) => { console.error(error); finish(1); });
