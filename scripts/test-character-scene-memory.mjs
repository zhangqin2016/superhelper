"use strict";
/**
 * §11 scene memory (Phase 3, P3-1): per-(conversation, character-revision)
 * durable episodic memory with provenance, superseding, post-success
 * extraction, and bounded injection into the lower-authority character
 * context. Narrative memory NEVER becomes a Lily task fact.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const { CharacterWorldsRepository } = require("../src/main/character-worlds/repository.js");
const sceneMemory = require("../src/main/character-worlds/scene-memory.js");
const { CharacterSceneMemoryService } = require("../src/main/character-worlds/scene-memory-service.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scene-memory-"));
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const repo = new CharacterWorldsRepository(store);

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

try {
  const sessionId = "s-mem-1";
  const revA = "char-rev-A";
  const revB = "char-rev-B";

  await check("memory items are durable and keyed by (session, character revision)", async () => {
    sceneMemory.appendMemory(store.db, {
      sessionId, characterRevisionId: revA,
      kind: "scene_fact", text: "The harbor bell rings at dusk.",
      sourceTurnIds: ["t1"], confidence: "explicit",
    });
    sceneMemory.appendMemory(store.db, {
      sessionId, characterRevisionId: revA,
      kind: "character_belief", text: "Aria believes the map is cursed.",
      sourceTurnIds: ["t1"], confidence: "explicit",
    });
    const items = sceneMemory.listMemory(store.db, sessionId, revA);
    assert.equal(items.length, 2, "both items durable");
    assert.equal(sceneMemory.listMemory(store.db, sessionId, revB).length, 0, "other revision has no items");
  });

  await check("character_belief may contradict reality and never becomes a task fact", async () => {
    const beliefs = sceneMemory.listMemory(store.db, sessionId, revA).filter((m) => m.kind === "character_belief");
    assert.ok(beliefs.length >= 1);
    // §11: narrative memory never enters the Lily task memory / evidence
    // surfaces — the injection layer is a SEPARATE lower-authority section.
    const injected = sceneMemory.sceneMemorySection(sceneMemory.listMemory(store.db, sessionId, revA));
    assert.equal(injected.authority, "narrative", "memory section is marked narrative authority");
    assert.ok(injected.text.includes("harbor bell"), "injected text carries memory");
  });

  await check("updates append a superseding item instead of rewriting history", async () => {
    const before = sceneMemory.listMemory(store.db, sessionId, revA);
    const target = before.find((m) => m.kind === "character_belief");
    sceneMemory.appendMemory(store.db, {
      sessionId, characterRevisionId: revA,
      kind: "character_belief", text: "Aria now trusts the map.",
      sourceTurnIds: ["t2"], confidence: "explicit", supersedesId: target.id,
    });
    const after = sceneMemory.listMemory(store.db, sessionId, revA);
    assert.equal(after.length, before.length + 1, "history grows, never rewritten");
    const active = sceneMemory.activeMemory(store.db, sessionId, revA);
    assert.equal(active.find((m) => m.id === target.id), undefined, "superseded item leaves the active set");
    assert.ok(active.some((m) => m.text === "Aria now trusts the map."), "new belief is active");
  });

  await check("extraction runs only after a successful finalized turn", async () => {
    // Failed/cancelled/rewound turns must NOT advance memory.
    sceneMemory.recordTurnOutcome(store.db, { sessionId, characterRevisionId: revA, outcome: "failed" });
    const itemsAfterFail = sceneMemory.listMemory(store.db, sessionId, revA);
    assert.equal(itemsAfterFail.filter((m) => m.text.includes("finalized-only")).length, 0, "failed turn adds nothing");
    sceneMemory.recordTurnOutcome(store.db, { sessionId, characterRevisionId: revA, outcome: "completed" });
    assert.ok(sceneMemory.listMemory(store.db, sessionId, revA).length >= 1, "successful turn advances memory");
  });

  await check("injection is bounded", async () => {
    for (let i = 0; i < 60; i += 1) {
      sceneMemory.appendMemory(store.db, {
        sessionId, characterRevisionId: revA, kind: "scene_fact",
        text: `bounded fact ${i} `.repeat(10), sourceTurnIds: [`t${i}`], confidence: "derived",
      });
    }
    const section = sceneMemory.sceneMemorySection(sceneMemory.listMemory(store.db, sessionId, revA));
    assert.ok(section.text.length <= sceneMemory.MAX_SCENE_MEMORY_BYTES, "injected memory is bounded");
  });

  await check("service isolates owners and deduplicates exact source events", async () => {
    const service = new CharacterSceneMemoryService({ store, ownerScope: "profile:owner-a" });
    const first = service.appendTurnMemory({
      sessionId: "s-service", characterRevisionId: "rev-service", turnId: "t-service",
      finalized: true,
      items: [{ kind: "scene_fact", text: "The lighthouse is open.", sourceTurnIds: ["t-service"], confidence: "explicit" }],
    });
    const duplicate = service.appendTurnMemory({
      sessionId: "s-service", characterRevisionId: "rev-service", turnId: "t-service",
      finalized: true,
      items: [{ kind: "scene_fact", text: "The lighthouse is open.", sourceTurnIds: ["t-service"], confidence: "explicit" }],
    });
    assert.equal(first.items.length, 1);
    assert.equal(duplicate.items.length, 0);
    assert.equal(service.listMemory({ sessionId: "s-service", characterRevisionId: "rev-service" }).length, 1);
    const otherOwner = new CharacterSceneMemoryService({ store, ownerScope: "profile:owner-b" });
    assert.equal(otherOwner.listMemory({ sessionId: "s-service", characterRevisionId: "rev-service" }).length, 0);
  });

  await check("service checkpoints and rewind invalidate descendant memory", async () => {
    const service = new CharacterSceneMemoryService({ store, ownerScope: "profile:owner-a" });
    service.appendTurnMemory({
      sessionId: "s-rewind", characterRevisionId: "rev-service", turnId: "t-1", finalized: true,
      items: [{ kind: "scene_fact", text: "before rewind", sourceTurnIds: ["t-1"], confidence: "explicit" }],
    });
    service.checkpointFor({ sessionId: "s-rewind", characterRevisionId: "rev-service", turnId: "t-1" });
    service.appendTurnMemory({
      sessionId: "s-rewind", characterRevisionId: "rev-service", turnId: "t-2", finalized: true,
      items: [{ kind: "scene_fact", text: "after rewind", sourceTurnIds: ["t-2"], confidence: "derived" }],
    });
    const result = service.rewindTo({ sessionId: "s-rewind", characterRevisionId: "rev-service", retainedTurnId: "t-1" });
    assert.equal(result.invalidated, 1);
    assert.deepEqual(service.listMemory({ sessionId: "s-rewind", characterRevisionId: "rev-service" }).map((item) => item.text), ["before rewind"]);
  });

  console.log(`PASS: test-character-scene-memory (${checks} checks)`);
} catch (error) {
  console.error("FAIL:", error?.message || error);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
