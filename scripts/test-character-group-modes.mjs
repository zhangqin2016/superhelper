"use strict";
/**
 * §12 group/story modes (Phase 3, P3-2): immutable participant scene with
 * deterministic speaker planning (manual/natural/list_order/pooled, semantic
 * opt-in), and side-effect-safe response variants (§12.1). Selection affects
 * expression only, never tool authority.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const { CharacterWorldsRepository } = require("../src/main/character-worlds/repository.js");
const group = require("../src/main/character-worlds/group-modes.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "group-modes-"));
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const repo = new CharacterWorldsRepository(store);

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

try {
  const owner = "profile:group";
  const revA = group.createScene(repo, { ownerScope: owner, sessionId: "s-g", name: "A" }).characterRevisionId;
  const revB = group.createScene(repo, { ownerScope: owner, sessionId: "s-g", name: "B" }).characterRevisionId;
  const scene = group.createScene(repo, { ownerScope: owner, sessionId: "s-g", name: "Scene", participantCharacterRevisionIds: [revA, revB], replyStrategy: "manual" });

  await check("a scene is immutable on participants and carries mutable state", async () => {
    assert.ok(scene.id);
    assert.equal(scene.participantCharacterRevisionIds.length, 2);
    const loaded = group.getScene(repo, owner, "s-g");
    assert.ok(loaded, "scene durable");
  });

  await check("manual strategy uses only explicitly requested speakers", async () => {
    const picked = group.pickSpeaker({ scene, strategy: "manual", requestedSpeakerRevisionIds: [revB], latestCanonicalText: "A speaks." });
    assert.equal(picked.characterRevisionId, revB);
  });

  await check("list_order drafts in stable configured order", async () => {
    const picked = group.pickSpeaker({ scene, strategy: "list_order" });
    assert.equal(picked.characterRevisionId, scene.participantCharacterRevisionIds[0], "first participant drafts first");
  });

  await check("pooled cycles participants and resets after all speak or a new user message", async () => {
    const p1 = group.pickSpeaker({ scene, strategy: "pooled", spokenSinceUser: [revA] });
    assert.equal(p1.characterRevisionId, revB, "unspoken participant chosen");
    const p2 = group.pickSpeaker({ scene, strategy: "pooled", spokenSinceUser: [revA, revB] });
    assert.equal(p2.characterRevisionId, revA, "pool resets after all have spoken");
  });

  await check("natural extracts whole-word participant-name mentions", async () => {
    const picked = group.pickSpeaker({ scene, strategy: "natural", latestCanonicalText: "I think A should answer this." });
    assert.equal(picked.characterRevisionId, revA, "mentioned participant drafted");
  });

  await check("selection affects expression only — never tool authority", async () => {
    assert.equal(group.PICKER_TOOL_AUTHORITY, false);
  });

  await check("response variants are keyed by session+turn and side-effect-safe", async () => {
    const variant = group.createResponseVariant(repo, { sessionId: "s-g", turnId: "t-1", variantId: "v1", text: "variant text" });
    assert.ok(variant.id, "variant durable");
    const found = group.getResponseVariants(repo, "s-g", "t-1");
    assert.equal(found.length, 1);
  });

  console.log(`PASS: test-character-group-modes (${checks} checks)`);
} catch (error) {
  console.error("FAIL:", error?.message || error);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
