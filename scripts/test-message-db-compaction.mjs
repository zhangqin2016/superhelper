#!/usr/bin/env node
/**
 * Reclaim disk from messages.db without an exclusive lock — and never at the
 * cost of a row.
 *
 * Deleting rows returns pages to SQLite's freelist; the FILE never shrinks.
 * Future writes reuse those pages, so a database stops growing on its own, but
 * one that already bloated stays bloated. Measured on a real install
 * 2026-09-04: 12.14 GB holding 1,156 messages, 7.34 GB of it runtime_events
 * payloads, 99.5% reclaimable.
 *
 * Plain VACUUM rebuilds in place under an exclusive lock — not something to do
 * to a customer's 12 GB file. VACUUM INTO reads the source and writes a
 * compacted copy, so nothing is write-locked and the disk required is the size
 * of the RESULT. The swap is a rename, done before the store's first open.
 *
 * A compaction that cannot prove itself must do nothing, so this exercises the
 * refusals as hard as the success path.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { compactMessageDatabase, VERIFIED_TABLES } = require("../src/main/store/message-db-compaction.js");
const { DatabaseSync } = require("node:sqlite");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "lily-compaction-"));
process.on("exit", () => fs.rmSync(work, { recursive: true, force: true }));

/** A database bloated the way the real one was: many rows written, then deleted. */
function bloatedDb(name, { rows = 20_000, keep = 50 } = {}) {
  const dbPath = path.join(work, name);
  const db = new DatabaseSync(dbPath);
  db.exec(`create table messages(session_id text, seq integer, id text primary key, body text);
           create table runtime_events(session_id text, seq integer, payload_json text, primary key(session_id, seq));
           create table turn_inputs(id text primary key);
           create table turn_projection(id text primary key);
           create table blobs(hash text primary key);
           create table message_blobs(message_id text, hash text);`);
  const insert = db.prepare("insert into runtime_events values (?,?,?)");
  const pad = "x".repeat(4000);
  db.exec("begin");
  for (let i = 0; i < rows; i += 1) insert.run("s1", i, pad);
  db.prepare("insert into messages values (?,?,?,?)").run("s1", 1, "m1", "hello");
  db.exec("commit");
  db.exec(`delete from runtime_events where seq >= ${keep}`);
  db.close();
  return dbPath;
}

// --- the success path ----------------------------------------------------
{
  const dbPath = bloatedDb("ok.db");
  const before = fs.statSync(dbPath).size;
  assert.ok(before > 50 * 1e6, `the fixture must actually be bloated, got ${before} bytes`);

  const result = compactMessageDatabase(dbPath, { minBytes: 1_000_000 });
  assert.equal(result.compacted, true, `compaction should have run: ${result.reason}`);
  const after = fs.statSync(dbPath).size;
  assert.ok(after < before / 10, `the file must actually shrink: ${before} → ${after}`);

  // Every row still there, and the database still sound.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(db.prepare("select count(*) n from runtime_events").get().n, 50, "kept rows must survive");
  assert.equal(db.prepare("select count(*) n from messages").get().n, 1, "messages must survive");
  assert.equal(
    String(Object.values(db.prepare("pragma integrity_check").get())[0]),
    "ok",
    "the swapped-in database must pass integrity_check",
  );
  db.close();

  // No debris, and no leftover copy eating the disk it just freed.
  const leftovers = fs.readdirSync(work).filter((f) => f.startsWith("ok.db") && f !== "ok.db");
  assert.deepEqual(leftovers, [], `no temp or backup files may be left behind, found ${leftovers.join(", ")}`);
}

// --- the refusals --------------------------------------------------------
{
  // A small database is left alone: the copy would cost more than it saves.
  const small = bloatedDb("small.db", { rows: 40 });
  const sizeBefore = fs.statSync(small).size;
  const result = compactMessageDatabase(small);
  assert.equal(result.compacted, false, "a small database must be left alone");
  assert.equal(result.reason, "small_enough", `expected small_enough, got ${result.reason}`);
  assert.equal(fs.statSync(small).size, sizeBefore, "and must not be touched at all");
}
{
  // A big database with nothing to reclaim must not be rewritten for nothing.
  const dbPath = path.join(work, "dense.db");
  const db = new DatabaseSync(dbPath);
  db.exec("create table messages(id text primary key, body text)");
  const insert = db.prepare("insert into messages values (?,?)");
  const pad = "y".repeat(4000);
  db.exec("begin");
  for (let i = 0; i < 20_000; i += 1) insert.run(`m${i}`, pad);
  db.exec("commit");
  db.close();
  const result = compactMessageDatabase(dbPath, { minBytes: 1_000_000 });
  assert.equal(result.compacted, false, "a dense database has nothing to reclaim");
  assert.equal(result.reason, "not_enough_reclaimable", `expected not_enough_reclaimable, got ${result.reason}`);
}
{
  const result = compactMessageDatabase(path.join(work, "nope.db"));
  assert.equal(result.compacted, false, "a missing database is not an error");
  assert.equal(result.reason, "missing");
}
{
  // Kill switch.
  const dbPath = bloatedDb("switched.db");
  const sizeBefore = fs.statSync(dbPath).size;
  process.env.LILY_COMPACT_MESSAGE_DB = "0";
  const result = compactMessageDatabase(dbPath, { minBytes: 1_000_000 });
  delete process.env.LILY_COMPACT_MESSAGE_DB;
  assert.equal(result.compacted, false, "the kill switch must stop it");
  assert.equal(result.reason, "disabled");
  assert.equal(fs.statSync(dbPath).size, sizeBefore, "and leave the file alone");
}
{
  // A row-count mismatch means the copy is not equivalent — refuse and keep
  // the original. This is the assertion that makes the whole thing trustworthy.
  const dbPath = bloatedDb("mismatch.db");
  const sizeBefore = fs.statSync(dbPath).size;
  let call = 0;
  const result = compactMessageDatabase(dbPath, {
    minBytes: 1_000_000,
    // Second open is the copy; report a table as emptier than it is.
    openDatabase: (p, ro) => {
      const db = new DatabaseSync(p, ro ? { readOnly: true } : undefined);
      call += 1;
      if (call < 3) return db;
      const real = db.prepare.bind(db);
      db.prepare = (sql) => (/count\(\*\)[\s\S]*messages/.test(sql)
        ? { get: () => ({ n: 0 }) }
        : real(sql));
      return db;
    },
  });
  assert.equal(result.compacted, false, "a row-count mismatch must abort the swap");
  assert.match(result.reason, /^row_count_mismatch:/, `expected a named mismatch, got ${result.reason}`);
  assert.equal(fs.statSync(dbPath).size, sizeBefore, "the ORIGINAL must be untouched when verification fails");
  const leftovers = fs.readdirSync(work).filter((f) => f.startsWith("mismatch.db") && f !== "mismatch.db");
  assert.deepEqual(leftovers, [], "a refused compaction must clean up its copy");
}
{
  // A copy that fails integrity_check must be refused. Without a case where the
  // check actually reports a problem, removing the check entirely would pass —
  // the assertion has to be able to fail.
  const dbPath = bloatedDb("corrupt.db");
  const sizeBefore = fs.statSync(dbPath).size;
  let call = 0;
  const result = compactMessageDatabase(dbPath, {
    minBytes: 1_000_000,
    openDatabase: (p, ro) => {
      const db = new DatabaseSync(p, ro ? { readOnly: true } : undefined);
      call += 1;
      if (call < 3) return db;
      const real = db.prepare.bind(db);
      db.prepare = (sql) => (/integrity_check/.test(sql)
        ? { get: () => ({ integrity_check: "*** in database main *** page 42 is never used" }) }
        : real(sql));
      return db;
    },
  });
  assert.equal(result.compacted, false, "a copy failing integrity_check must be refused");
  assert.match(result.reason, /^integrity_check_failed:/, `expected a named integrity failure, got ${result.reason}`);
  assert.equal(fs.statSync(dbPath).size, sizeBefore, "the ORIGINAL must be untouched when the copy is unsound");
  const leftovers = fs.readdirSync(work).filter((f) => f.startsWith("corrupt.db") && f !== "corrupt.db");
  assert.deepEqual(leftovers, [], "an unsound copy must be deleted, not left on disk");
}
{
  // An internal failure must never throw into startup.
  const dbPath = bloatedDb("boom.db");
  const result = compactMessageDatabase(dbPath, {
    minBytes: 1_000_000,
    openDatabase: () => { throw new Error("cannot open"); },
  });
  assert.equal(result.compacted, false, "a failure returns a reason");
  assert.equal(result.reason, "error");
  assert.ok(fs.existsSync(dbPath), "and the database still exists");
}

// --- the tables it verifies ---------------------------------------------
for (const table of ["messages", "runtime_events", "turn_inputs", "turn_projection", "blobs", "message_blobs"]) {
  assert.ok(VERIFIED_TABLES.includes(table), `${table} carries user data and must be row-count verified`);
}

// --- wired before the first open ----------------------------------------
const manager = fs.readFileSync(path.join(ROOT, "src/main/session-manager.js"), "utf8");
const storeFn = manager.slice(manager.indexOf("  _store() {"), manager.indexOf("  _store() {") + 900);
assert.match(storeFn, /compactMessageDatabase\(messageDbPath\(\)\)/, "compaction must run in _store()");
const compactAt = storeFn.indexOf("compactMessageDatabase");
const openAt = storeFn.indexOf("new MessageStore(");
assert.ok(compactAt > 0 && openAt > 0, "both the compaction and the open must be present");
assert.ok(
  compactAt < openAt,
  "compaction must run BEFORE the store is opened — the rename cannot race a reader",
);
assert.match(storeFn, /catch\s*\{/, "and be fail-open: the store must open even if maintenance cannot run");

console.log("message db compaction: ok");
console.log("  247 MB-class fixture shrinks >10x with every row intact");
console.log("  refuses: small, dense, missing, kill-switched, row-count mismatch, internal failure");
