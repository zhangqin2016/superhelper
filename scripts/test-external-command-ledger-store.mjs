#!/usr/bin/env node
// Unit test for the durable external-command admission ledger store: pure
// serialize/deserialize/prune round-trips + the injected-IO store's load/flush,
// atomicity, debounce, and fail-open behaviour.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  serializeLedgers,
  deserializeLedgers,
  pruneSerialized,
  createExternalCommandLedgerStore,
} = require("../src/main/external-command-ledger-store.js");

const rec = (over = {}) => ({
  commandId: "cmd_1",
  idempotencyKey: "cmd_1",
  payloadHash: "h",
  state: "admitted",
  createdAt: "2026-07-12T00:00:00.000Z",
  retainUntil: "2026-07-13T00:00:00.000Z",
  ...over,
});

// --- pure round-trip ---
{
  const ledgers = new Map([
    ["sess_a", new Map([["cmd_1", rec()], ["cmd_2", rec({ commandId: "cmd_2" })]])],
    ["sess_b", new Map([["cmd_3", rec({ commandId: "cmd_3" })]])],
  ]);
  const plain = serializeLedgers(ledgers);
  assert.equal(Object.keys(plain).length, 2, "two sessions serialized");
  assert.equal(plain.sess_a.cmd_1.commandId, "cmd_1");
  const back = deserializeLedgers(plain);
  assert.equal(back.get("sess_a").size, 2, "session a round-trips two records");
  assert.equal(back.get("sess_b").get("cmd_3").commandId, "cmd_3");
}

// --- serialize drops empty sessions / junk ---
{
  const ledgers = new Map([["empty", new Map()], ["", new Map([["x", rec()]])]]);
  assert.deepEqual(serializeLedgers(ledgers), {}, "empty and unkeyed sessions dropped");
  assert.deepEqual(serializeLedgers(null), {}, "null tolerated");
}

// --- prune expiry ---
{
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  const plain = {
    s: {
      alive: rec({ commandId: "alive", retainUntil: "2026-07-13T00:00:00.000Z" }),
      dead: rec({ commandId: "dead", retainUntil: "2026-07-12T00:00:00.000Z" }),
    },
  };
  const { plain: pruned, kept, expired } = pruneSerialized(plain, now);
  assert.equal(kept, 1, "one kept");
  assert.equal(expired, 1, "one expired");
  assert.ok(pruned.s.alive, "alive survives");
  assert.ok(!pruned.s.dead, "dead pruned");
}

// --- prune keeps records with missing/invalid retainUntil (fail-open) ---
{
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  const { kept } = pruneSerialized({ s: { x: rec({ retainUntil: undefined }) } }, now);
  assert.equal(kept, 1, "record with no retainUntil is kept, not dropped");
}

// --- cap keeps newest by createdAt ---
{
  const now = Date.parse("2026-07-12T12:00:00.000Z");
  const bucket = {};
  for (let i = 0; i < 5; i += 1) {
    bucket[`c${i}`] = rec({ commandId: `c${i}`, createdAt: `2026-07-1${i}T00:00:00.000Z`, retainUntil: "2027-01-01T00:00:00.000Z" });
  }
  const { kept, capped, plain } = pruneSerialized({ s: bucket }, now, 2);
  assert.equal(kept, 2, "cap keeps 2");
  assert.equal(capped, 3, "cap drops 3");
  assert.ok(plain.s.c4 && plain.s.c3, "newest two survive");
  assert.ok(!plain.s.c0, "oldest dropped");
}

// --- store: atomic flush + load round-trip with injected IO ---
{
  const files = new Map();
  let nowMs = Date.parse("2026-07-12T12:00:00.000Z");
  const io = {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => files.get(p),
    writeFileSync: (p, data) => files.set(p, data),
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    mkdirSync: () => {},
    dirname: () => "/tmp",
  };
  const store = createExternalCommandLedgerStore({ filePath: "/tmp/ledger.json", io, now: () => nowMs, log: {} });
  const ledgers = new Map([["s", new Map([["cmd_1", rec({ retainUntil: "2027-01-01T00:00:00.000Z" })]])]]);
  assert.equal(store.flushSync(ledgers), true, "flush succeeds");
  assert.ok(files.has("/tmp/ledger.json"), "final file written");
  assert.ok(!files.has("/tmp/ledger.json.tmp"), "tmp renamed away (atomic)");

  const loaded = store.loadSync();
  assert.equal(loaded.get("s").get("cmd_1").commandId, "cmd_1", "round-trips through disk");

  // expired records don't survive a reload
  nowMs = Date.parse("2028-01-01T00:00:00.000Z");
  assert.equal(store.loadSync().size, 0, "everything expired => empty load");
}

// --- store: load fail-opens on corrupt file ---
{
  const files = new Map([["/tmp/x.json", "{not json"]]);
  const io = {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => files.get(p),
    writeFileSync: () => {}, renameSync: () => {}, mkdirSync: () => {}, dirname: () => "/tmp",
  };
  const store = createExternalCommandLedgerStore({ filePath: "/tmp/x.json", io, now: () => 0, log: {} });
  assert.equal(store.loadSync().size, 0, "corrupt file => empty map, no throw");
}

// --- store: flush fail-opens when IO throws ---
{
  const io = {
    existsSync: () => false, readFileSync: () => "", dirname: () => "/tmp", mkdirSync: () => {},
    writeFileSync: () => { throw new Error("disk full"); }, renameSync: () => {},
  };
  const store = createExternalCommandLedgerStore({ filePath: "/tmp/y.json", io, now: () => 0, log: {} });
  assert.equal(store.flushSync(new Map([["s", new Map([["c", rec()]])]])), false, "flush returns false, no throw");
}

// --- store: debounced scheduleFlush coalesces and writes once ---
{
  let writes = 0;
  const files = new Map();
  const io = {
    existsSync: () => false, readFileSync: () => "", dirname: () => "/tmp", mkdirSync: () => {},
    writeFileSync: (p, d) => { writes += 1; files.set(p, d); },
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
  };
  const store = createExternalCommandLedgerStore({ filePath: "/tmp/z.json", io, now: () => 0, log: {}, debounceMs: 5 });
  const ledgers = new Map([["s", new Map([["c", rec()]])]]);
  store.scheduleFlush(ledgers);
  store.scheduleFlush(ledgers);
  store.scheduleFlush(ledgers);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(writes, 1, "three schedules coalesce into one write");
  // dispose flushes any pending
  store.scheduleFlush(ledgers);
  store.dispose();
  assert.equal(writes, 2, "dispose flushes the pending write");
}

console.log("external-command-ledger-store: ok");
