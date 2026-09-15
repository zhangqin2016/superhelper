"use strict";
const { fs, path, crypto, SIDECARS, exists, regular, directory, digest, sync, publish, publishJson, inspectFile } = require("./database-recovery-files");
const { createSqliteSnapshot } = require("./sqlite-snapshot");
const RESTORE_ID = /^restore-[a-f0-9-]{36}$/;
const HASH = /^[a-f0-9]{64}$/;
function uncertain() { throw Object.assign(new Error("Recovery state requires inspection; evidence retained"), { code: "RECOVERY_UNCERTAIN" }); }
function receiptPath(dbPath) { return dbPath + ".recovery-receipt.json"; }
function getRecoveryReceipt(dbPath) {
  if (!exists(receiptPath(dbPath))) return null;
  regular(receiptPath(dbPath));
  const receipt = JSON.parse(fs.readFileSync(receiptPath(dbPath), "utf8"));
  if (receipt.version !== 1 || !RESTORE_ID.test(receipt.id) || receipt.suppressAutomaticRecovery !== true) uncertain();
  return receipt;
}
function acknowledgeRecoveryReceipt(dbPath, id) {
  try {
    const receipt = getRecoveryReceipt(dbPath);
    if (!receipt || receipt.id !== id) return { ok: false, reason: "invalid_receipt" };
    fs.unlinkSync(receiptPath(dbPath)); sync(path.dirname(dbPath), true);
    return { ok: true, reason: "acknowledged" };
  } catch { return { ok: false, reason: "recovery_interrupted" }; }
}
function resumeRestore(dbPath) {
  const intentPath = dbPath + ".recovery-intent.json";
  if (!exists(intentPath)) return null;
  regular(intentPath);
  const intent = JSON.parse(fs.readFileSync(intentPath, "utf8"));
  if (intent.version !== 1 || intent.authorized !== true || !RESTORE_ID.test(intent.id) || !HASH.test(intent.stagedHash)
    || !Array.isArray(intent.originals) || intent.originals.length !== SIDECARS.length) uncertain();
  const dir = path.join(dbPath + ".recovery", intent.id);
  directory(dbPath + ".recovery");
  if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) uncertain();
  regular(path.join(dir, "intent.json"));
  const retainedIntent = JSON.parse(fs.readFileSync(path.join(dir, "intent.json"), "utf8"));
  if (JSON.stringify(retainedIntent) !== JSON.stringify(intent)) uncertain();
  const staged = path.join(dir, "staged.db");
  if (SIDECARS.slice(1).some(suffix => exists(staged + suffix)) || digest(staged) !== intent.stagedHash) uncertain();
  const counts = inspectFile(staged);
  // Check every path before advancing any move. Source+evidence duplication is
  // expected if power was lost after no-clobber linking but before unlinking.
  for (let i = 0; i < SIDECARS.length; i++) {
    const entry = intent.originals[i];
    if (entry.suffix !== SIDECARS[i] || !(entry.hash === null || HASH.test(entry.hash))) uncertain();
    const source = dbPath + entry.suffix;
    const evidence = path.join(dir, "original.db" + entry.suffix);
    const sourceHash = exists(source) ? digest(source) : null;
    const savedHash = exists(evidence) ? digest(evidence) : null;
    const published = entry.suffix === "" && sourceHash === intent.stagedHash;
    if (entry.hash === null) { if ((sourceHash && !published) || savedHash) uncertain(); }
    else if (savedHash !== entry.hash && sourceHash !== entry.hash) uncertain();
    else if (savedHash && savedHash !== entry.hash) uncertain();
    else if (sourceHash && sourceHash !== entry.hash && !published) uncertain();
  }
  for (const entry of intent.originals) {
    if (!entry.hash) continue;
    const source = dbPath + entry.suffix;
    const evidence = path.join(dir, "original.db" + entry.suffix);
    if (!exists(evidence)) { sync(source); publish(source, evidence); }
    if (exists(source) && digest(source) === entry.hash) {
      fs.unlinkSync(source); sync(path.dirname(dbPath), true);
    }
  }
  const publication = path.join(dir, `publication-${crypto.randomUUID()}.db`);
  if (!exists(dbPath)) {
    // Keep staged evidence on a separate inode from the future writable store.
    // An interrupted prior copy is retained, never reused as a complete file.
    fs.copyFileSync(staged, publication, fs.constants.COPYFILE_EXCL);
    if (digest(publication) !== intent.stagedHash) uncertain();
    sync(publication); publish(publication, dbPath);
  }
  if (digest(dbPath) !== intent.stagedHash) uncertain();
  // An earlier successful link may have been interrupted before unlinking its
  // private name. Remove only verified generated publication copies; retain
  // partial copies for inspection and keep staged/original evidence separate.
  for (const name of fs.readdirSync(dir)) {
    if (!/^publication-[a-f0-9-]{36}\.db$/.test(name)) continue;
    const file = path.join(dir, name);
    if (digest(file) === intent.stagedHash) fs.unlinkSync(file);
  }
  sync(dir, true);
  const receipt = { version: 1, id: intent.id, candidateId: intent.candidateId, restoredAt: intent.createdAt,
    suppressAutomaticRecovery: true, ...counts };
  if (exists(receiptPath(dbPath))) {
    if (getRecoveryReceipt(dbPath).id !== intent.id) uncertain();
  } else publishJson(receiptPath(dbPath), receipt);
  fs.unlinkSync(intentPath); sync(path.dirname(dbPath), true);
  return receipt;
}
// Host-only: caller must have explicit user confirmation and quiescent startup.
function beginRestore(dbPath, candidatePath, candidateId) {
  if (exists(dbPath + ".recovery-intent.json") || getRecoveryReceipt(dbPath)) uncertain();
  const id = "restore-" + crypto.randomUUID();
  const base = dbPath + ".recovery";
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  directory(base);
  const dir = path.join(base, id); fs.mkdirSync(dir);
  sync(base, true); sync(path.dirname(base), true);
  const staged = path.join(dir, "staged.db");
  createSqliteSnapshot(candidatePath, staged, { requireMessageStore: true });
  inspectFile(staged);
  const intent = { version: 1, id, authorized: true, candidateId, createdAt: Date.now(), stagedHash: digest(staged),
    originals: SIDECARS.map(suffix => ({ suffix, hash: exists(dbPath + suffix) ? digest(dbPath + suffix) : null })) };
  publishJson(path.join(dir, "intent.json"), intent);
  publishJson(dbPath + ".recovery-intent.json", intent);
  return resumeRestore(dbPath);
}
module.exports = { beginRestore, resumeRestore, getRecoveryReceipt, acknowledgeRecoveryReceipt };
