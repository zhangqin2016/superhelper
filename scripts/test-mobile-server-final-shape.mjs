#!/usr/bin/env node
// Final-shape Mobile Command public HTTP surface. Routes that depend on Phase 2
// evidence must exist but fail safe with typed disabled responses, not 404s or
// accidental success.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.SESSION_SECRET ||= 'test-session-secret-abcdefghijklmnop';
process.env.DATABASE_URL ||= 'postgres://localhost:5432/test';

const {
  DISABLED_CAPABILITIES,
  disabledCapability,
  mobileCapabilitiesPayload,
} = await import('../server/src/services/mobile-command-capabilities.js');
const {
  registerPublicMobileRoutes,
} = await import('../server/src/routes/public/mobile.js');
const {
  registerMobileCommandSurfaceRoutes,
} = await import('../server/src/routes/public/mobile-command-surface.js');

function createFakeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    app[method] = (path, options, handler) => {
      routes.push({ method: method.toUpperCase(), path, options, handler });
    };
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

const { app, routes } = createFakeApp();
registerPublicMobileRoutes(app);

const requiredRoutes = [
  ['GET', '/api/mobile/capabilities'],
  ['POST', '/api/mobile/pairing/challenge'],
  ['POST', '/api/mobile/pairing/consume'],
  ['POST', '/api/mobile/pairing/approve'],
  ['POST', '/api/mobile/pairing/deny'],
  ['POST', '/api/mobile/pairing/revoke'],
  ['POST', '/api/mobile/pairing/pending'],
  ['POST', '/api/mobile/pairing/list'],
  ['POST', '/api/mobile/sessions'],
  ['POST', '/api/mobile/sessions/:remoteSessionId/refresh'],
  ['DELETE', '/api/mobile/sessions/:remoteSessionId'],
  ['POST', '/api/mobile/sessions/:remoteSessionId/permissions'],
  ['POST', '/api/mobile/sessions/:remoteSessionId/turn-credentials'],
  ['POST', '/api/mobile/uploads'],
  ['PUT', '/api/mobile/uploads/:uploadId/chunks/:chunkIndex'],
  ['POST', '/api/mobile/uploads/:uploadId/complete'],
  ['GET', '/api/mobile/uploads/:uploadId'],
  ['GET', '/api/mobile/artifacts/:artifactId'],
  ['POST', '/api/mobile/artifacts/:artifactId/download'],
  ['GET', '/api/mobile/artifacts/:artifactId/content'],
  ['POST', '/api/mobile/push-token'],
  ['DELETE', '/api/mobile/push-token'],
  ['POST', '/api/mobile/diagnostics'],
];

for (const [method, path] of requiredRoutes) {
  assert.ok(
    routes.some((route) => route.method === method && route.path === path),
    `${method} ${path} must be registered`,
  );
}

const disabledExpectations = new Map([
  ['/api/mobile/sessions/:remoteSessionId/permissions', ['observeControl', DISABLED_CAPABILITIES.observeControl.code]],
  ['/api/mobile/sessions/:remoteSessionId/turn-credentials', ['turnCredentials', DISABLED_CAPABILITIES.turnCredentials.code]],
  ['/api/mobile/artifacts/:artifactId/content', ['artifactContent', DISABLED_CAPABILITIES.artifactContent.code]],
  ['/api/mobile/push-token', ['push', DISABLED_CAPABILITIES.push.code]],
  ['/api/mobile/diagnostics', ['diagnostics', DISABLED_CAPABILITIES.diagnostics.code]],
]);

for (const [path, [capability, code]] of disabledExpectations) {
  const route = routes.find((item) => item.path === path);
  const reply = createReply();
  await route.handler({ body: {}, params: {} }, reply);
  assert.equal(reply.statusCode, 501, `${path} must fail safe as not implemented`);
  assert.equal(reply.payload.ok, false);
  assert.equal(reply.payload.capability, capability);
  assert.equal(reply.payload.code, code);
  assert.equal(reply.payload.fallback, 'chat_only');
}

const capabilities = routes.find((item) => item.path === '/api/mobile/capabilities');
const capabilityPayload = await capabilities.handler({ query: {} }, createReply());
assert.equal(capabilityPayload.ok, true);
assert.equal(capabilityPayload.capabilities.pairing.enabled, true);
assert.equal(capabilityPayload.capabilities.relayTextImageCommand.enabled, true);
assert.equal(capabilityPayload.capabilities.uploads.enabled, true);
assert.equal(capabilityPayload.capabilities.artifacts.enabled, true);
assert.equal(capabilityPayload.capabilities.remoteSessions.enabled, true);
assert.equal(capabilityPayload.capabilities.observeControl.enabled, false);
assert.equal(capabilityPayload.capabilities.voice.enabled, false);
assert.equal(capabilityPayload.capabilities.push.enabled, false);
assert.equal(capabilityPayload.capabilities.diagnostics.enabled, false);

assert.deepEqual(disabledCapability('voice'), {
  ok: false,
  code: DISABLED_CAPABILITIES.voice.code,
  capability: 'voice',
  enabled: false,
  fallback: 'chat_only',
  reason: DISABLED_CAPABILITIES.voice.reason,
});

const directPayload = mobileCapabilitiesPayload();
assert.equal(directPayload.ok, true);
assert.equal(directPayload.fallback, 'chat_only');
assert.equal(directPayload.capabilities.remoteSessions.enabled, true);
assert.equal(directPayload.capabilities.uploads.enabled, true);
assert.equal(directPayload.capabilities.artifacts.enabled, true);

const surfaceOnly = createFakeApp();
registerMobileCommandSurfaceRoutes(surfaceOnly.app);
assert.deepEqual(
  surfaceOnly.routes.map((route) => `${route.method} ${route.path}`).sort(),
  requiredRoutes.filter(([, path]) => !path.startsWith('/api/mobile/pairing/')).map(([method, path]) => `${method} ${path}`).sort(),
  'surface module owns only the non-pairing final-shape routes',
);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const routeMap = new Map(routes.map((route) => [`${route.method} ${route.path}`, route]));
const sessionReply = createReply();
await routeMap.get('POST /api/mobile/sessions').handler({
  body: {
    deviceId: 'mob_test',
    grantId: 'grant_test',
    lilySessionId: 'sess_test',
    clientProtocolVersion: 1,
  },
}, sessionReply);
assert.equal(sessionReply.statusCode, 200);
assert.equal(sessionReply.payload.ok, true);
assert.equal(sessionReply.payload.remoteSession.status, 'active');
assert.equal(sessionReply.payload.remoteSession.permissionLevel, 'chat');
const remoteSessionId = sessionReply.payload.remoteSession.remoteSessionId;

const refreshReply = createReply();
await routeMap.get('POST /api/mobile/sessions/:remoteSessionId/refresh').handler({
  params: { remoteSessionId },
  body: { deviceId: 'mob_test' },
}, refreshReply);
assert.equal(refreshReply.statusCode, 200);
assert.equal(refreshReply.payload.ok, true);
assert.equal(refreshReply.payload.remoteSession.remoteSessionId, remoteSessionId);

const endReply = createReply();
await routeMap.get('DELETE /api/mobile/sessions/:remoteSessionId').handler({
  params: { remoteSessionId },
  body: { deviceId: 'mob_test' },
}, endReply);
assert.equal(endReply.statusCode, 200);
assert.equal(endReply.payload.ok, true);
assert.equal(endReply.payload.remoteSession.status, 'ended');

const file = Buffer.from('http route upload');
const createdReply = createReply();
await routeMap.get('POST /api/mobile/uploads').handler({
  body: {
    deviceId: 'mob_test',
    grantId: 'grant_test',
    lilySessionId: 'sess_test',
    fileName: 'route.txt',
    sizeBytes: file.length,
    sha256: sha256(file),
    chunkCount: 1,
    idempotencyKey: 'idem_route_1',
  },
}, createdReply);
assert.equal(createdReply.statusCode, 200);
assert.equal(createdReply.payload.ok, true);
const uploadId = createdReply.payload.upload.uploadId;

const chunkReply = createReply();
await routeMap.get('PUT /api/mobile/uploads/:uploadId/chunks/:chunkIndex').handler({
  params: { uploadId, chunkIndex: '0' },
  body: { deviceId: 'mob_test', bytesBase64: file.toString('base64'), sha256: sha256(file) },
}, chunkReply);
assert.equal(chunkReply.payload.ok, true);
assert.deepEqual(chunkReply.payload.upload.uploadedChunks, [0]);

const completeReply = createReply();
await routeMap.get('POST /api/mobile/uploads/:uploadId/complete').handler({
  params: { uploadId },
  body: { deviceId: 'mob_test', sha256: sha256(file) },
}, completeReply);
assert.equal(completeReply.payload.ok, true);
assert.equal(completeReply.payload.artifact.name, 'route.txt');
const artifactId = completeReply.payload.artifact.artifactId;

const artifactReply = createReply();
await routeMap.get('GET /api/mobile/artifacts/:artifactId').handler({ params: { artifactId } }, artifactReply);
assert.equal(artifactReply.payload.ok, true);
assert.equal(artifactReply.payload.artifact.artifactId, artifactId);

const downloadReply = createReply();
await routeMap.get('POST /api/mobile/artifacts/:artifactId/download').handler({ params: { artifactId }, body: { deviceId: 'mob_test' } }, downloadReply);
assert.equal(downloadReply.payload.ok, true);
assert.match(downloadReply.payload.downloadUrl, /^mobile-artifact:\/\/mca_/);

console.log('mobile-server-final-shape: ok');
