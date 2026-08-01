"use strict";
/**
 * §19.7 performance targets on the supported ordinary-hardware profile:
 *   - binding lookup/snapshot p95 < 2 ms (§14.5)
 *   - normal character compilation p95 < 50 ms (§14.5, 200 ms warning)
 * Uses the REAL repository + REAL compiler over a real MessageStore with a
 * bound character + persona + embedded world book, so the measured path is
 * the production one. p95 = 95th percentile of per-call wall-clock ms.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const {
  CharacterWorldsRepository,
} = require("../src/main/character-worlds/repository.js");
const {
  compileCharacterContext,
} = require("../src/main/character-worlds/context-compiler.js");
const {
  readySnapshot,
} = require("../src/main/character-worlds/turn-binding-snapshot.js");

const OWNER = "profile:perf";
const SNAPSHOT_SAMPLES = 2_000;
const COMPILE_SAMPLES = 400;
const BINDING_P95_MS = 2;
const COMPILE_P95_MS = 50;

function p95Of(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "character-perf-"));
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const repo = new CharacterWorldsRepository(store);

const book = repo.createWorldBook({
  ownerScope: OWNER,
  canonical: {
    schemaVersion: 1,
    name: "Perf Atlas",
    entries: [{ id: "e-1", content: "Perf lore", activation: { constant: true } }],
  },
  source: { kind: "created", format: "lily", container: "json" },
  assets: [],
});
const hero = repo.createCharacter({
  ownerScope: OWNER,
  canonical: { name: "Perf Hero", description: "bound character", personality: "brief" },
  source: { kind: "created", format: "lily", container: "json" },
  assets: [],
  characterBookRevisionId: book.revision.id,
});
const persona = repo.createPersona({
  ownerScope: OWNER,
  canonical: { schemaVersion: 1, name: "Perf Persona", description: "narrative" },
  source: { kind: "created", format: "lily", container: "json" },
  assets: [],
});
repo.setBinding({
  sessionId: "session-perf",
  ownerScope: OWNER,
  expectedBindingVersion: 0,
  next: {
    mode: "character",
    characterRevisionId: hero.revision.id,
    personaRevisionId: persona.revision.id,
  },
});

const binding = repo.getBinding("session-perf", OWNER);
const snapshot = readySnapshot({
  bindingVersion: binding.bindingVersion,
  characterRevisionId: binding.characterRevisionId,
  personaRevisionId: binding.personaRevisionId,
  compatibilityProfile: binding.compatibilityProfile,
});
const heroRevision = repo.getRevision(OWNER, hero.revision.id);
const personaRevision = repo.getPersonaRevision(OWNER, persona.revision.id);

// Warm-up (JIT + connection pool).
for (let i = 0; i < 200; i += 1) {
  repo.getBinding("session-perf", OWNER);
  compileCharacterContext({
    snapshot,
    revision: heroRevision,
    userText: "warmup",
    persona: personaRevision,
    worldBook: repo.getWorldBookRevision(OWNER, book.revision.id),
  });
}

try {
  const snapshotSamples = [];
  for (let i = 0; i < SNAPSHOT_SAMPLES; i += 1) {
    const t0 = process.hrtime.bigint();
    const row = repo.getBinding("session-perf", OWNER);
    if (row.mode !== "character") throw new Error("binding lost");
    const snap = readySnapshot({
      bindingVersion: row.bindingVersion,
      characterRevisionId: row.characterRevisionId,
      personaRevisionId: row.personaRevisionId,
      compatibilityProfile: row.compatibilityProfile,
    });
    if (!snap) throw new Error("snapshot failed");
    const t1 = process.hrtime.bigint();
    snapshotSamples.push(Number(t1 - t0) / 1e6);
  }
  const snapshotP95 = p95Of(snapshotSamples);
  check(`binding lookup + snapshot p95 < ${BINDING_P95_MS}ms (measured ${snapshotP95.toFixed(3)}ms over ${SNAPSHOT_SAMPLES} samples)`, () => {
    assert.ok(snapshotP95 < BINDING_P95_MS, `binding snapshot p95 ${snapshotP95.toFixed(3)}ms >= ${BINDING_P95_MS}ms`);
  });

  const compileSamples = [];
  for (let i = 0; i < COMPILE_SAMPLES; i += 1) {
    const t0 = process.hrtime.bigint();
    const result = compileCharacterContext({
      snapshot,
      revision: heroRevision,
      userText: `turn ${i}`,
      persona: personaRevision,
      worldBook: repo.getWorldBookRevision(OWNER, book.revision.id),
    });
    if (result.status !== "compiled") throw new Error(`compile failed open: ${result.status}`);
    const t1 = process.hrtime.bigint();
    compileSamples.push(Number(t1 - t0) / 1e6);
  }
  const compileP95 = p95Of(compileSamples);
  check(`normal character compilation p95 < ${COMPILE_P95_MS}ms (measured ${compileP95.toFixed(1)}ms over ${COMPILE_SAMPLES} samples)`, () => {
    assert.ok(compileP95 < COMPILE_P95_MS, `compilation p95 ${compileP95.toFixed(1)}ms >= ${COMPILE_P95_MS}ms`);
  });

  console.log(`PASS: test-character-worlds-performance (${checks} checks, binding p95 ${snapshotP95.toFixed(3)}ms, compile p95 ${compileP95.toFixed(1)}ms)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
