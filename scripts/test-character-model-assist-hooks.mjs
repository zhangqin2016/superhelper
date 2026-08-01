"use strict";
/**
 * §12.1/§11 opt-in model-assist hooks: ranker/extractor are injectable and
 * fail open to host defaults when no model runtime is present — never an
 * extra model call on the normal turn path.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { pickSemanticSpeaker } = require("../src/main/character-worlds/group-modes.js");
const { extractSceneFacts } = require("../src/main/character-worlds/scene-memory.js");

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

try {
  await check("semantic picker without a ranker returns null (host fallback)", async () => {
    assert.equal(await pickSemanticSpeaker(["a", "b"], {}), null);
    assert.equal(await pickSemanticSpeaker([], { ranker: async () => ["a"] }), null);
  });

  await check("semantic picker with a ranker prefers the ranked winner", async () => {
    const winner = await pickSemanticSpeaker(["a", "b"], {
      ranker: async (eligible) => ["b", "a"],
      context: { latestText: "..." },
    });
    assert.equal(winner, "b");
  });

  await check("fact extraction without an extractor returns nothing", async () => {
    assert.deepEqual(await extractSceneFacts("some text", {}), []);
    assert.deepEqual(await extractSceneFacts("", { extractor: async () => [{ kind: "scene_fact", text: "x" }] }), []);
  });

  await check("fact extraction with an extractor filters malformed items", async () => {
    const items = await extractSceneFacts("The bell rings.", {
      extractor: async () => [
        { kind: "scene_fact", text: "The bell rings." },
        { kind: "broken" },
      ],
    });
    assert.deepEqual(items, [{ kind: "scene_fact", text: "The bell rings." }]);
  });

  console.log(`PASS: test-character-model-assist-hooks (${checks} checks)`);
} catch (error) {
  console.error("FAIL:", error?.message || error);
  process.exitCode = 1;
}
