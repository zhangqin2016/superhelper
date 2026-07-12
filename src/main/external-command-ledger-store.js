"use strict";

// Crash-safe persistence for the external-command (mobile) admission ledger
// (contract MC-SPEC-008 §3.3). The in-memory ledger gives exactly-once
// ADMISSION within one process run; this store carries it across restarts so a
// mobile command replayed after a desktop crash still resolves to its original
// admission (idempotent_hit) instead of enqueuing a second turn.
//
// Design (matches the codebase's pure-logic-plus-thin-IO pattern):
//   - pruneSerialized / serializeLedgers / deserializeLedgers are pure and unit
//     tested against plain objects — no fs, no clock.
//   - createExternalCommandLedgerStore is the thin durable layer: an atomic
//     tmp+rename write, a debounced flush, and a fail-open sync load.
//
// FAIL-OPEN (CAPABILITY-GATE Rule 13): every IO path degrades to the current
// in-memory-only behaviour, never worse. A load failure starts empty (a
// post-crash replay might re-enqueue once — exactly today's baseline). A flush
// failure is logged and dropped (the live in-memory ledger still dedups this
// run). The store never throws into the admission path.

// Records live for LEDGER_RETAIN_MS (24h) from admit; prune anything past its
// retainUntil on load and before each flush so the file can't grow forever.
// A hard cap is a second backstop against a pathological flood: keep the most
// recently admitted records and drop the oldest tail (logged, never silent).
const DEFAULT_MAX_RECORDS = 5000;
const DEFAULT_DEBOUNCE_MS = 400;

/** Map<sessionId, Map<commandId, record>> → plain JSON-safe object. */
function serializeLedgers(ledgers) {
  const out = {};
  if (!ledgers || typeof ledgers.forEach !== "function") return out;
  ledgers.forEach((sessionLedger, sessionId) => {
    if (!sessionId || !sessionLedger || typeof sessionLedger.forEach !== "function") return;
    const bucket = {};
    sessionLedger.forEach((record, commandId) => {
      if (commandId && record && typeof record === "object") bucket[commandId] = record;
    });
    if (Object.keys(bucket).length) out[sessionId] = bucket;
  });
  return out;
}

/** Plain object → Map<sessionId, Map<commandId, record>>. Tolerates junk. */
function deserializeLedgers(plain) {
  const ledgers = new Map();
  if (!plain || typeof plain !== "object") return ledgers;
  for (const [sessionId, bucket] of Object.entries(plain)) {
    if (!sessionId || !bucket || typeof bucket !== "object") continue;
    const sessionLedger = new Map();
    for (const [commandId, record] of Object.entries(bucket)) {
      if (commandId && record && typeof record === "object") sessionLedger.set(commandId, record);
    }
    if (sessionLedger.size) ledgers.set(sessionId, sessionLedger);
  }
  return ledgers;
}

/**
 * Drop expired records (retainUntil <= now) and empty sessions from a plain
 * serialization; then, if still over maxRecords, keep the newest by createdAt
 * and drop the oldest tail. Pure: returns { plain, kept, expired, capped }.
 */
function pruneSerialized(plain, nowMs, maxRecords = DEFAULT_MAX_RECORDS) {
  const result = {};
  let kept = 0;
  let expired = 0;
  const all = [];
  if (plain && typeof plain === "object") {
    for (const [sessionId, bucket] of Object.entries(plain)) {
      if (!sessionId || !bucket || typeof bucket !== "object") continue;
      for (const [commandId, record] of Object.entries(bucket)) {
        if (!commandId || !record || typeof record !== "object") continue;
        const retainMs = Date.parse(record.retainUntil);
        // A record with no/invalid retainUntil is kept (fail-open: never drop a
        // dedup entry we can't prove is stale) but still subject to the cap.
        if (Number.isFinite(retainMs) && retainMs <= nowMs) { expired += 1; continue; }
        all.push({ sessionId, commandId, record, createdMs: Date.parse(record.createdAt) || 0 });
      }
    }
  }

  let capped = 0;
  let survivors = all;
  if (all.length > maxRecords) {
    survivors = all.slice().sort((a, b) => b.createdMs - a.createdMs).slice(0, maxRecords);
    capped = all.length - survivors.length;
  }

  for (const { sessionId, commandId, record } of survivors) {
    (result[sessionId] || (result[sessionId] = {}))[commandId] = record;
    kept += 1;
  }
  return { plain: result, kept, expired, capped };
}

const defaultIO = () => {
  const fs = require("fs");
  const path = require("path");
  return {
    existsSync: (p) => fs.existsSync(p),
    readFileSync: (p) => fs.readFileSync(p, "utf8"),
    writeFileSync: (p, data) => fs.writeFileSync(p, data),
    renameSync: (a, b) => fs.renameSync(a, b),
    mkdirSync: (dir) => fs.mkdirSync(dir, { recursive: true }),
    dirname: (p) => path.dirname(p),
  };
};

/**
 * Durable ledger store. Inject `io`/`now`/`log` in tests; production uses node
 * fs + Date.now + console. `filePath` is where the ledger JSON lives.
 */
function createExternalCommandLedgerStore({
  filePath,
  io = defaultIO(),
  now = () => Date.now(),
  log = console,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  maxRecords = DEFAULT_MAX_RECORDS,
} = {}) {
  let flushTimer = null;
  let pendingLedgers = null;

  function loadSync() {
    try {
      if (!filePath || !io.existsSync(filePath)) return new Map();
      const raw = io.readFileSync(filePath);
      const parsed = JSON.parse(raw);
      const source = parsed && parsed.ledgers ? parsed.ledgers : parsed;
      const { plain, expired, capped } = pruneSerialized(source, now(), maxRecords);
      if (expired || capped) {
        try { log.info && log.info("[mobile-ledger] pruned on load: expired=%d capped=%d", expired, capped); } catch { /* noop */ }
      }
      return deserializeLedgers(plain);
    } catch (err) {
      // Fail-open: a corrupt/unreadable ledger starts empty. Worst case a
      // post-crash replay re-enqueues once — the current baseline, never worse.
      try { log.warn && log.warn("[mobile-ledger] load failed open: %s", err?.message || err); } catch { /* noop */ }
      return new Map();
    }
  }

  function flushSync(ledgers) {
    try {
      if (!filePath) return false;
      const { plain, expired, capped } = pruneSerialized(serializeLedgers(ledgers), now(), maxRecords);
      if (capped) {
        try { log.warn && log.warn("[mobile-ledger] capped %d oldest records at flush (max=%d)", capped, maxRecords); } catch { /* noop */ }
      }
      void expired;
      const dir = io.dirname(filePath);
      try { io.mkdirSync(dir); } catch { /* dir may exist */ }
      const body = JSON.stringify({ schema: 1, savedAt: new Date(now()).toISOString(), ledgers: plain });
      const tmp = `${filePath}.tmp`;
      io.writeFileSync(tmp, body);
      io.renameSync(tmp, filePath);
      return true;
    } catch (err) {
      // Fail-open: a failed flush leaves the previous file intact and the live
      // in-memory ledger still dedups this run.
      try { log.warn && log.warn("[mobile-ledger] flush failed open: %s", err?.message || err); } catch { /* noop */ }
      return false;
    }
  }

  function scheduleFlush(ledgers) {
    pendingLedgers = ledgers;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const target = pendingLedgers;
      pendingLedgers = null;
      if (target) flushSync(target);
    }, debounceMs);
    if (typeof flushTimer.unref === "function") flushTimer.unref();
  }

  function dispose() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pendingLedgers) { const t = pendingLedgers; pendingLedgers = null; flushSync(t); }
  }

  return { loadSync, flushSync, scheduleFlush, dispose, filePath };
}

module.exports = {
  DEFAULT_MAX_RECORDS,
  DEFAULT_DEBOUNCE_MS,
  serializeLedgers,
  deserializeLedgers,
  pruneSerialized,
  createExternalCommandLedgerStore,
};
