import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createLatestOpenQueue } from '../src/renderer/modules/collaboration-open-queue.js';
const { cachedHistory } = createRequire(import.meta.url)('../src/main/collaboration/cached-history.js');
let blocked = '';
const reads = [];
const store = { accountId: 'self', db: { get(sql, ...args) {
  assert.equal(args[0], 'self', 'every cache eligibility check is account scoped');
  return blocked && sql.includes(`FROM ${blocked} `) ? { found: 1 } : undefined;
} }, getConversation: () => ({ id: 'c', scopeId: 'personal' }),
listMessages(options) { reads.push(options); return options.includePending === false ? [{ id: 'm', seq: 1 }] : [{ id: 'pending', seq: null }]; } };
assert.equal(cachedHistory(store, 'c').messages.length, 2);
for (const table of ['revoked_conversations', 'revoked_scopes', 'conversation_hydration', 'history_hydration', 'history_hydration_targets']) {
  blocked = table; reads.length = 0;
  assert.equal(cachedHistory(store, 'c').ok, false, `${table} prevents stale preview`);
  assert.equal(reads.length, 0, 'no message bodies read when eligibility fails');
}
assert.equal(cachedHistory({ ...store, db: null }, 'c').ok, false, 'legacy adapters retain normal open');
const queue = createLatestOpenQueue();
let release, current = 'a'; const calls = [];
const a = queue(() => { calls.push('a'); return new Promise(r => { release = r; }); }, () => current === 'a');
await new Promise(r => setImmediate(r));
current = 'b'; const b = queue(() => calls.push('b'), () => current === 'b');
current = 'c'; const c = queue(() => calls.push('c'), () => current === 'c');
release(); await Promise.all([a,b,c]);
assert.deepEqual(calls, ['a','c'], 'a slow running request cannot force obsolete intermediate clicks onto HTTP');
await queue(() => Promise.reject(new Error('offline')), () => true).catch(() => {});
assert.equal(await queue(() => 'recovered', () => true), 'recovered', 'network failure cannot poison future navigation');
console.log('fast open: scoped cache eligibility, pending/revoked rejection, latest-only queue and recovery passed');
