import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let api = {};
try { api = require('../src/main/collaboration/online-status'); } catch {}
assert.equal(typeof api.createOnlineStatus, 'function', 'independent memory-only presence lane exists');
let now = 1000, account = 'a', resolve, calls = 0;
const timers = new Map(); let seq = 0;
const lane = api.createOnlineStatus({ getAccountId: () => account, now: () => now,
  query: () => { calls++; return new Promise(r => { resolve = r; }); },
  setTimeoutFn: (fn, delay) => { timers.set(++seq, {fn, delay}); return seq; }, clearTimeoutFn: id => timers.delete(id) });
const online = () => ({ok:true, observedAt:'2030-01-01T00:00:00Z', states:[{userId:'u',presence:'online',onlineUntil:'2030-01-01T00:01:15Z'}]});
const first = lane.get({userIds:['u']});
await Promise.resolve();
assert.equal(calls, 1);
resolve(online());
assert.equal((await first).states[0].presence, 'online');
assert.equal((await lane.get({userIds:['u']})).states[0].presence, 'online');
assert.equal(calls, 1, '15 second cache avoids duplicate reads');
now += 76000;
assert.equal(lane.snapshot(['u']).states[0].presence, 'unknown', 'relative TTL expires regardless of server clock');
const old = lane.get({userIds:['u']}); await Promise.resolve();
account = 'b'; resolve(online());
assert.equal((await old).states[0].presence, 'unknown', 'old account response fenced');
const revoked = lane.get({userIds:['u']}); await Promise.resolve();
lane.clear(); resolve(online());
assert.equal((await revoked).states[0].presence, 'unknown', 'directory change fences inflight response');
await assert.rejects(() => lane.get({userIds:Array.from({length:201},(_,i)=>`u${i}`)}));
const live = lane.get({userIds:['u']}); await Promise.resolve(); resolve(online()); await live;
lane.disconnected();
assert.equal(lane.snapshot(['u']).states[0].presence, 'unknown', 'disconnect cannot leave green');
lane.stop(); assert.equal(timers.size, 0, 'stop releases timers');
// Multi-window declarations are independent and bounded; every HTTP batch is <=200.
const batches=[];
const multi=api.createOnlineStatus({getAccountId:()=>account,query:async ids=>{batches.push(ids);return {ok:true,observedAt:new Date(now).toISOString(),states:ids.map(userId=>({userId,presence:'offline',onlineUntil:null}))};},now:()=>now});
await multi.get({userIds:['a']},1);await multi.get({userIds:['b']},2);await multi.get({userIds:[]},1);
assert.equal(multi.sourceSnapshot(2).states[0].userId,'b');
assert.equal(multi.sourceSnapshot(2).states[0].presence,'offline','hiding window one does not revoke window two');
await multi.get({userIds:Array.from({length:200},(_,i)=>`x${i}`)},3);
assert.ok(batches.every(ids=>ids.length<=200));
for(let source=4;source<=9;source++) await multi.get({userIds:[`s${source}`]},source);
assert.equal((await multi.get({userIds:['overflow']},10)).ok,false,'ninth source is refused without dropping an existing window');
multi.stop();
// A hung poll must not suppress the timer that expires the last green claim.
now=1000;let firstPoll=true;let expirations=0;
const hung=api.createOnlineStatus({getAccountId:()=>account,now:()=>now,onChange:()=>{expirations++;},
query:async()=>firstPoll?(firstPoll=false,online()):new Promise(()=>{}),
setTimeoutFn:(fn,delay)=>{timers.set(++seq,{fn,delay});return seq;},clearTimeoutFn:id=>timers.delete(id)});
await hung.get({userIds:['u']});
now+=15000;const tick=[...timers.values()][0];timers.clear();tick.fn();await Promise.resolve();
assert.ok(timers.size>0,'lease expiry remains scheduled while network poll is hung');
now+=75000;const expiryTick=[...timers.values()][0];timers.clear();expiryTick.fn();
assert.equal(hung.snapshot(['u']).states[0].presence,'unknown');assert.ok(expirations>=3,'hung network does not suppress expiry notification');
hung.stop();
let fail=false;
const failure=api.createOnlineStatus({getAccountId:()=>account,now:()=>now,query:async()=>{if(fail)throw new Error('offline');return online();}});
await failure.get({userIds:['u']});fail=true;now+=16000;
assert.equal((await failure.get({userIds:['u']})).states[0].presence,'unknown','transport failure removes earlier online claim');failure.stop();
let hints=0;
const hinted=api.createOnlineStatus({getAccountId:()=>account,now:()=>now,query:async()=>{hints++;return online();},setTimeoutFn:(fn,delay)=>{timers.set(++seq,{fn,delay});return seq;},clearTimeoutFn:id=>timers.delete(id)});
await hinted.get({userIds:['u']});hinted.hint();hinted.hint();hinted.hint();
assert.equal([...timers.values()].filter(t=>t.delay===5000).length,1,'hint bursts coalesce for five seconds');hinted.stop();
console.log('collaboration online status: ok');
