#!/usr/bin/env node
// Keep the evidence-gated Mobile Command surfaces privacy-minimal by contract.
// Push and diagnostics metadata may be implemented before production providers,
// but they must not grow raw user content, paths, screenshots, or unredacted logs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openapi = yaml.load(fs.readFileSync(path.join(root, 'docs/schemas/mobile-command.openapi.yaml'), 'utf8'));
const events = JSON.parse(fs.readFileSync(path.join(root, 'docs/schemas/mobile-command-events.schema.json'), 'utf8'));
const native = JSON.parse(fs.readFileSync(path.join(root, 'docs/schemas/mobile-command-native-bridge.schema.json'), 'utf8'));

const DENIED_SENSITIVE_PROPERTY = /(?:authorization|body|bytes|clipboard|content|cookie|displayName|fileName|frame|headers|message|originalName|path|prompt|raw|screenshot|screen|secret|text|transcript|uri|url|audio)/i;

function keys(object) {
  return Object.keys(object || {}).sort();
}

function assertExactProperties(name, schema, expected) {
  assert.deepEqual(keys(schema?.properties), [...expected].sort(), `${name} properties must stay privacy-minimal`);
}

function assertRequired(name, schema, expected) {
  assert.deepEqual(keys(Object.fromEntries((schema?.required || []).map((key) => [key, true]))), [...expected].sort(), `${name} required fields drifted`);
}

function assertNoDeniedProperties(name, schema, allowed = new Set()) {
  const stack = [{ path: name, schema }];
  while (stack.length) {
    const current = stack.pop();
    if (!current?.schema || typeof current.schema !== 'object') continue;
    for (const [propertyName, propertySchema] of Object.entries(current.schema.properties || {})) {
      const propertyPath = `${current.path}.${propertyName}`;
      if (!allowed.has(propertyPath) && DENIED_SENSITIVE_PROPERTY.test(propertyName)) {
        throw new Error(`${propertyPath} must not carry sensitive/raw user data`);
      }
      stack.push({ path: propertyPath, schema: propertySchema });
    }
    for (const key of ['oneOf', 'allOf', 'anyOf']) {
      for (const child of current.schema[key] || []) {
        stack.push({ path: current.path, schema: child });
      }
    }
    if (current.schema.items) stack.push({ path: `${current.path}[]`, schema: current.schema.items });
  }
}

const pushRegistration = openapi.components.schemas.PushRegistration;
assertExactProperties('PushRegistration', pushRegistration, ['schemaVersion', 'mobileDeviceId', 'platform', 'pushToken', 'environment']);
assertRequired('PushRegistration', pushRegistration, ['schemaVersion', 'mobileDeviceId', 'platform', 'pushToken']);
assert.equal(pushRegistration.properties.pushToken.type, 'string');
assert.ok(pushRegistration.properties.pushToken.maxLength <= 4096);

const pushReceipt = openapi.components.schemas.PushReceipt;
assertExactProperties('PushReceipt', pushReceipt, ['schemaVersion', 'registered']);
assertRequired('PushReceipt', pushReceipt, ['schemaVersion', 'registered']);
assertNoDeniedProperties('PushReceipt', pushReceipt);

const diagnosticsRequest = openapi.components.schemas.DiagnosticsRequest;
assertExactProperties('DiagnosticsRequest', diagnosticsRequest, ['schemaVersion', 'remoteSessionId', 'consent', 'categories']);
assertRequired('DiagnosticsRequest', diagnosticsRequest, ['schemaVersion', 'remoteSessionId', 'consent', 'categories']);
assert.equal(diagnosticsRequest.properties.consent.const, true, 'diagnostics must require explicit consent');
assert.deepEqual(diagnosticsRequest.properties.categories.items.enum.sort(), ['app', 'lifecycle', 'network', 'signaling', 'upload'].sort());
assertNoDeniedProperties('DiagnosticsRequest', diagnosticsRequest);

const diagnosticsBundle = openapi.components.schemas.DiagnosticsBundle;
assertExactProperties('DiagnosticsBundle', diagnosticsBundle, ['schemaVersion', 'diagnosticId', 'redacted', 'expiresAt']);
assertRequired('DiagnosticsBundle', diagnosticsBundle, ['schemaVersion', 'diagnosticId', 'redacted', 'expiresAt']);
assert.equal(diagnosticsBundle.properties.redacted.const, true, 'diagnostics result must be explicitly redacted');
assertNoDeniedProperties('DiagnosticsBundle', diagnosticsBundle);

const diagnosticsSnapshotPayload = events.$defs.diagnosticsSnapshot.allOf[1].properties.payload;
assertExactProperties('diagnostics.snapshot payload', diagnosticsSnapshotPayload, ['diagnosticId', 'redacted']);
assertRequired('diagnostics.snapshot payload', diagnosticsSnapshotPayload, ['diagnosticId', 'redacted']);
assert.equal(diagnosticsSnapshotPayload.properties.redacted.const, true);
assertNoDeniedProperties('diagnostics.snapshot payload', diagnosticsSnapshotPayload);

const pushOpenedPayload = native.$defs.pushOpenedEvent.allOf[1].properties.payload;
assertExactProperties('native push.opened payload', pushOpenedPayload, ['type', 'remoteSessionId', 'lilySessionId', 'artifactId', 'correlationId']);
assertRequired('native push.opened payload', pushOpenedPayload, ['type', 'correlationId']);
assert.deepEqual(pushOpenedPayload.properties.type.enum.sort(), ['approval_required', 'desktop_offline', 'file_ready', 'remote_control_revoked', 'task_completed'].sort());
assertNoDeniedProperties('native push.opened payload', pushOpenedPayload);

const pushRegisterResult = native.$defs.pushRegisterSuccess.allOf[1].properties.result;
assertExactProperties('native push.register result', pushRegisterResult, ['platform', 'pushToken', 'environment']);
assertRequired('native push.register result', pushRegisterResult, ['platform', 'pushToken']);

console.log('mobile-command-privacy-redlines: ok');
