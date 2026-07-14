import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fixtures') args.fixtures = argv[++i];
    else if (arg === '--manifest') args.manifest = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/test-mobile-command-spec-closure.mjs --fixtures docs/fixtures/mobile-command-test-fixtures.json --manifest docs/mobile-command-test-cases.md',
  ].join('\n');
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
  return sorted;
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(sortKeys(value)), 'utf8');
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function extractManifestRows(markdown) {
  const rows = [];
  const rowPattern = /^\|\s*(MC-TC-[A-Z]+-\d{3})\s*\|\s*`#\/cases\/(\d+)`\s*\|\s*(\d+)\s*\|\s*`([a-f0-9]{64})`\s*\|$/gm;
  let match;
  while ((match = rowPattern.exec(markdown))) {
    rows.push({
      caseId: match[1],
      index: Number(match[2]),
      bytes: Number(match[3]),
      hash: match[4],
    });
  }
  return rows;
}

function extractReferencedCaseIds(markdown) {
  return new Set(markdown.match(/MC-TC-[A-Z]+-\d{3}/g) || []);
}

function assertUnique(rows, field) {
  const seen = new Map();
  for (const row of rows) {
    const value = row[field];
    assert.equal(seen.has(value), false, `duplicate manifest ${field}: ${value}`);
    seen.set(value, row.caseId);
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

args.fixtures ||= 'docs/fixtures/mobile-command-test-fixtures.json';
args.manifest ||= 'docs/mobile-command-test-cases.md';

assert.ok(args.fixtures, `missing --fixtures\n${usage()}`);
assert.ok(args.manifest, `missing --manifest\n${usage()}`);

const fixturePath = path.resolve(root, args.fixtures);
const manifestPath = path.resolve(root, args.manifest);
const [fixtureText, manifestText] = await Promise.all([
  readFile(fixturePath, 'utf8'),
  readFile(manifestPath, 'utf8'),
]);

const fixtures = JSON.parse(fixtureText);
assert.equal(fixtures.fixtureVersion, 1, 'fixtureVersion must be 1');
assert.equal(fixtures.canonicalization, 'recursive-key-sort-json-stringify-utf8');
assert.equal(fixtures.syntheticOnly, true, 'fixture file must be synthetic-only');
assert.ok(Array.isArray(fixtures.cases), 'fixtures.cases must be an array');

const rows = extractManifestRows(manifestText);
assert.equal(rows.length, 62, 'manifest must contain exactly 62 executable fixture rows');
assert.equal(fixtures.cases.length, 62, 'fixture file must contain exactly 62 cases');
assertUnique(rows, 'caseId');
assertUnique(rows, 'index');

const referencedCaseIds = extractReferencedCaseIds(manifestText);
const fixtureCaseIds = new Set(fixtures.cases.map((item) => item.caseId));
const rowCaseIds = new Set(rows.map((item) => item.caseId));
assert.equal(referencedCaseIds.size, 62, 'manifest must reference exactly 62 unique MC-TC IDs');

for (const caseId of referencedCaseIds) {
  assert.ok(rowCaseIds.has(caseId), `missing executable fixture manifest row for ${caseId}`);
  assert.ok(fixtureCaseIds.has(caseId), `missing fixture case for ${caseId}`);
}

for (const row of rows) {
  const item = fixtures.cases[row.index];
  assert.ok(item, `manifest pointer #/cases/${row.index} is out of range`);
  assert.equal(item.caseId, row.caseId, `caseId mismatch at #/cases/${row.index}`);
  const bytes = canonicalBytes(item);
  assert.equal(bytes.length, row.bytes, `${row.caseId} canonical byte length changed`);
  assert.equal(sha256(bytes), row.hash, `${row.caseId} canonical SHA-256 changed`);
  assert.equal(item.preState?.accountId, 'usr_test', `${row.caseId} must use synthetic account ID`);
  assert.equal(item.preState?.desktopDeviceId, 'desk_test', `${row.caseId} must use synthetic desktop ID`);
  assert.equal(item.preState?.mobileDeviceId, 'mob_test', `${row.caseId} must use synthetic mobile ID`);
  assert.equal(item.preState?.remoteSessionId, 'rs_test', `${row.caseId} must use synthetic remote session ID`);
  assert.equal(item.preState?.lilySessionId, 'sess_test', `${row.caseId} must use synthetic Lily session ID`);
}

console.log(`mobile-command-spec-closure: ok (${rows.length} cases)`);
