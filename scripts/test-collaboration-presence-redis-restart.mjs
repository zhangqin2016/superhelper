import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {createPresenceRedisLifecycle} from '../server/src/services/collaboration/presence-redis.js';
if(process.env.PRESENCE_TEST_RESTART_CONTAINER!=='lily-collaboration-redis'||!process.env.PRESENCE_TEST_CONNECTION_FILE){console.log('SKIP destructive-to-test-state Redis restart: explicit isolated test container opt-in required');process.exit(0);}
const {url}=JSON.parse(await readFile(process.env.PRESENCE_TEST_CONNECTION_FILE,'utf8'));
const namespace=`lily-test:${randomUUID()}`;
const a=await createPresenceRedisLifecycle({url,namespace});
const b=await createPresenceRedisLifecycle({url,namespace});
const docker=promisify(execFile);
const entries=[{userId:'u',activeDevices:new Set(['d']),activeSessions:new Map([['s','d']])}];
let stopped=false;
try{
 await a.store.connect('live',{userId:'u',deviceId:'d',sessionId:'s'});
 assert.equal((await b.store.readBatch(entries))[0].presence,'online');
 await docker('docker',['stop','--time','1','lily-collaboration-redis'],{timeout:15000});stopped=true;
 assert.equal((await b.store.readBatch(entries))[0].presence,'unknown','real Redis outage never claims offline');
 await docker('docker',['start','lily-collaboration-redis'],{timeout:15000});stopped=false;
 await new Promise(resolve=>setTimeout(resolve,2500));
 assert.equal((await b.store.readBatch(entries))[0].presence,'unknown','lost lease remains unknown during recovery warmup');
 let state;
 for(let attempt=0;attempt<15;attempt++){
  await a.store.touch('live');state=(await b.store.readBatch(entries))[0].presence;
  if(state==='online')break;
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 assert.equal(state,'online','live connection heartbeat recreates shared lease after real restart');
 console.log('Real Redis stop/start: outage unknown, recovery warmup unknown, heartbeat restores cross-instance online passed');
}finally{
 if(stopped)await docker('docker',['start','lily-collaboration-redis'],{timeout:15000});
 await Promise.all([a.stop(),b.stop()]);
}
