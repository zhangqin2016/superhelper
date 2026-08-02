import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildCharacterAuthoringEngineText,
  inferCharacterAuthoringIntent,
} = require("../src/main/character-worlds/authoring-intent.js");
const {
  createQueueRecoveryEnvelope,
  normalizeQueueRecoveryEnvelope,
} = require("../src/main/turn-queue-recovery-envelope.js");

const character = inferCharacterAuthoringIntent("帮我创建一个长期陪伴角色");
assert.deepEqual(character, { active: true, kind: "character" });

const persona = inferCharacterAuthoringIntent("让 Lily 帮我设计一个适合我的人设");
assert.deepEqual(persona, { active: true, kind: "persona" });

const worldBook = inferCharacterAuthoringIntent("创建一个赛博朋克世界观和世界书");
assert.deepEqual(worldBook, { active: true, kind: "worldBook" });

assert.deepEqual(
  inferCharacterAuthoringIntent("帮我写一份角色设计分析报告.md"),
  { active: false, kind: null },
  "document authoring must not be rerouted into the character library",
);
assert.deepEqual(
  inferCharacterAuthoringIntent("分析一下这个角色为什么写得好"),
  { active: false, kind: null },
  "analysis is not creation",
);
assert.deepEqual(
  inferCharacterAuthoringIntent("帮我创建角色管理功能"),
  { active: false, kind: null },
  "software feature requests must not become library characters",
);

const engineText = buildCharacterAuthoringEngineText("帮我创建一个长期陪伴角色", character);
assert.match(engineText, /lily_character_draft/);
assert.match(engineText, /kind=character/);
assert.match(engineText, /must call/i);
assert.match(engineText, /Markdown/i);
assert.match(engineText, /ok:true/i);
assert.match(engineText, /帮我创建一个长期陪伴角色/);

const recovery = createQueueRecoveryEnvelope({
  item: { id: "queue-character-authoring", displayFiles: [] },
  options: {
    engineText,
    requiredSuccessfulTools: ["lily_character_draft"],
  },
});
assert.deepEqual(
  normalizeQueueRecoveryEnvelope(recovery).options.requiredSuccessfulTools,
  ["lily_character_draft"],
  "required persistence tools survive durable queue recovery",
);

console.log("PASS: test-character-authoring-intent");
