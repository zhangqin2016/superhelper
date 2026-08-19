import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildLibraryActivationConfig } = require(
  "../src/main/character-worlds/library-activation.js",
);

const current = {
  characterRevisionId: "char-rev-1",
  personaRevisionId: "persona-rev-1",
  books: [
    { scope: "chat", worldBookRevisionId: "book-rev-1", mergeStrategy: "constant" },
    { scope: "persona", worldBookRevisionId: "book-rev-2", mergeStrategy: "keyed" },
  ],
  greetingIndex: 2,
};

assert.deepEqual(
  buildLibraryActivationConfig(current, { kind: "character", revisionId: "char-rev-2" }),
  {
    characterRevisionId: "char-rev-2",
    personaRevisionId: "persona-rev-1",
    books: current.books,
    greetingIndex: 2,
    sceneId: null,
    groupId: null,
  },
);

assert.throws(
  () => buildLibraryActivationConfig(current, { kind: "persona", revisionId: "persona-rev-2" }),
  (error) => error.code === "FEATURE_DISABLED",
);
assert.throws(
  () => buildLibraryActivationConfig(current, {
    kind: "worldBook",
    revisionId: "book-rev-3",
    scope: "chat",
    mergeStrategy: "keyed",
  }),
  (error) => error.code === "FEATURE_DISABLED",
);

assert.throws(
  () => buildLibraryActivationConfig(current, { kind: "unknown", revisionId: "x" }),
  /Unsupported library activation kind/,
);
assert.throws(
  () => buildLibraryActivationConfig(current, { kind: "worldBook", revisionId: "x", scope: "nope" }),
  (error) => error.code === "FEATURE_DISABLED",
);

console.log("PASS: test-character-library-activation");
