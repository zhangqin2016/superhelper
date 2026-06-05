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
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("diff-capture: ok");
