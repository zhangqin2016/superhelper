import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { registerCollaborationRealtimeGateway } from '../server/src/services/collaboration/realtime-gateway.js';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const Fastify = require('fastify');
const { WebSocket } = require('ws');
const app = Fastify();
const tokens = new Map([['one', { userId: 'u', deviceId: 'd1' }], ['two', { userId: 'u', deviceId: 'd2' }]]);
const gateway = registerCollaborationRealtimeGateway(app, { ticketService: { consume: async ({ticket}) => { const identity = tokens.get(ticket); if(!identity) throw Error('bad ticket'); tokens.delete(ticket); return identity; } } });
const base = await app.listen({ host: '127.0.0.1', port: 0 });
const sockets = [];
try {
 for (const ticket of ['one', 'two']) { const ws = new WebSocket(base.replace('http:', 'ws:')+'/api/collaboration/v1/realtime?ticket='+ticket); sockets.push(ws); await once(ws,'open'); }
 assert.ok(app.collaborationPresence.expiresAt('u', new Set(['d1','d2'])));
 const ack = new Promise(resolve => sockets[1].on('message', raw => { const f=JSON.parse(raw); if(f.type==='realtime.heartbeat-ack') resolve(f); }));
 sockets[1].send(JSON.stringify({type:'realtime.heartbeat',schemaVersion:1,userId:'spoofed'})); await ack;
 assert.equal(app.collaborationPresence.expiresAt('spoofed',new Set(['d2'])),null);
 const serverSockets = [...gateway.wss.clients];
 const closedOne = once(serverSockets[0], 'close');
 sockets[0].close(); await Promise.all([once(sockets[0],'close'), closedOne]);
 assert.ok(app.collaborationPresence.expiresAt('u', new Set(['d2'])));
 const closedTwo = once(serverSockets[1], 'close');
 sockets[1].close(); await Promise.all([once(sockets[1],'close'), closedTwo]);
 // Server close callback may follow the peer's close by a tick.
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(app.collaborationPresence.expiresAt('u',new Set(['d1','d2'])),null);
 console.log('enterprise presence actual websocket: heartbeat accepted, identity protected, multi-device disconnect passed');
} finally { for(const ws of sockets) ws.terminate(); await app.close(); }
