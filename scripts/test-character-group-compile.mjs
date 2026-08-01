"use strict";
/**
 * §12 group prompt-mode compilation (Phase 3, P3-2 wiring): swap compiles the
 * active speaker's full card plus bounded participant summaries; join compiles
 * the declared safe fields of all members with per-character boundaries and is
 * reported as behaviorally risky (a card can never enable it).
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  compileCharacterContext,
} = require("../src/main/character-worlds/context-compiler.js");

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

const snapshot = {
  schemaVersion: 1,
  mode: "character",
  bindingVersion: 5,
  characterRevisionId: "char-rev-A",
  personaRevisionId: null,
  compatibilityProfile: "v3",
  snapshotStatus: "ready",
};
const revisionA = {
  id: "char-rev-A",
  characterId: "char-A",
  schemaVersion: 1,
  canonical: {
    name: "Aria",
    description: "Aria is the lighthouse keeper.",
    personality: "Calm and watchful.",
  },
  source: { format: "lily", container: "json", original: null },
  cardAssets: [],
  characterBookRevisionId: null,
};
const revisionB = {
  id: "char-rev-B",
  characterId: "char-B",
  schemaVersion: 1,
  canonical: {
    name: "Bram",
    description: "Bram is the harbor pilot.",
    personality: "Brusque but kind.",
  },
  source: { format: "lily", container: "json", original: null },
  cardAssets: [],
  characterBookRevisionId: null,
};

try {
  await check("swap compiles the active speaker full card plus bounded participant summaries", async () => {
    const scene = {
      activeSpeakerRevisionId: "char-rev-A",
      participantCharacterRevisionIds: ["char-rev-A", "char-rev-B"],
      promptMode: "swap",
      participants: [revisionA, revisionB],
    };
    const result = compileCharacterContext({ snapshot, revision: revisionA, scene });
    assert.equal(result.status, "compiled");
    assert.ok(result.text.includes("Aria"), "active speaker full card");
    assert.ok(result.text.includes("Bram"), "participant summary present");
    assert.ok(result.text.includes("harbor pilot"), "participant summary carries bounded description");
  });

  await check("join combines member safe fields with per-character boundaries and is risky", async () => {
    const scene = {
      activeSpeakerRevisionId: "char-rev-A",
      participantCharacterRevisionIds: ["char-rev-A", "char-rev-B"],
      promptMode: "join",
      participants: [revisionA, revisionB],
    };
    const result = compileCharacterContext({ snapshot, revision: revisionA, scene });
    assert.equal(result.status, "compiled");
    assert.ok(result.text.includes("Aria"), "join includes Aria");
    assert.ok(result.text.includes("Bram"), "join includes Bram");
    assert.ok(result.text.includes("behaviorally risky") || result.text.includes("风险"), "join reported as risky");
  });

  console.log(`PASS: test-character-group-compile (${checks} checks)`);
} catch (error) {
  console.error("FAIL:", error?.message || error);
  process.exitCode = 1;
}
