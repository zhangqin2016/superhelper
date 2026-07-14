#!/usr/bin/env node
// Mobile Command remote-session v1: a bounded channel descriptor only. It does
// not grant observe/control/TURN authority; those remain separate evidence gates.

import assert from 'node:assert/strict';

const {
  createMobileRemoteSessionService,
} = await import('../server/src/services/mobile-command-remote-session.js');

let now = 10_000;
const service = createMobileRemoteSessionService({ nowMs: () => now });

const created = service.createSession({
  grantId: 'grant_test',
  deviceId: 'mob_test',
  lilySessionId: 'sess_test',
  clientProtocolVersion: 1,
});
assert.equal(created.ok, true);
assert.match(created.remoteSession.remoteSessionId, /^mrs_/);
assert.equal(created.remoteSession.status, 'active');
assert.equal(created.remoteSession.grantId, 'grant_test');
assert.equal(created.remoteSession.lilySessionId, 'sess_test');
assert.equal(created.remoteSession.permissionLevel, 'chat');
assert.equal(created.remoteSession.expiresAt, now + 30 * 60 * 1000);

const status = service.getSession(created.remoteSession.remoteSessionId);
assert.equal(status.ok, true);
assert.equal(status.remoteSession.remoteSessionId, created.remoteSession.remoteSessionId);

now += 60_000;
const refreshed = service.refreshSession({
  remoteSessionId: created.remoteSession.remoteSessionId,
  deviceId: 'mob_test',
});
assert.equal(refreshed.ok, true);
assert.equal(refreshed.remoteSession.expiresAt, now + 30 * 60 * 1000);

const wrongDevice = service.refreshSession({
  remoteSessionId: created.remoteSession.remoteSessionId,
  deviceId: 'other_device',
});
assert.equal(wrongDevice.ok, false);
assert.equal(wrongDevice.code, 'MC-ERR-PERMISSION-DENIED');

const ended = service.endSession({
  remoteSessionId: created.remoteSession.remoteSessionId,
  deviceId: 'mob_test',
});
assert.equal(ended.ok, true);
assert.equal(ended.remoteSession.status, 'ended');

const refreshEnded = service.refreshSession({
  remoteSessionId: created.remoteSession.remoteSessionId,
  deviceId: 'mob_test',
});
assert.equal(refreshEnded.ok, false);
assert.equal(refreshEnded.code, 'MC-ERR-SESSION-ENDED');

const unsupported = service.createSession({
  grantId: 'grant_test',
  deviceId: 'mob_test',
  lilySessionId: 'sess_test',
  clientProtocolVersion: 2,
});
assert.equal(unsupported.ok, false);
assert.equal(unsupported.code, 'MC-ERR-PROTOCOL-CLIENT-UPGRADE-REQUIRED');

console.log('mobile-remote-session: ok');
