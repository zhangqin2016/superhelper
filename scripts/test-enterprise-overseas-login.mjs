import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const nodes = new Map();
const node = id => { if (!nodes.has(id)) nodes.set(id, { hidden: false, value: '', classList: { toggle() {} }, setAttribute() {} }); return nodes.get(id); };
const source = fs.readFileSync('src/renderer/modules/account-settings.js', 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const context = vm.createContext({ $: node, t: k => k, setInterval, clearInterval });
vm.runInContext(source, context);
vm.runInContext('applyAccountLoginPolicy({ features: { account: false, accountLogin: false, enterpriseAccountLogin: true, purchase: false } })', context);
assert.equal(node('accountModeSmsBtn').hidden, true);
assert.equal(node('accountLoginContent').hidden, true);
assert.equal(node('accountPasswordContent').hidden, false);
assert.equal(node('accountBillingBtn').hidden, true);
vm.runInContext('setLoginMode("sms")', context);
assert.equal(node('accountPasswordContent').hidden, false, 'disabled SMS cannot replace the enterprise form');
vm.runInContext('applyAccountLoginPolicy({ features: { account: true, accountLogin: true, purchase: true } }); setLoginMode("sms")', context);
assert.equal(node('accountModeSmsBtn').hidden, false);
assert.equal(node('accountLoginContent').hidden, false);
const ipc = fs.readFileSync('src/main/ipc-handlers.js', 'utf8');
const guards = ipc.slice(ipc.indexOf('  const personalAccountDisabled'), ipc.indexOf('  const disabledAccountResult'));
for (const enabled of [true, false]) {
 const c = vm.createContext({ require: () => ({ getClientPolicy: () => ({ features: { account: false, accountLogin: false, enterpriseAccountLogin: enabled } }) }) });
 vm.runInContext(guards + '\nthis.personalBlocked = personalAccountDisabled(); this.accountBlocked = accountDisabled();', c);
 assert.equal(c.personalBlocked, true); assert.equal(c.accountBlocked, !enabled);
}
assert.match(ipc, /account:sms-login[\s\S]*?if \(personalAccountDisabled\(\)\)/);
assert.match(ipc, /account:password-login[\s\S]*?if \(accountDisabled\(\)\)/);
console.log('enterprise overseas login: UI selection, domestic SMS fallback and IPC policy isolation passed');
