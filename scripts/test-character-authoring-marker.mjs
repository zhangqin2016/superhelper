import assert from "node:assert/strict";
import {
  clearCharacterAuthoringMarker,
  readCharacterAuthoringMarker,
  restoreCharacterAuthoringMarker,
} from "../src/renderer/modules/character-authoring-marker.js";

const input = { dataset: { characterAuthoringKind: "worldBook", characterAuthoringStarter: "Design a world" } };
const marker = readCharacterAuthoringMarker(input, "Design a world\nwith floating cities");
assert.deepEqual(marker, { kind: "worldBook", starter: "Design a world" });
assert.equal(readCharacterAuthoringMarker(input, "Write a report"), null);
clearCharacterAuthoringMarker(input);
assert.deepEqual(input.dataset, {});
restoreCharacterAuthoringMarker(input, marker);
assert.equal(input.dataset.characterAuthoringKind, "worldBook");

console.log("PASS: test-character-authoring-marker");
