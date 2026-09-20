#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-db-safety-'));
const originalAppData = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
// Discovery must scan fixture roots, never the developer's installed profiles.
process.env.APPDATA = root;
process.env.LOCALAPPDATA = root;
const ep = require.resolve('electron');
require.cache[ep] = { id: ep, filename: ep, loaded: true, exports: { app: { getPath: () => root } } };
const { migrateLegacyUserDataRoot } = require('../src/main/data-migration');
const { MessageStore } = require('../src/main/store/message-store');
const { sessionStoreCheck } = require('../src/main/support-diagnostics-deep-checks');
const oldEnv = process.env.LILY_USER_DATA_DIR;
const cases = [];
function test(name, run) { cases.push({ name, run }); }
function fixture(name) {
  const base = path.join(root, name);
  const legacy = path.join(base, 'Lily Workbench');
  const current = path.join(base, 'lily-workbench');
  fs.mkdirSync(legacy, { recursive: true });
  process.env.LILY_USER_DATA_DIR = current;
  return { legacy, current, source: path.join(legacy, 'messages.db'), target: path.join(current, 'messages.db') };
}
function seed(file) {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE evidence(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO evidence VALUES(1,'checkpointed');");
  db.close();
}
function rows(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT * FROM evidence ORDER BY id').all().map(r => ({ ...r })); }
  finally { db.close(); }
}

test('migration preserves committed WAL after process termination', () => {
  const f = fixture('wal'); seed(f.source);
  const child = spawnSync(process.execPath, ['-e', `
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO evidence VALUES(2,'wal-only');");
    process.kill(process.pid, 'SIGKILL');`, f.source]);
  assert.notEqual(child.status, 0);
  assert.ok(fs.statSync(f.source + '-wal').size > 0);
  migrateLegacyUserDataRoot();
  assert.deepEqual(rows(f.target), [{ id: 1, body: 'checkpointed' }, { id: 2, body: 'wal-only' }]);
});

test('failed snapshot retains source and does not publish a broken destination', () => {
  const f = fixture('corrupt'); fs.writeFileSync(f.source, 'not sqlite');
  assert.doesNotThrow(() => migrateLegacyUserDataRoot());
  assert.equal(fs.existsSync(f.target), false);
  assert.equal(fs.readFileSync(f.source, 'utf8'), 'not sqlite');
  assert.equal(fs.existsSync(f.legacy + '.migrated-backup'), false);
  fs.unlinkSync(f.source); seed(f.source);
  migrateLegacyUserDataRoot();
  assert.equal(rows(f.target).length, 1, 'a later startup can retry');
});

test('existing broken destination is preserved and failed merge does not archive source', () => {
  const f = fixture('existing'); seed(f.source);
  fs.mkdirSync(f.current); fs.writeFileSync(f.target, 'customer evidence');
  migrateLegacyUserDataRoot();
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'customer evidence');
  assert.equal(fs.existsSync(f.source), true);
});

test('opening after interrupted compaction restores history instead of creating an empty store', () => {
  const f = fixture('interrupted');
  let store = new MessageStore(f.source, path.join(f.legacy, 'blobs'));
  store.append('s', { id: 'm', role: 'user', content: 'must survive' }); store.close();
  fs.renameSync(f.source, f.source + '.precompact');
  store = new MessageStore(f.source, path.join(f.legacy, 'blobs'));
  try { assert.equal(store.getAll('s')[0]?.content, 'must survive'); }
  finally { store.close(); }
  assert.ok(fs.existsSync(f.source + '.precompact'), 'keep recovery evidence');
});

test('invalid compaction backup cannot silently become a new empty store', () => {
  const f = fixture('bad-backup'); fs.writeFileSync(f.source + '.precompact', 'bad backup');
  assert.throws(() => new MessageStore(f.source, path.join(f.legacy, 'blobs')));
  assert.equal(fs.existsSync(f.source), false);
  assert.equal(fs.readFileSync(f.source + '.precompact', 'utf8'), 'bad backup');
});

test('zero-byte or unrelated valid SQLite backup is not a recoverable message store', () => {
  for (const type of ['empty', 'unrelated']) {
    const f = fixture(type);
    if (type === 'empty') fs.writeFileSync(f.source + '.precompact', '');
    else seed(f.source + '.precompact');
    assert.throws(() => new MessageStore(f.source, path.join(f.legacy, 'blobs')));
    assert.equal(fs.existsSync(f.source), false);
    assert.equal(fs.existsSync(f.source + '.precompact'), true);
  }
});

function seedMessages(file, id, content) {
  const store = new MessageStore(file, path.join(path.dirname(file), 'blobs'));
  store.append('s', { id, role: 'user', content }); store.close();
}

test('live legacy writer retains its path and later commits merge once on retry', () => {
  const f = fixture('live-writer');
  const writer = new MessageStore(f.source, path.join(f.legacy, 'blobs'));
  try {
    writer.db.exec('PRAGMA wal_autocheckpoint=0');
    writer.append('s', { id: 'first', role: 'user', content: 'first commit' });
    const sourceBefore = fs.readFileSync(f.source);
    const walBefore = fs.readFileSync(f.source + '-wal');
    migrateLegacyUserDataRoot();
    assert.equal(fs.existsSync(f.source), true, 'do not rename an active database owner');
    assert.deepEqual(fs.readFileSync(f.source), sourceBefore);
    assert.deepEqual(fs.readFileSync(f.source + '-wal'), walBefore);
    writer.append('s', { id: 'late', role: 'user', content: 'late commit' });
    migrateLegacyUserDataRoot();
    migrateLegacyUserDataRoot();
    const target = new MessageStore(f.target, path.join(f.current, 'blobs'));
    try { assert.deepEqual(target.getAll('s').map(m => m.content), ['first commit', 'late commit']); }
    finally { target.close(); }
  } finally { writer.close(); }
});

test('migration restores the current compaction backup before merging legacy history', () => {
  const f = fixture('current-backup');
  seedMessages(f.source, 'legacy', 'old history');
  seedMessages(f.target, 'current', 'new history');
  fs.renameSync(f.target, f.target + '.precompact');
  migrateLegacyUserDataRoot();
  const store = new MessageStore(f.target, path.join(f.current, 'blobs'));
  try { assert.deepEqual(new Set(store.getAll('s').map(m => m.content)), new Set(['new history', 'old history'])); }
  finally { store.close(); }
});

test('migration recovers an interrupted legacy compaction before archiving the root', () => {
  const f = fixture('legacy-backup'); seedMessages(f.source, 'legacy', 'recover me');
  fs.renameSync(f.source, f.source + '.precompact');
  migrateLegacyUserDataRoot();
  const store = new MessageStore(f.target, path.join(f.current, 'blobs'));
  try { assert.equal(store.getAll('s')[0]?.content, 'recover me'); }
  finally { store.close(); }
});

test('snapshot refuses destination collisions and orphan journals without deleting evidence', () => {
  const { createSqliteSnapshot } = require('../src/main/store/sqlite-snapshot');
  const f = fixture('collision'); seed(f.source); fs.mkdirSync(f.current);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.writeFileSync(f.target + suffix, 'keep');
    assert.throws(() => createSqliteSnapshot(f.source, f.target));
    assert.equal(fs.readFileSync(f.target + suffix, 'utf8'), 'keep');
    fs.unlinkSync(f.target + suffix);
  }
  assert.equal(rows(f.source).length, 1);
});

test('orphan recovery journals block empty database creation and remain visible in diagnostics', () => {
  for (const suffix of ['-wal', '-shm', '-journal', '.precompact']) {
    const f = fixture('orphan-' + suffix); fs.writeFileSync(f.source + suffix, 'recovery evidence');
    assert.throws(() => new MessageStore(f.source, path.join(f.legacy, 'blobs')));
    assert.equal(fs.existsSync(f.source), false);
    const result = sessionStoreCheck({ paths: { 'messages.db': f.source } });
    assert.equal(result.status, 'warning');
    assert.match(result.detail, /恢复|备份|日志/);
    assert.equal(fs.readFileSync(f.source + suffix, 'utf8'), 'recovery evidence');
  }
});

test('failed publication leaves original data and permits retry', () => {
  const { createSqliteSnapshot } = require('../src/main/store/sqlite-snapshot');
  const f = fixture('publication'); seed(f.source);
  const original = fs.linkSync;
  try {
    fs.linkSync = () => { throw Object.assign(new Error('injected disk full'), { code: 'ENOSPC' }); };
    assert.throws(() => createSqliteSnapshot(f.source, f.target), /injected disk full/);
  } finally { fs.linkSync = original; }
  assert.equal(fs.existsSync(f.target), false);
  assert.equal(rows(f.source).length, 1);
  assert.deepEqual(fs.readdirSync(f.current), []);
  createSqliteSnapshot(f.source, f.target);
  assert.deepEqual(rows(f.target), rows(f.source));
});

test('diagnostics classify extended SQLite errors without guessing corruption', () => {
  const f = fixture('error-codes'); seed(f.source);
  for (const [errcode, status, expected] of [[5 | 256, 'warning', /占用/], [14, 'warning', /权限/], [13, 'error', /空间不足/], [10 | 256, 'error', /读写失败/], [11 | 256, 'error', /损坏/]]) {
    const result = sessionStoreCheck({ paths: { 'messages.db': f.source }, openSqliteReadOnly() {
      throw Object.assign(new Error('injected SQLite failure'), { errcode });
    } });
    assert.equal(result.status, status); assert.match(result.detail, expected);
  }
});

test('a real exclusive SQLite lock is not diagnosed as corruption', () => {
  const f = fixture('lock'); seed(f.source);
  const writer = new DatabaseSync(f.source);
  try {
    writer.exec('BEGIN EXCLUSIVE');
    const result = sessionStoreCheck({ paths: { 'messages.db': f.source } });
    assert.equal(result.status, 'warning');
    assert.match(result.detail, /占用/);
    assert.doesNotMatch(result.detail, /损坏|删除/);
  } finally { writer.exec('ROLLBACK'); writer.close(); }
  assert.equal(sessionStoreCheck({ paths: { 'messages.db': f.source } }).status, 'ok');
});

test('corrupt file diagnostic protects the original rather than advising deletion', () => {
  const f = fixture('diagnostic'); fs.writeFileSync(f.source, 'broken database');
  const result = sessionStoreCheck({ paths: { 'messages.db': f.source } });
  assert.equal(result.status, 'error');
  assert.match(result.detail, /损坏|格式/);
  assert.doesNotMatch(result.detail, /删除.*重建/);
  assert.equal(fs.readFileSync(f.source, 'utf8'), 'broken database');
});

let failures = 0;
try {
  for (const { name, run } of cases) {
    try { run(); console.log('PASS', name); }
    catch (err) { failures++; console.error('FAIL', name, err.message); }
  }
} finally {
  for (const [key, value] of Object.entries(originalAppData)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (oldEnv === undefined) delete process.env.LILY_USER_DATA_DIR; else process.env.LILY_USER_DATA_DIR = oldEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
assert.equal(failures, 0, `${failures} database safety regression(s)`);
