#!/usr/bin/env node
// Mobile Command kill switches must fail closed at the consuming boundary while
// preserving the chat-only/local Lily fallback contract.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.SESSION_SECRET ||= 'test-session-secret-abcdefghijklmnop';
process.env.DATABASE_URL ||= 'postgres://localhost:5432/test';

const {
  mobileCapabilitiesPayload,
} = await import('../server/src/services/mobile-command-capabilities.js');
const {
  registerMobileCommandSurfaceRoutes,
} = await import('../server/src/routes/public/mobile-command-surface.js');

function createFakeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    app[method] = (path, options, handler) => routes.push({ method: method.toUpperCase(), path, handler });
  }
  return { app, routes };
}

function createReply() {
  return {
    statusCode: 200,
    payload: undefined,
    code(status) {
      this.statusCode = status;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return payload;
    },
  };
}

function routeMap(routes) {
  return new Map(routes.map((route) => [`${route.method} ${route.path}`, route]));
}

const disabledPayload = mobileCapabilitiesPayload({ flags: { mobileCommandEnabled: false } });
assert.equal(disabledPayload.ok, true);
for (const name of ['pairing', 'relayTextImageCommand', 'projection', 'interrupt', 'history', 'uploads', 'artifacts', 'remoteSessions']) {
  assert.equal(disabledPayload.capabilities[name].enabled, false, `${name} must be disabled by global kill switch`);
  assert.equal(disabledPayload.capabilities[name].code, 'MC-ERR-CONFIG-FEATURE-DISABLED');
}
assert.equal(disabledPayload.fallback, 'chat_only');

const globalOff = createFakeApp();
registerMobileCommandSurfaceRoutes(globalOff.app, { capabilityFlags: { mobileCommandEnabled: false } });
const globalRoutes = routeMap(globalOff.routes);

const sessionReply = createReply();
await globalRoutes.get('POST /api/mobile/sessions').handler({
  body: { deviceId: 'mob_test', grantId: 'grant_test', lilySessionId: 'sess_test', clientProtocolVersion: 1 },
}, sessionReply);
assert.equal(sessionReply.statusCode, 403);
assert.equal(sessionReply.payload.ok, false);
assert.equal(sessionReply.payload.code, 'MC-ERR-CONFIG-FEATURE-DISABLED');
assert.equal(sessionReply.payload.fallback, 'chat_only');

const uploadOff = createFakeApp();
registerMobileCommandSurfaceRoutes(uploadOff.app, { capabilityFlags: { uploadsEnabled: false } });
const uploadRoutes = routeMap(uploadOff.routes);
const file = Buffer.from('upload blocked');
const uploadReply = createReply();
await uploadRoutes.get('POST /api/mobile/uploads').handler({
  body: {
    deviceId: 'mob_test',
    grantId: 'grant_test',
    lilySessionId: 'sess_test',
    fileName: 'blocked.txt',
    sizeBytes: file.length,
    sha256: createHash('sha256').update(file).digest('hex'),
    chunkCount: 1,
  },
}, uploadReply);
assert.equal(uploadReply.statusCode, 403);
assert.equal(uploadReply.payload.ok, false);
assert.equal(uploadReply.payload.capability, 'uploads');
assert.equal(uploadReply.payload.code, 'MC-ERR-CONFIG-FEATURE-DISABLED');

console.log('mobile-command-kill-switch: ok');
