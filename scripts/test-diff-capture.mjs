#!/usr/bin/env node

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
  captureBeforeSnapshot,
  emitDiffForTool,
  getDiffsForTurn,
  clearDiffsForSession,
  revertTurnChanges,
  undoRevertTurn,
} = require("../src/main/diff-capture.js");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diff-capture-test-"));
const sessionId = "sess_test";
const turnId = "turn_abc";
const toolId = "tool_write_1";
const filePath = path.join(tmpDir, "demo.txt");

fs.writeFileSync(filePath, "old line\n", "utf-8");
captureBeforeSnapshot(sessionId, toolId, "Write", { file_path: filePath });
fs.writeFileSync(filePath, "new line\n", "utf-8");

emitDiffForTool(sessionId, toolId, { mainWindow: null }, turnId);

const diffs = getDiffsForTurn(sessionId, turnId);
if (diffs.length !== 1) {
  throw new Error(`expected 1 diff for turn, got ${diffs.length}`);
}
if (diffs[0].turnId !== turnId) {
  throw new Error(`expected turnId ${turnId}, got ${diffs[0].turnId}`);
}
if (diffs[0].filePath !== filePath) {
  throw new Error("filePath mismatch");
}

const otherTurn = getDiffsForTurn(sessionId, "turn_other");
if (otherTurn.length !== 0) {
  throw new Error("diffs should be scoped per turn");
}

clearDiffsForSession(sessionId);

// Checkpoint semantics: several edits to one file in a turn keep the FIRST
// before-state, and revertTurnChanges restores it. Added files are deleted.
const revertTurnId = "turn_revert";
const editedPath = path.join(tmpDir, "edited.txt");
const addedPath = path.join(tmpDir, "added.txt");
fs.writeFileSync(editedPath, "checkpoint\n", "utf-8");

captureBeforeSnapshot(sessionId, "tool_e1", "Write", { file_path: editedPath });
fs.writeFileSync(editedPath, "first edit\n", "utf-8");
emitDiffForTool(sessionId, "tool_e1", { mainWindow: null }, revertTurnId);

captureBeforeSnapshot(sessionId, "tool_e2", "Write", { file_path: editedPath });
fs.writeFileSync(editedPath, "second edit\n", "utf-8");
emitDiffForTool(sessionId, "tool_e2", { mainWindow: null }, revertTurnId);

captureBeforeSnapshot(sessionId, "tool_a1", "Write", { file_path: addedPath });
fs.writeFileSync(addedPath, "brand new\n", "utf-8");
emitDiffForTool(sessionId, "tool_a1", { mainWindow: null }, revertTurnId);

const revertEntries = getDiffsForTurn(sessionId, revertTurnId);
const editedEntry = revertEntries.find((entry) => entry.filePath === editedPath);
if (editedEntry?.originalContent !== "checkpoint\n") {
  throw new Error(`turn checkpoint must keep the first before-state: ${JSON.stringify(editedEntry?.originalContent)}`);
}

const results = revertTurnChanges(sessionId, revertTurnId);
if (results.some((item) => !item.ok)) {
  throw new Error(`revert reported failures: ${JSON.stringify(results)}`);
}
if (fs.readFileSync(editedPath, "utf-8") !== "checkpoint\n") {
  throw new Error("edited file must restore to the turn checkpoint");
}
if (fs.existsSync(addedPath)) {
  throw new Error("added file must be deleted on revert");
}
if (getDiffsForTurn(sessionId, revertTurnId).length !== 0) {
  throw new Error("reverted diffs must be cleared");
}

// Undo brings back the pre-revert state: edits restored, added files
// recreated. The stash is one-shot.
const undone = undoRevertTurn(sessionId, revertTurnId);
if (!undone.ok) {
  throw new Error(`undo revert failed: ${JSON.stringify(undone)}`);
}
if (fs.readFileSync(editedPath, "utf-8") !== "second edit\n") {
  throw new Error("undo must restore the post-turn content");
}
if (fs.readFileSync(addedPath, "utf-8") !== "brand new\n") {
  throw new Error("undo must recreate files deleted by the revert");
}
if (undoRevertTurn(sessionId, revertTurnId).ok) {
  throw new Error("undo stash must be one-shot");
}

clearDiffsForSession(sessionId);
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("diff-capture: ok");
