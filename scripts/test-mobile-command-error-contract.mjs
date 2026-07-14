#!/usr/bin/env node
// Mobile Command runtime errors must stay aligned with the canonical error
// catalog and OpenAPI enum. This prevents temporary implementation codes from
// leaking into phone-visible contracts.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function extractCodes(text) {
  return new Set(text.match(/MC-ERR-[A-Z0-9-]+/g) || []);
}

const catalogCodes = extractCodes(read('docs/mobile-command-error-recovery-catalog.md'));
const openapi = yaml.load(read('docs/schemas/mobile-command.openapi.yaml'));
const openapiCodes = new Set(openapi?.components?.schemas?.ErrorCode?.enum || []);

assert.ok(catalogCodes.size > 50, 'error catalog must expose canonical MC-ERR codes');
assert.ok(openapiCodes.size > 50, 'OpenAPI ErrorCode enum must expose canonical MC-ERR codes');

for (const code of catalogCodes) {
  assert.ok(openapiCodes.has(code), `${code} is in error catalog but missing from OpenAPI ErrorCode enum`);
}
for (const code of openapiCodes) {
  assert.ok(catalogCodes.has(code), `${code} is in OpenAPI ErrorCode enum but missing from error catalog`);
}

const runtimeFiles = [
  'server/src/services/mobile-command-capabilities.js',
  'server/src/services/mobile-command-file-transfer.js',
  'server/src/services/mobile-command-remote-session.js',
  'server/src/routes/public/mobile-command-surface.js',
  'src/main/mobile-agent-bridge.js',
  'src/main/mobile-attachments.js',
  'src/main/external-command-admission.js',
];

for (const file of runtimeFiles) {
  for (const code of extractCodes(read(file))) {
    assert.ok(catalogCodes.has(code), `${file} emits non-canonical Mobile Command error code ${code}`);
  }
}

console.log('mobile-command-error-contract: ok');
