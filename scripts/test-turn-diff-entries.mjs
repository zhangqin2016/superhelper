#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addDiffEntry,
  clearDiffEntries,
  resolveTurnDiffEntries,
} from "../src/renderer/modules/diff-panel.js";

globalThis.CSS = {
  escape(value) {
    return String(value);
  },
};

globalThis.document = {
  getElementById() {
    return null;
  },
  querySelector() {
    return null;
  },
};

const inline = [{ filePath: "/tmp/inline.txt", fileName: "inline.txt", status: "modified" }];
assert.equal(
  resolveTurnDiffEntries({ turnId: "turn_1", fileChanges: inline }, "session_1"),
  inline,
  "liveTurn.fileChanges should remain the first source of turn diff entries",
);

assert.deepEqual(
  resolveTurnDiffEntries({ turnId: "missing" }, "session_1"),
  [],
  "missing session diff state should resolve to an empty list",
);

addDiffEntry("session_1", {
  turnId: "turn_2",
  filePath: "/tmp/from-session.txt",
  fileName: "from-session.txt",
  status: "modified",
});
assert.deepEqual(
  resolveTurnDiffEntries({ turnId: "turn_2", fileChanges: [] }, "session_1").map((entry) => entry.filePath),
  ["/tmp/from-session.txt"],
  "turn diff entries should fall back to session diff state when liveTurn.fileChanges is empty",
);

assert.deepEqual(
  resolveTurnDiffEntries({ turnId: "turn_2" }, ""),
  [],
  "turn diff entries should be empty without a session id",
);

clearDiffEntries("session_1");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererSource = fs.readFileSync(
  path.join(__dirname, "../src/renderer/modules/turn-view-renderer.js"),
  "utf8",
);
assert.equal(
  rendererSource.includes("function resolveTurnDiffEntries"),
  false,
  "turn-view-renderer should consume the diff resolver instead of owning it",
);

console.log("turn-diff-entries: ok");
