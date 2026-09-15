"use strict";
const { fs, path, crypto, SIDECARS, exists, directory, digest, sync, publish, classify, inspectFile, recoverHotJournal, hasRollbackJournalHeader } = require("./database-recovery-files");
const { createSqliteSnapshot, restoreInterruptedMessageCompaction } = require("./sqlite-snapshot");
const { beginRestore, resumeRestore, getRecoveryReceipt, acknowledgeRecoveryReceipt } = require("./database-recovery-restore");
const CANDIDATE = /^(backup|precompact|readable)-(\d{13})-([a-f0-9]{12})-([a-f0-9]{64})$/;
const KINDS = { backup: "auto_backup", precompact: "precompact", readable: "readable_copy" };
function failure(error) { return { ok: false, reason: classify(error) }; }
function hasEvidence(dbPath) {
  return SIDECARS.slice(1).some(s => exists(dbPath + s)) || exists(dbPath + ".precompact")
    || [".backups", ".recovery"].some(s => exists(dbPath + s) && fs.readdirSync(dbPath + s).length > 0)
    || exists(dbPath + ".recovery-receipt.json");
}
function inspectDatabase(dbPath) {
  try {
    let receipt;
    if (exists(dbPath + ".recovery-intent.json")) {
      try { receipt = resumeRestore(dbPath); }
      catch { return { ok: false, exists: exists(dbPath), reason: "recovery_interrupted" }; }
    }
    if (!exists(dbPath)) {
      if (SIDECARS.slice(1).some(s => exists(dbPath + s))) return { ok: false, exists: false, reason: "missing_with_evidence" };
      if (exists(dbPath + ".precompact")) restoreInterruptedMessageCompaction(dbPath);
      else if (hasEvidence(dbPath)) return { ok: false, exists: false, reason: "missing_with_evidence" };
      else return { ok: true, exists: false, reason: "new_install" };
    }
    let counts;
    try { counts = inspectFile(dbPath); }
    catch (error) {
      // SQLITE_READONLY_ROLLBACK (776) specifically means SQLite has a hot
      // rollback journal. Ordinary permissions/I/O errors never enter repair.
      if (Number(error.errcode) !== 776 && !(error.code === "RECOVERY_CORRUPT" && hasRollbackJournalHeader(dbPath))) throw error;
      counts = recoverHotJournal(dbPath);
    }
    receipt ||= getRecoveryReceipt(dbPath);
    return { ok: true, exists: true, reason: "healthy", ...counts, ...(receipt ? { restoreReceipt: receipt } : {}) };
  } catch (error) {
    let present = null;
    try { present = exists(dbPath); } catch { /* preserve the original error classification */ }
    return { ...failure(error), exists: present };
  }
}
function candidateFor(dbPath, id) {
  const match = typeof id === "string" && CANDIDATE.exec(id);
  if (!match) throw new Error("Invalid candidate ID");
  directory(dbPath + ".backups");
  const file = path.join(dbPath + ".backups", id + ".db");
  if (SIDECARS.slice(1).some(suffix => exists(file + suffix)) || digest(file) !== match[4]) throw new Error("Candidate changed");
  return { file, view: { id, createdAt: match[1] === "backup" ? Number(match[2]) : null,
    preparedAt: Number(match[2]), sourceKind: KINDS[match[1]], ...inspectFile(file) } };
}
function snapshotCandidate(dbPath, source, kind) {
  const base = dbPath + ".backups";
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  directory(base);
  const privateDir = fs.mkdtempSync(path.join(base, ".candidate-"));
  try {
    const temporary = path.join(privateDir, "snapshot.db");
    createSqliteSnapshot(source, temporary, { requireMessageStore: true });
    inspectFile(temporary);
    const id = `${kind}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${digest(temporary)}`;
    publish(temporary, path.join(base, id + ".db"));
    sync(path.dirname(base), true);
    return candidateFor(dbPath, id).view;
  } finally { fs.rmSync(privateDir, { recursive: true, force: true }); }
}
function createRecoveryBackup(dbPath, { minIntervalMs = 0 } = {}) {
  try {
    const base = dbPath + ".backups";
    if (minIntervalMs > 0 && exists(base)) {
      directory(base);
      for (const name of fs.readdirSync(base).sort().reverse()) {
        if (!name.startsWith("backup-") || !name.endsWith(".db")) continue;
        try {
          const candidate = candidateFor(dbPath, name.slice(0, -3)).view;
          const age = Date.now() - candidate.createdAt;
          if (age >= 0 && age < minIntervalMs) return { ok: true, reason: "recent_backup", candidate };
        } catch { /* a damaged snapshot never prevents a fresh backup */ }
      }
    }
    // Called in a worker; VACUUM INTO reads the live WAL consistently.
    const candidate = snapshotCandidate(dbPath, dbPath, "backup");
    const backups = fs.readdirSync(base).filter(name => name.startsWith("backup-") && CANDIDATE.test(name.slice(0, -3)) && name.endsWith(".db"));
    backups.sort().reverse();
    let verified = 0;
    for (const name of backups) {
      // Invalid newer files are evidence, not usable retention slots.
      try {
        candidateFor(dbPath, name.slice(0, -3));
        if (++verified > 4) fs.unlinkSync(path.join(base, name));
      } catch { /* retain uncertain evidence */ }
    }
    sync(base, true);
    return { ok: true, reason: "created", candidate };
  } catch (error) { return failure(error); }
}
function prepareRecovery(dbPath) {
  const candidates = [];
  try {
    const base = dbPath + ".backups";
    if (exists(base)) directory(base);
    if (exists(base)) for (const name of fs.readdirSync(base)) {
      if (!name.endsWith(".db")) continue;
      try { candidates.push(candidateFor(dbPath, name.slice(0, -3)).view); } catch { /* only verified candidates */ }
    }
    if (exists(dbPath + ".precompact") && !candidates.some(c => c.sourceKind === "precompact")) {
      try { candidates.push(snapshotCandidate(dbPath, dbPath + ".precompact", "precompact")); } catch { /* retained */ }
    }
    const state = inspectDatabase(dbPath);
    if (state.reason === "corrupt" && !candidates.some(c => c.sourceKind === "readable_copy")) {
      // A SQLite rewrite may read a healthy logical snapshot despite a damaged
      // free page/index. Try only on an isolated, quiescent copy of all files.
      const isolated = fs.mkdtempSync(path.join(path.dirname(dbPath), ".recovery-read-"));
      try {
        const copy = path.join(isolated, "messages.db");
        for (const suffix of SIDECARS) if (exists(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, copy + suffix, fs.constants.COPYFILE_EXCL);
        candidates.push(snapshotCandidate(dbPath, copy, "readable"));
      } catch { /* No row-by-row salvage or completeness claim. */ }
      finally { fs.rmSync(isolated, { recursive: true, force: true }); }
    }
    candidates.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || b.preparedAt - a.preparedAt);
    return { ok: true, reason: candidates.length ? "candidates_available" : state.reason, candidates };
  } catch (error) { return { ...failure(error), candidates }; }
}
function restoreRecoveryCandidate(dbPath, id) {
  let candidate;
  try { candidate = candidateFor(dbPath, id); }
  catch { return { ok: false, reason: "invalid_candidate" }; }
  const current = inspectDatabase(dbPath);
  if (current.ok || !["corrupt", "missing_with_evidence"].includes(current.reason)) {
    // Confirmation of a snapshot is not authority to replace a live/locked
    // healthy store or to treat access and disk failures as corruption.
    return { ok: false, reason: current.ok ? "already_healthy" : current.reason };
  }
  try { return { ok: true, reason: "restored", receipt: beginRestore(dbPath, candidate.file, id) }; }
  catch (error) { return { ok: false, reason: exists(dbPath + ".recovery-intent.json") ? "recovery_interrupted" : classify(error) }; }
}
module.exports = { inspectDatabase, createRecoveryBackup, prepareRecovery, restoreRecoveryCandidate,
  getRecoveryReceipt, acknowledgeRecoveryReceipt };
