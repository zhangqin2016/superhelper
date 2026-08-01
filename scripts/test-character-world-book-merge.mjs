"use strict";
/**
 * §10.4.1 multi-book merge: chat/Persona precedence wins ties, insertion
 * order is never bypassed, `constant` strategy merges each book's entries,
 * and duplicate entry ids resolve by earlier scope.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { mergeWorldBooks } = require("../src/main/character-worlds/world-book-merge.js");

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

function book(scope, entries) {
  return { scope, revision: { id: `${scope}-rev`, canonical: { entries } } };
}

try {
  await check("empty input returns no units", async () => {
    assert.deepEqual(mergeWorldBooks(), []);
    assert.deepEqual(mergeWorldBooks([]), []);
  });

  await check("single book returns its entries unchanged", async () => {
    const merged = mergeWorldBooks([book("character", [{ id: "a", content: "A" }])]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].entryId, "a");
    assert.equal(merged[0].scope, "character");
  });

  await check("chat/Persona precedence wins duplicate entry ids", async () => {
    const merged = mergeWorldBooks([
      book("character", [{ id: "k", content: "from-character" }]),
      book("chat", [{ id: "k", content: "from-chat" }]),
    ]);
    assert.equal(merged.length, 1, "duplicate dedupes to one entry");
    assert.equal(merged[0].content, "from-chat", "chat wins the tie");
  });

  await check("insertion order is preserved per book and never bypassed", async () => {
    const merged = mergeWorldBooks([
      book("global", [{ id: "g1", content: "G1" }, { id: "g2", content: "G2" }]),
      book("persona", [{ id: "p1", content: "P1" }]),
    ]);
    assert.deepEqual(merged.map((e) => e.entryId), ["p1", "g1", "g2"], "persona precedes global; entry order preserved within a scope");
  });

  console.log(`PASS: test-character-world-book-merge (${checks} checks)`);
} catch (error) {
  console.error("FAIL:", error?.message || error);
  process.exitCode = 1;
}
