import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { CollaborationStore } = require('../src/main/collaboration/collaboration-store.js');
const { LocalCollaborationKeyring } = require('../src/main/collaboration/local-keyring.js');
const { createCollaborationService } = require('../src/main/collaboration/service.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-directory-refresh-'));
const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, 'keys'), safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() } });
const open = () => new CollaborationStore({ dbPath: path.join(dir, 'cache.db'), accountId: 'owner', keyring });
let store = open(), service;
let unavailable = true, historyUnavailable = false;
const calls = [];
const snapshot = { watermark: 1, directorySchemaVersion: 1, relationships: [], friendRequests: [], blocks: [], profiles: [], conversations: [], teams: [{ id: 'org', name: 'Team', role: 'owner', status: 'active' }], teamMembers: [{ organization_id: 'org', user_id: 'member', role: 'admin' }] };
const client = {
  async bootstrap() { calls.push('bootstrap'); if (unavailable) throw new Error('offline'); return snapshot; },
  async acknowledgeCursor({ cursor }) { calls.push(`ack:${cursor}`); },
  async listMessageHistory() { calls.push('history'); if (historyUnavailable) throw new Error('history offline'); return []; },
  async syncAndAcknowledge({ afterCursor, onIncrementalPage }) {
    calls.push(`sync:${afterCursor}`);
    const toCursor = Math.max(1, afterCursor);
    return onIncrementalPage({ page: { status: 'OK', fromCursor: afterCursor, toCursor, events: afterCursor === 0 ? [{ id: 'directory-event', cursor: 1, type: 'directory.changed', conversationId: null, payload: { scopeType: 'organization', organizationId: 'org' } }] : [] }, acknowledge: () => client.acknowledgeCursor({ cursor: toCursor }) });
  },
};
const start = () => createCollaborationService({ openStore: () => ({ ok: true, store }), client, deviceId: 'device-owner', realtimeOptions: { syncArgs: { deviceId: 'device-owner' } } });
try {
  store.replaceProjectionFromBootstrap({ watermark: 0, conversations: [] });
  service = start();
  await service.realtime.notifyAvailable();
  assert.deepEqual(calls, ['sync:0', 'bootstrap'], 'a directory hint must be authorized/refreshed before ACK, not silently consumed');
  assert.equal(store.getSyncState().cursor, 1, 'the event and its durable refresh marker commit atomically');
  service.stop();
  store = open(); service = start(); unavailable = false; calls.length = 0;
  await service.realtime.notifyAvailable();
  assert.deepEqual(calls, ['bootstrap', 'ack:1', 'sync:1', 'ack:1'], 'restart must finish the durable directory refresh before a later page can ACK it');
  assert.equal(service.getDirectory().teams[0].members[0].role, 'admin');
  assert.equal(store.db.get("SELECT count(*) AS n FROM events WHERE type='directory.changed'").n, 0, 'authorized bootstrap consumes the durable marker');
  store.revokeScope({ scopeId: 'team:org' });
  service.syncEngine.applyPage({ fromCursor: 1, toCursor: 2, events: [{ id: 'reenabled', cursor: 2, type: 'directory.changed', payload: { scopeType: 'organization', organizationId: 'org' } }] });
  assert.ok(store.db.get("SELECT 1 FROM revoked_scopes WHERE scope_id='team:org'"), 'a mere reenable hint cannot clear the revocation tombstone');
  calls.length = 0;
  await service.realtime.notifyAvailable();
  assert.deepEqual(calls, ['bootstrap'], 'a stale snapshot cannot ACK or move the cursor backwards');
  assert.equal(store.getSyncState().cursor, 2);
  assert.ok(store.db.get("SELECT 1 FROM revoked_scopes WHERE scope_id='team:org'"));
  snapshot.watermark = 3; snapshot.conversations = [{ id: 'channel', kind: 'channel', scopeId: 'team:org' }];
  historyUnavailable = true; calls.length = 0;
  await service.realtime.notifyAvailable();
  assert.deepEqual(calls, ['bootstrap', 'history'], 'a newer directory snapshot cannot ACK until its history is hydrated');
  assert.equal(store.getSyncState().cursor, 3);
  assert.equal(store.db.get("SELECT count(*) AS n FROM events WHERE type='directory.changed'").n, 0);
  assert.deepEqual(store.listPendingHistoryHydration(), ['channel'], 'bootstrap atomically exchanges directory marker for durable hydration checkpoint');
  service.stop(); store = open(); service = start(); historyUnavailable = false; calls.length = 0;
  await service.realtime.notifyAvailable();
  assert.deepEqual(calls, ['history', 'sync:3', 'ack:3'], 'restart after snapshot replacement finishes history before any page or ACK');
  assert.deepEqual(store.listPendingHistoryHydration(), []);
  console.log('collaboration directory refresh: durable restart at event/snapshot boundaries, stale snapshot refusal, hydration before ACK and no hint regrant passed');
} finally { service?.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
