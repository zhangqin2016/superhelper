#!/usr/bin/env node
// Observability/support contracts are still evidence-gated, but the schema must
// already reject free text, raw content, endpoints, paths, and unredacted support data.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'docs/schemas/mobile-command-observability.schema.json'), 'utf8'));

assert.equal(schema.$id, 'https://lilyworkbench.local/schemas/mobile-command-observability.schema.json');

const ajv = new Ajv({ allErrors: true });
ajv.addSchema(schema);
const validateTelemetry = ajv.compile({ $ref: `${schema.$id}#/definitions/telemetryEnvelope` });
const validateStatus = ajv.compile({ $ref: `${schema.$id}#/definitions/customerStatusAdvisory` });
const validateDiagnostics = ajv.compile({ $ref: `${schema.$id}#/definitions/diagnosticsManifest` });

const DENIED_PROPERTY = /(?:authorization|body|clipboard|content|cookie|errorMessage|fileName|headers|message|objectKey|path|provider|raw|screen|secret|screenshot|signedUrl|stack|summary|text|title|transcript|url|userAgent)/i;

function assertNoDeniedProperties(name, object) {
  const stack = [{ path: name, value: object }];
  while (stack.length) {
    const { path: currentPath, value } = stack.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value.properties || {})) {
      const nextPath = `${currentPath}.${key}`;
      assert.ok(!DENIED_PROPERTY.test(key), `${nextPath} is prohibited in observability/support contracts`);
      stack.push({ path: nextPath, value: child });
    }
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
      for (const child of value[keyword] || []) stack.push({ path: currentPath, value: child });
    }
    if (value.items) stack.push({ path: `${currentPath}[]`, value: value.items });
  }
}

for (const [name, definition] of Object.entries(schema.definitions)) {
  assertNoDeniedProperties(`$defs.${name}`, definition);
}

const goodTelemetry = {
  eventName: 'mobile.push.delivery',
  schemaVersion: 1,
  occurredAt: '2026-07-14T10:00:00Z',
  environment: 'staging',
  region: 'cn_east',
  appPlatform: 'ios',
  appVersion: '1.0.0',
  protocolVersion: 1,
  correlationId: 'corr_abcdef123456',
  resultCode: 'accepted',
  durationBucket: 'lt_1s',
  count: 1,
  platform: 'ios'
};
assert.equal(validateTelemetry(goodTelemetry), true, ajv.errorsText(validateTelemetry.errors));
assert.equal(validateTelemetry({ ...goodTelemetry, message: 'raw provider response' }), false, 'telemetry must reject free-form message');
assert.equal(validateTelemetry({ ...goodTelemetry, url: 'https://example.test/object' }), false, 'telemetry must reject URLs');

const goodStatus = {
  service: 'mobile_command',
  region: 'cn_east',
  capability: 'push',
  phase: 'identified',
  impact: 'degraded',
  fallback: 'chat_only',
  startedAt: '2026-07-14T10:00:00Z',
  updatedAt: '2026-07-14T10:05:00Z',
  resolvedAt: null,
  incidentId: 'inc_abcdef123456'
};
assert.equal(validateStatus(goodStatus), true, ajv.errorsText(validateStatus.errors));
assert.equal(validateStatus({ ...goodStatus, title: 'Push issue' }), false, 'status must reject free-text titles');
assert.equal(validateStatus({ ...goodStatus, impact: 'none' }), false, 'active status with impact=none must be invalid');
assert.equal(validateStatus({ ...goodStatus, fallback: 'none' }), false, 'partial/degraded status must name a safe fallback');
assert.equal(validateStatus({
  ...goodStatus,
  phase: 'resolved',
  impact: 'none',
  fallback: 'none',
  resolvedAt: '2026-07-14T10:10:00Z'
}), true, ajv.errorsText(validateStatus.errors));

const goodDiagnostics = {
  manifestVersion: 1,
  createdAt: '2026-07-14T10:00:00Z',
  expiresAt: '2026-07-15T10:00:00Z',
  appVersion: '1.0.0',
  platform: 'desktop',
  protocolVersion: 1,
  region: 'cn_east',
  configVersion: 'cfg_20260714',
  killSwitchStates: { push: 'disabled', diagnostics: 'disabled' },
  correlationIds: ['corr_abcdef123456'],
  errorCodes: ['MC-ERR-CONFIG-FEATURE-DISABLED'],
  networkCounters: { rttBucket: 'lt_100ms', lossBucket: 'zero', reconnectBucket: 'none' },
  schemaValidation: { passed: true, failureCount: 0 },
  packageIntegrityDigests: ['a'.repeat(64)],
  redactionReport: { redacted: true, droppedFieldCount: 0 }
};
assert.equal(validateDiagnostics(goodDiagnostics), true, ajv.errorsText(validateDiagnostics.errors));
assert.equal(validateDiagnostics({ ...goodDiagnostics, stack: 'Error: raw stack' }), false, 'diagnostics manifest must reject stack traces');
assert.equal(validateDiagnostics({ ...goodDiagnostics, filePath: '/Users/alice/private.pdf' }), false, 'diagnostics manifest must reject local paths');
assert.equal(validateDiagnostics({
  ...goodDiagnostics,
  redactionReport: { redacted: false, droppedFieldCount: 0 }
}), false, 'diagnostics manifest must require explicit redaction');

console.log('mobile-command-observability-contracts: ok');
