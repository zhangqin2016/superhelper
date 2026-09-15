#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const modulePath = '../src/main/store/database-recovery';
let api = {};
try { api = require(modulePath); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-recovery-'));
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
function file(name) { const dir = path.join(root, name); fs.mkdirSync(dir); return path.join(dir, 'messages.db'); }
function seed(dbPath, count = 2) {
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE messages(session_id TEXT, seq INTEGER, id TEXT, role TEXT, envelope_blob BLOB)');
  for (let i = 0; i < count; i++) db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run('session', i, `m${i}`, 'user', Buffer.from('history'));
  db.close();
}
test('preflight distinguishes new install, corrupt existing files and recovery evidence', () => {
  assert.equal(typeof api.inspectDatabase, 'function', 'preflight API must exist');
  const p = file('preflight');
  assert.deepEqual(api.inspectDatabase(p), { ok: true, exists: false, reason: 'new_install' });
  fs.writeFileSync(p, '');
  assert.equal(api.inspectDatabase(p).reason, 'corrupt');
  assert.equal(fs.statSync(p).size, 0);
  fs.unlinkSync(p); fs.writeFileSync(p + '-wal', 'orphan');
  assert.equal(api.inspectDatabase(p).reason, 'missing_with_evidence');
  assert.equal(fs.existsSync(p), false);
});
test('valid interrupted compaction is restored without deleting its evidence', () => {
  const p = file('compaction'); seed(p + '.precompact');
  assert.equal(api.inspectDatabase(p).messageCount, 2);
  assert.ok(fs.existsSync(p + '.precompact'));
});
test('verified snapshots include live WAL commits and retain only four automatic backups', () => {
  const p = file('backups'); seed(p);
  const db = new DatabaseSync(p);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO messages VALUES('late',9,'late','user',X'01')");
    for (let i = 0; i < 6; i++) assert.equal(api.createRecoveryBackup(p).ok, true);
    const result = api.prepareRecovery(p);
    assert.equal(result.candidates.length, 4);
    assert.ok(result.candidates.every(c => c.messageCount === 3 && c.sessionCount === 2 && c.sourceKind === 'auto_backup'));
    assert.equal(new Set(result.candidates.map(c => c.id)).size, 4);
  } finally { db.close(); }
});
test('prepare excludes zero, corrupted, replaced and symlink candidates without changing primary', () => {
  const p = file('invalid'); seed(p);
  const { candidate } = api.createRecoveryBackup(p);
  fs.writeFileSync(path.join(p + '.backups', candidate.id + '.db'), '');
  fs.writeFileSync(p, 'original corrupt history');
  assert.equal(api.prepareRecovery(p).candidates.length, 0);
  assert.equal(api.restoreRecoveryCandidate(p, candidate.id).ok, false);
  assert.equal(api.restoreRecoveryCandidate(p, '../messages').reason, 'invalid_candidate');
  assert.equal(fs.readFileSync(p, 'utf8'), 'original corrupt history');
});
test('cancel leaves bytes intact; explicit restore preserves originals and durable replay suppression receipt', () => {
  const p = file('restore'); seed(p);
  const { candidate } = api.createRecoveryBackup(p);
  fs.writeFileSync(p, 'corrupt original');
  fs.writeFileSync(p + '-wal', 'original WAL');
  fs.writeFileSync(p + '-shm', 'original SHM');
  fs.writeFileSync(p + '-journal', 'original journal');
  const prepared = api.prepareRecovery(p); // Cancellation: do not invoke restore.
  assert.equal(prepared.candidates[0].id, candidate.id);
  assert.equal(fs.readFileSync(p, 'utf8'), 'corrupt original');
  const restored = api.restoreRecoveryCandidate(p, candidate.id);
  assert.equal(restored.ok, true);
  assert.equal(api.inspectDatabase(p).messageCount, 2);
  const evidence = path.join(p + '.recovery', restored.receipt.id);
  assert.equal(fs.readFileSync(path.join(evidence, 'original.db'), 'utf8'), 'corrupt original');
  for (const suffix of ['-wal', '-shm', '-journal']) assert.ok(fs.existsSync(path.join(evidence, 'original.db' + suffix)));
  assert.equal(api.getRecoveryReceipt(p).id, restored.receipt.id);
  assert.equal(api.acknowledgeRecoveryReceipt(p, 'wrong').ok, false);
  assert.equal(api.acknowledgeRecoveryReceipt(p, restored.receipt.id).ok, true);
  assert.equal(api.getRecoveryReceipt(p), null);
});
test('every filesystem interruption preserves evidence and resumes only the authorized candidate', () => {
  for (const boundary of ['intent', 'move', 'publish', 'receipt']) {
    const p = file('crash-' + boundary); seed(p);
    const { candidate } = api.createRecoveryBackup(p);
    fs.writeFileSync(p, 'preserved crash evidence');
    const original = boundary === 'move' ? fs.unlinkSync : fs.linkSync;
    const method = boundary === 'move' ? 'unlinkSync' : 'linkSync';
    let failed = false;
    fs[method] = (...args) => {
      const target = String(boundary === 'move' ? args[0] : args[1]);
      const match = boundary === 'intent' ? target.endsWith('.recovery-intent.json')
        : boundary === 'move' ? target === p
          : boundary === 'publish' ? target === p : target.endsWith('.recovery-receipt.json');
      if (!failed && match) { failed = true; throw Object.assign(new Error('injected I/O boundary'), { code: 'EIO' }); }
      return original(...args);
    };
    let result;
    try { result = api.restoreRecoveryCandidate(p, candidate.id); }
    finally { fs[method] = original; }
    assert.equal(failed, true, boundary);
    assert.equal(result.ok, false, boundary);
    if (boundary === 'intent') assert.equal(fs.readFileSync(p, 'utf8'), 'preserved crash evidence');
    else {
      assert.equal(api.inspectDatabase(p).ok, true, boundary);
      assert.equal(api.inspectDatabase(p).messageCount, 2, boundary);
      assert.ok(api.getRecoveryReceipt(p), boundary);
    }
  }
});
test('exclusive SQLite lock is reported within bounded time', () => {
  const p = file('locked'); seed(p);
  const db = new DatabaseSync(p);
  try {
    db.exec('BEGIN EXCLUSIVE');
    const started = Date.now();
    assert.equal(api.inspectDatabase(p).reason, 'locked');
    assert.ok(Date.now() - started < 2500);
  } finally { db.exec('ROLLBACK'); db.close(); }
});
test('a missing primary with old snapshots never becomes a new install', () => {
  const p = file('missing-backups'); seed(p); api.createRecoveryBackup(p); fs.unlinkSync(p);
  assert.equal(api.inspectDatabase(p).reason, 'missing_with_evidence');
  assert.equal(fs.existsSync(p), false);
});
test('stale IDs reject replacement with a different valid message database', () => {
  const p = file('stale'); seed(p); const { candidate } = api.createRecoveryBackup(p);
  const replacement = file('replacement'); seed(replacement, 5);
  fs.copyFileSync(replacement, path.join(p + '.backups', candidate.id + '.db'));
  assert.equal(api.restoreRecoveryCandidate(p, candidate.id).reason, 'invalid_candidate');
  assert.equal(api.inspectDatabase(p).messageCount, 2);
});
test('snapshot publication collisions retain previous backup and original', () => {
  const p = file('collision'); seed(p); const first = api.createRecoveryBackup(p);
  const original = fs.linkSync;
  fs.linkSync = (...args) => {
    if (String(args[1]).includes('/backup-')) throw Object.assign(new Error('occupied'), { code: 'EEXIST' });
    return original(...args);
  };
  try { assert.equal(api.createRecoveryBackup(p).ok, false); }
  finally { fs.linkSync = original; }
  assert.equal(api.prepareRecovery(p).candidates[0].id, first.candidate.id);
  assert.equal(api.inspectDatabase(p).messageCount, 2);
});
test('permission, I/O and unrecognized failures stay distinct from corruption', () => {
  const p = file('errors'); seed(p);
  const original = fs.lstatSync;
  for (const [code, reason] of [['EACCES', 'permission'], ['EIO', 'io'], ['WHAT', 'unknown']]) {
    let injected = false;
    fs.lstatSync = (...args) => {
      if (!injected && args[0] === p) { injected = true; throw Object.assign(new Error('injected'), { code }); }
      return original(...args);
    };
    try { assert.equal(api.inspectDatabase(p).reason, reason); }
    finally { fs.lstatSync = original; }
  }
});
test('persistent access denial retains its category even when existence cannot be read', () => {
  const p=file('persistent-access');seed(p);
  const stat=fs.lstatSync;
  fs.lstatSync=(...args)=>{if(args[0]===p)throw Object.assign(Error('access denied'),{code:'EACCES'});return stat(...args);};
  try {assert.equal(api.inspectDatabase(p).reason,'permission');} finally {fs.lstatSync=stat;}
});
test('an occupied healthy database cannot be replaced with an older snapshot', () => {
  const p=file('restore-locked');seed(p);
  const candidate=api.createRecoveryBackup(p).candidate;
  const db=new DatabaseSync(p);
  db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
  const bytes=fs.readFileSync(p);
  try {
    assert.equal(api.restoreRecoveryCandidate(p,candidate.id).reason,'locked');
    assert.deepEqual(fs.readFileSync(p),bytes);
    assert.equal(fs.existsSync(p+'.recovery-intent.json'),false);
  } finally {db.exec('ROLLBACK');db.close();}
});
test('uncertain interrupted restore keeps missing primary blocked and preserves all evidence', () => {
  const p = file('uncertain'); seed(p); const { candidate } = api.createRecoveryBackup(p);
  fs.writeFileSync(p, 'bad original');
  const original = fs.linkSync;
  fs.linkSync = (...args) => { if (args[1] === p) throw Object.assign(new Error('publish failure'), { code: 'EIO' }); return original(...args); };
  try { assert.equal(api.restoreRecoveryCandidate(p, candidate.id).ok, false); }
  finally { fs.linkSync = original; }
  assert.equal(fs.existsSync(p), false);
  const intent = JSON.parse(fs.readFileSync(p + '.recovery-intent.json'));
  const evidence = path.join(p + '.recovery', intent.id);
  fs.writeFileSync(path.join(evidence, 'staged.db'), 'damaged candidate');
  assert.equal(api.inspectDatabase(p).reason, 'recovery_interrupted');
  assert.equal(fs.existsSync(p), false);
  assert.equal(fs.readFileSync(path.join(evidence, 'original.db'), 'utf8'), 'bad original');
});
test('durability failure before intent never moves customer files', () => {
  const p = file('fsync'); seed(p); const { candidate } = api.createRecoveryBackup(p);
  fs.writeFileSync(p, 'original');
  const original = fs.fsyncSync;
  fs.fsyncSync = () => { throw Object.assign(new Error('fsync failed'), { code: 'EIO' }); };
  try { assert.equal(api.restoreRecoveryCandidate(p, candidate.id).ok, false); }
  finally { fs.fsyncSync = original; }
  assert.equal(fs.readFileSync(p, 'utf8'), 'original');
});
test('candidate directory symlinks cannot redirect recovery to arbitrary files', () => {
  const p = file('symlink'); seed(p);
  const other = file('symlink-target'); seed(other);
  const { candidate } = api.createRecoveryBackup(other);
  fs.symlinkSync(other + '.backups', p + '.backups', 'dir');
  assert.equal(api.prepareRecovery(p).candidates.length, 0);
  assert.equal(api.restoreRecoveryCandidate(p, candidate.id).ok, false);
  assert.equal(api.createRecoveryBackup(p).ok, false);
});
test('unrecoverable damaged index is attempted only on an isolated copy and retains original bytes', () => {
  const p = file('readable-copy'); seed(p, 500);
  const db = new DatabaseSync(p);
  db.exec('CREATE INDEX recovery_test_index ON messages(id)');
  const page = db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='recovery_test_index'").get().rootpage;
  const size = Object.values(db.prepare('PRAGMA page_size').get())[0];
  db.close();
  const fd = fs.openSync(p, 'r+');
  try { fs.writeSync(fd, Buffer.from([0]), 0, 1, (page - 1) * size); } finally { fs.closeSync(fd); }
  const original = fs.readFileSync(p);
  assert.equal(api.inspectDatabase(p).reason, 'corrupt');
  const copied = [];
  const originalCopy = fs.copyFileSync;
  fs.copyFileSync = (...args) => { copied.push(args.slice(0, 2)); return originalCopy(...args); };
  let result;
  try { result = api.prepareRecovery(p); } finally { fs.copyFileSync = originalCopy; }
  assert.ok(copied.some(([source, target]) => source === p && target !== p && target.includes('.recovery-read-')));
  assert.equal(result.ok, true);
  assert.equal(result.candidates.length, 0, 'failed rewrite must not be offered as recovered history');
  assert.deepEqual(fs.readFileSync(p), original);
});
test('full integrity detects missing index entries that quick_check overlooks', () => {
  const p = file('index-entries'); seed(p);
  const db = new DatabaseSync(p);
  // Node 24 protects sqlite_schema by default; disable only for this isolated
  // corruption fixture, never for production recovery connections.
  db.enableDefensive?.(false);
  db.exec("CREATE INDEX incomplete ON messages(id); PRAGMA writable_schema=ON; UPDATE sqlite_schema SET sql='CREATE INDEX incomplete ON messages(role)' WHERE name='incomplete'; PRAGMA writable_schema=OFF;");
  db.close();
  const check = new DatabaseSync(p, { readOnly: true });
  try { assert.equal(Object.values(check.prepare('PRAGMA quick_check').get())[0], 'ok'); }
  finally { check.close(); }
  assert.equal(api.inspectDatabase(p).reason, 'corrupt');
});
test('normal writes after restore do not mutate retained staged or original evidence', () => {
  const p = file('immutable-evidence'); seed(p);
  const { candidate } = api.createRecoveryBackup(p); fs.writeFileSync(p, 'original evidence');
  const restored = api.restoreRecoveryCandidate(p, candidate.id);
  const staged = path.join(p + '.recovery', restored.receipt.id, 'staged.db');
  const bytes = fs.readFileSync(staged);
  const db = new DatabaseSync(p); db.exec("INSERT INTO messages VALUES('later',3,'later','user',X'01')"); db.close();
  assert.deepEqual(fs.readFileSync(staged), bytes);
});
test('hot rollback journal recovers automatically after retaining complete original evidence', () => {
  const p = file('hot-journal'); seed(p, 100);
  spawnSync(process.execPath, ['-e', `
    const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA cache_size=5; BEGIN IMMEDIATE; UPDATE messages SET envelope_blob=zeroblob(65536)');
    process.kill(process.pid,'SIGKILL');`, p]);
  assert.ok(fs.statSync(p + '-journal').size > 0);
  const before = fs.readFileSync(p);
  const journal = fs.readFileSync(p + '-journal');
  const status = api.inspectDatabase(p);
  assert.equal(status.ok, true);
  assert.equal(status.messageCount, 100);
  const dir = fs.readdirSync(p + '.recovery').find(name => name.startsWith('rollback-'));
  assert.ok(dir);
  assert.deepEqual(fs.readFileSync(path.join(p + '.recovery', dir, 'original.db')), before);
  assert.deepEqual(fs.readFileSync(path.join(p + '.recovery', dir, 'original.db-journal')), journal);
  const db = new DatabaseSync(p, { readOnly: true });
  try { assert.equal(db.prepare('SELECT length(envelope_blob) AS n FROM messages LIMIT 1').get().n, 7); }
  finally { db.close(); }
  assert.equal(api.getRecoveryReceipt(p), null, 'native transaction rollback is non-lossy and does not suppress normal task recovery');
});
test('historical candidates cannot masquerade as newly captured automatic backups', () => {
  const p = file('candidate-dates'); seed(p, 2);
  const backup = api.createRecoveryBackup(p).candidate;
  seed(p + '.precompact', 1);
  fs.writeFileSync(p, 'corrupt database');
  const candidates = api.prepareRecovery(p).candidates;
  assert.equal(candidates[0].id, backup.id, 'known automatic snapshot ranks above unknown historical cutoff');
  assert.equal(candidates.find(c => c.sourceKind === 'precompact').createdAt, null);
  assert.ok(candidates.find(c => c.sourceKind === 'precompact').preparedAt > 0);
});
test('frequent app restarts do not rotate all healthy automatic backups', () => {
  const p = file('backup-throttle'); seed(p, 1);
  const first = api.createRecoveryBackup(p, { minIntervalMs: 21_600_000 });
  const second = api.createRecoveryBackup(p, { minIntervalMs: 21_600_000 });
  assert.equal(first.ok,true); assert.equal(second.reason,'recent_backup');
  assert.equal(fs.readdirSync(p+'.backups').filter(n=>n.endsWith('.db')).length,1);
});
test('damaged newer backups never consume the retention slots of valid history', () => {
  const p = file('valid-retention'); seed(p, 1);
  const backups = Array.from({length:4},()=>api.createRecoveryBackup(p).candidate);
  for (const candidate of backups.slice(1)) fs.writeFileSync(path.join(p+'.backups',candidate.id+'.db'),'damaged');
  assert.equal(api.createRecoveryBackup(p).ok,true);
  assert.ok(fs.existsSync(path.join(p+'.backups',backups[0].id+'.db')),'old verified snapshot must survive corrupt newer files');
  assert.equal(api.prepareRecovery(p).candidates.length,2);
});
test('partial replacement copy preserves evidence and resumes from the verified stage', () => {
  const p = file('partial-publication'); seed(p, 2);
  const candidate=api.createRecoveryBackup(p).candidate;
  fs.writeFileSync(p,'original corrupted bytes');
  const original=fs.readFileSync(p),copy=fs.copyFileSync;
  fs.copyFileSync=(source,target,...args)=>{
    if(String(target).includes('publication')){fs.writeFileSync(target,'partial');throw Object.assign(Error('disk interrupted'),{code:'EIO'});}
    return copy(source,target,...args);
  };
  let restored;
  try {restored=api.restoreRecoveryCandidate(p,candidate.id);} finally {fs.copyFileSync=copy;}
  assert.equal(restored.ok,false);
  const resumed=api.inspectDatabase(p);
  assert.equal(resumed.ok,true,'retry must ignore retained partial publication and regenerate from valid stage');
  assert.equal(resumed.messageCount,2);
  const dir=path.join(p+'.recovery',resumed.restoreReceipt.id);
  assert.deepEqual(fs.readFileSync(path.join(dir,'original.db')),original);
  assert.ok(fs.readdirSync(dir).some(name=>name.includes('publication')&&fs.readFileSync(path.join(dir,name),'utf8')==='partial'));
});
test('torn header with a genuine hot journal uses native rollback before proposing old backups', () => {
  const p=file('torn-header-journal');seed(p,100);
  const killed=spawnSync(process.execPath,['-e',`
    const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA cache_size=5; BEGIN IMMEDIATE; UPDATE messages SET envelope_blob=zeroblob(65536)');
    process.kill(process.pid,'SIGKILL');`,p]);
  assert.equal(killed.signal,'SIGKILL');
  const fd=fs.openSync(p,'r+');fs.writeSync(fd,Buffer.alloc(16),0,16,0);fs.closeSync(fd);
  const bytes=fs.readFileSync(p),journal=fs.readFileSync(p+'-journal');
  const result=api.inspectDatabase(p);
  assert.equal(result.ok,true);assert.equal(result.messageCount,100);
  assert.equal(api.getRecoveryReceipt(p),null,'nonlossy journal recovery must not pause healthy tasks');
  const dir=path.join(p+'.recovery',fs.readdirSync(p+'.recovery').find(name=>name.startsWith('rollback-')));
  assert.deepEqual(fs.readFileSync(path.join(dir,'original.db')),bytes);
  assert.deepEqual(fs.readFileSync(path.join(dir,'original.db-journal')),journal);
});
try {
  for (const { name, fn } of cases) { fn(); console.log('PASS', name); }
  console.log(`Database recovery: ${cases.length} passed`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
