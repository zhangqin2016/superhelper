import assert from 'node:assert/strict';
import { normalizeNickname, updateAccountNickname } from '../server/src/services/account-profile.js';
assert.equal(normalizeNickname(' 小莉 🌸 '), '小莉 🌸');
for (const v of ['', '   ', null, 32, 'a'.repeat(33), 'x\ny', 'x\u0000y']) assert.equal(normalizeNickname(v), null);
assert.equal(normalizeNickname('🌸'.repeat(32)), '🌸'.repeat(32));
const writes = [];
let active = { id: 'self', status: 'active', password_must_change: false };
const db = { transaction: () => ({ execute: fn => fn(db) }),
 selectFrom: () => { const q = { select: () => q, where: (k, op, v) => { assert.equal(v, 'self'); return q; }, forUpdate: () => q, executeTakeFirst: async () => active }; return q; },
 insertInto: table => { let values; const q = { values: v => { values = v; return q; }, onConflict: fn => { const c = { column: () => c, doUpdateSet: () => c }; fn(c); return q; }, execute: async () => writes.push({ table, values }) }; return q; },
 updateTable: table => { let values; const q = { set: v => { values = v; return q; }, where: (k, op, v) => { assert.equal(v, 'self'); return q; }, execute: async () => writes.push({ table, values }) }; return q; } };
assert.deepEqual(await updateAccountNickname(db, 'self', '小莉'), { ok: true, displayName: '小莉' });
assert.deepEqual(writes.map(w => w.table), ['users', 'user_profiles']);
assert.ok(writes.every(w => w.values.display_name === '小莉'));
active.password_must_change = true;
assert.equal((await updateAccountNickname(db, 'self', 'other')).code, 'PASSWORD_CHANGE_REQUIRED');
active.status = 'disabled';
assert.equal((await updateAccountNickname(db, 'self', 'other')).code, 'USER_DISABLED');
assert.equal(writes.length, 2);
console.log('account nickname: Unicode bounds, account isolation and profile update passed');
const fs = await import('node:fs');
const vm = await import('node:vm');
const nodes = new Map();
const node = id => { if (!nodes.has(id)) nodes.set(id, { value: '', hidden: false, addEventListener: (_event, fn) => { nodes.get(id).click = fn; } }); return nodes.get(id); };
let payload, refreshed = 0;
const ctx = vm.createContext({ $: node, t: k => k, window: { assistantClient: { updateAccountProfile: async p => { payload = p; return { ok: true, displayName: p.displayName }; } } }, refresh: async () => refreshed++ });
const source = fs.readFileSync('src/renderer/modules/account-nickname.js', 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
vm.runInContext(source + '\ninitAccountNickname(refresh); renderAccountNickname({loggedIn:true,user:{id:"u1",displayName:"Old"}});', ctx);
assert.equal(node('accountNicknameInput').value, 'Old');
node('accountNicknameInput').value = ' 小莉 🌸 ';
await node('accountNicknameSaveBtn').click();
assert.deepEqual(JSON.parse(JSON.stringify(payload)), { displayName: '小莉 🌸' });
assert.equal(refreshed, 1);
assert.equal(node('accountNicknameStatus').textContent, 'settings.nicknameSaved');
vm.runInContext('renderAccountNickname(null)', ctx);
assert.equal(node('accountNicknamePanel').hidden, true);
console.log('account nickname UI: successful save, trim and logged-out visibility passed');
