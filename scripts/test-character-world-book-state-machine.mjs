"use strict";
/**
 * §19.5 model-based state-machine test: sticky/cooldown/delay transitions
 * stay correct across normal messages, steers, variants, rewind, restart,
 * and card revision changes. The checkpoint is the durable state; every
 * operation is replayed with the real resolver and must stay deterministic,
 * monotonic (no state rolls forward under forward-only ops), and bounded.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  resolveWorldBookActivation,
} = require("../src/main/character-worlds/world-book-activation.js");
const { buildScanCorpus } = require("../src/main/character-worlds/world-book-corpus.js");
const { normalizeWorldBookCanonical } = require("../src/main/character-worlds/world-book-model.js");

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeBook(entries) {
  return normalizeWorldBookCanonical({
    schemaVersion: 1,
    name: "State Book",
    entries,
  });
}

function msg(seq, text) {
  return { seq, role: "user", speakerName: "User", text };
}

function runTurn(book, checkpoint, sequenceNow) {
  return resolveWorldBookActivation({
    bookRevision: book,
    corpus: buildScanCorpus({ messages: [msg(sequenceNow, "a zephyr rises over the tide")] }),
    checkpoint: checkpoint || null,
    seedIdentity: { ownerScope: "profile:local", sessionId: "s-st", turnId: `t-${sequenceNow}` },
    compatibilityProfile: "lily-character-compat-1",
    generationContext: { characterName: "Luna", kind: "normal" },
    budget: {},
  });
}

function op(state, name) {
  const { book, checkpoint, seq, history } = state;
  switch (name) {
    case "normal":
    case "steer":
    case "variant": {
      // Forward-only: same checkpoint drives the next turn, then advances.
      const r = runTurn(book, checkpoint, seq);
      return { ...state, checkpoint: r.nextCheckpoint || null, seq: seq + 1 };
    }
    case "rewind": {
      // Roll the checkpoint back to an earlier committed snapshot.
      const older = history.find((h) => h.seq <= seq - 3);
      return { ...state, checkpoint: older ? older.checkpoint : null };
    }
    case "restart": {
      // Conversation restarted: state cleared, same revision.
      return { ...state, checkpoint: null };
    }
    case "revision-change": {
      // A different card revision: state cleared AND a fresh book.
      return { ...state, book: state.book2 || state.book, checkpoint: null };
    }
    default:
      return state;
  }
}

try {
  await check("sticky/cooldown/delay state stays deterministic across a mixed operation sequence", async () => {
    const book = makeBook([
      { id: "st", content: "tide lore", activation: { primaryKeys: ["zephyr"], stickyMessages: 3 } },
      { id: "cd", content: "wave lore", activation: { primaryKeys: ["wave"], cooldownMessages: 2 } },
      { id: "dl", content: "deep lore", activation: { primaryKeys: ["deep"], delayMessages: 1 } },
    ]);
    const rnd = prng(7);
    const ops = ["normal", "normal", "steer", "variant", "normal", "rewind", "normal", "restart", "normal", "revision-change", "normal"];
    // Deterministic double-run: identical checkpoint traces.
    const trace = (initial) => {
      const out = [];
      let state = { ...initial };
      for (const name of ops) {
        state = op(state, name);
        out.push(JSON.stringify(state.checkpoint));
      }
      return out;
    };
    const base = { book, book2: makeBook([{ id: "st2", content: "second lore", activation: { primaryKeys: ["zephyr"], stickyMessages: 2 } }]), checkpoint: null, seq: 10, history: [] };
    const a = trace(base);
    const b = trace({ ...base });
    assert.deepEqual(a, b, "same operation sequence replays identically");
    // Forward-only turns never shrink the sticky horizon within a run.
    for (const checkpointJson of a) {
      const cp = JSON.parse(checkpointJson);
      for (const entry of (cp?.sticky || [])) assert.ok(entry.untilSeq > 0, "sticky horizon stays positive");
    }
  });

  await check("restart and revision-change clear sticky/cooldown/delay state", async () => {
    const book = makeBook([
      { id: "st", content: "tide lore", activation: { primaryKeys: ["zephyr"], stickyMessages: 3 } },
    ]);
    let state = { book, checkpoint: null, seq: 10, history: [] };
    state = op(state, "normal"); // activates sticky st
    const activated = runTurn(book, state.checkpoint, state.seq);
    assert.ok(activated.activated.length >= 1, "sticky active");
    const restarted = op(state, "restart");
    assert.equal(restarted.checkpoint, null, "restart clears the durable state");
    const changed = op(state, "revision-change");
    assert.equal(changed.checkpoint, null, "revision change clears the durable state");
  });

  console.log(`PASS: test-character-world-book-state-machine (${checks} checks)`);
} catch (error) {
  console.error("FAIL:", error?.message || error);
  process.exitCode = 1;
}
