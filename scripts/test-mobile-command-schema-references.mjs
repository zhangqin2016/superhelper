#!/usr/bin/env node
// The API completeness matrix claims exact machine-readable references. Keep
// OpenAPI, event schema, native schema, and the matrix locked together.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const matrixText = fs.readFileSync(path.join(root, 'docs/mobile-command-api-completeness-matrix.md'), 'utf8');
const openapi = yaml.load(fs.readFileSync(path.join(root, 'docs/schemas/mobile-command.openapi.yaml'), 'utf8'));
const events = JSON.parse(fs.readFileSync(path.join(root, 'docs/schemas/mobile-command-events.schema.json'), 'utf8'));
const native = JSON.parse(fs.readFileSync(path.join(root, 'docs/schemas/mobile-command-native-bridge.schema.json'), 'utf8'));

assert.equal(openapi.openapi, '3.1.0', 'Mobile Command OpenAPI version must parse');
assert.equal(events.$id, 'https://lilyworkbench.local/schemas/mobile-command-events.schema.json');
assert.equal(native.$id, 'https://lilyworkbench.local/schemas/mobile-command-native-bridge.schema.json');

function targetFor(line, refIndex, absoluteSchema) {
  if (absoluteSchema === 'mobile-command-native-bridge') return native.$defs;
  if (absoluteSchema === 'mobile-command-events') return events.$defs;
  const rowLabel = String(line.split('|')[1] || '').trim();
  if (/^(Native|Background upload|Mobile lifecycle)\b/i.test(rowLabel)) return native.$defs;
  const before = line.slice(0, refIndex).toLowerCase();
  const nativeAt = before.lastIndexOf('native');
  const eventAt = before.lastIndexOf('event');
  if (nativeAt > eventAt) return native.$defs;
  return events.$defs;
}

function assertRefExists(line, ref, refIndex) {
  const match = ref.match(/(?:(https:\/\/lilyworkbench\.local\/schemas\/(mobile-command-events|mobile-command-native-bridge)\.schema\.json))?(#\/(components\/schemas|\$defs)\/([A-Za-z0-9_-]+))/);
  if (!match) return false;
  const [, , absoluteSchema, , kind, name] = match;
  const target = kind === 'components/schemas'
    ? openapi.components?.schemas
    : targetFor(line, refIndex, absoluteSchema);
  assert.ok(target?.[name], `matrix reference ${ref} must resolve (${name})`);
  return true;
}

let checkedRefs = 0;
for (const line of matrixText.split('\n')) {
  if (!line.startsWith('|') || !line.includes('#/')) continue;
  const inlineRefs = line.matchAll(/(?:https:\/\/lilyworkbench\.local\/schemas\/(?:mobile-command-events|mobile-command-native-bridge)\.schema\.json)?#\/(?:components\/schemas|\$defs)\/[A-Za-z0-9_-]+/g);
  for (const match of inlineRefs) {
    const ref = match[0];
    if (assertRefExists(line, ref, match.index || 0)) checkedRefs += 1;
  }
}
assert.ok(checkedRefs >= 60, `expected many matrix refs to be checked, got ${checkedRefs}`);

const serverPrefix = String(openapi.servers?.[0]?.url || '').replace(/\/$/, '');
const openapiOperations = new Set();
for (const [pathName, methods] of Object.entries(openapi.paths || {})) {
  for (const method of Object.keys(methods || {})) {
    openapiOperations.add(`${method.toUpperCase()} ${serverPrefix}${pathName}`);
  }
}

const matrixHttpOperations = new Set();
for (const match of matrixText.matchAll(/`(GET|POST|PUT|DELETE) (\/public\/mobile\/[^` ;]+)`/g)) {
  matrixHttpOperations.add(`${match[1]} ${match[2]}`);
}
for (const op of matrixHttpOperations) {
  assert.ok(openapiOperations.has(op), `matrix HTTP operation ${op} must exist in OpenAPI`);
}
assert.ok(matrixHttpOperations.size >= 10, 'matrix must expose the Mobile Command HTTP operation inventory');

console.log(`mobile-command-schema-references: ok (${checkedRefs} refs, ${matrixHttpOperations.size} HTTP ops)`);
