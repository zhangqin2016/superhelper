import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const menu = fs.readFileSync(new URL('../src/renderer/modules/account-menu.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/export /g, '');
const settings = fs.readFileSync(new URL('../src/renderer/modules/account-settings.js', import.meta.url), 'utf8');
const refresh = settings.slice(settings.indexOf('export async function refreshAccountSettings()'), settings.indexOf('\nasync function sendSmsCode()')).replace('export ', '');
const elements = new Map();
for (const id of ['accountMenuBtn', 'accountMenuPopover', 'accountMenuName', 'accountMenuSub', 'accountMenuAvatar', 'accountMenuItemAccount', 'accountStatusText']) {
  elements.set(id, { hidden: false, textContent: '', innerHTML: '', classList: { toggle() {} }, addEventListener() {}, setAttribute() {} });
}
const window = new EventTarget();
let status = { loggedIn: false }, nextStatus;
window.assistantClient = { getAccountStatus: async () => { if (nextStatus) { const pending = nextStatus; nextStatus = null; return pending; } return status; } };
const context = vm.createContext({ window, CustomEvent, document: { getElementById: id => elements.get(id), addEventListener() {} },
  t: key => key, accountFeatureEnabled: () => true, openSettingsPage() {},
  $: id => elements.get(id), setStatus() {}, setLoggedInUi() {}, renderAccountNickname() {}, renderEntitlements() {}, loadOrganizations() {},
  currentAccountPhone: '', currentAccountLoginName: '', console });
vm.runInContext(`${menu}\n${refresh}`, context);
const tick = () => new Promise(resolve => setImmediate(resolve));
vm.runInContext('initAccountMenu()', context); await tick();
assert.equal(elements.get('accountMenuName').textContent, 'account.menu.signedOut');
status = { loggedIn: true, user: { id: 'alice' }, entitlements: {} };
await vm.runInContext('refreshAccountSettings()', context); await tick();
assert.equal(elements.get('accountMenuName').textContent, 'account.menu.signedIn', 'successful account settings refresh must update footer without opening its menu');
let releaseOld;
nextStatus = new Promise(resolve => { releaseOld = resolve; });
const old = vm.runInContext('refreshAccountMenu()', context);
await vm.runInContext('refreshAccountSettings()', context); await tick();
releaseOld({ loggedIn: false }); await old;
assert.equal(elements.get('accountMenuName').textContent, 'account.menu.signedIn', 'late pre-login menu read must not overwrite the refreshed footer');
status = { loggedIn: false };
await vm.runInContext('refreshAccountSettings()', context); await tick();
assert.equal(elements.get('accountMenuName').textContent, 'account.menu.signedOut', 'logout follows the same account-status notification');
console.log('Actual account renderer functions: login/logout refresh footer and stale async reads are fenced.');
