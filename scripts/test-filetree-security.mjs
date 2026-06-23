#!/usr/bin/env node
/**
 * filetree IPC security: reject-change must take original content/status from
 * the MAIN-PROCESS diff record (never renderer input), refuse files without a
 * diff record, refuse paths outside the session's project, and the unused
 * arbitrary-write handler filetree:restore-file must not exist at all.
 */
import module from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);

// Mock electron: capture registered handlers so we can invoke them directly.
const handlers = new Map();
const revealed = [];
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    shell: {
      showItemInFolder(filePath) { revealed.push(filePath); },
      openPath(filePath) { revealed.push(filePath); return ""; },
    },
  },
};

const { registerFileTreeHandlers } = require("../src/main/ipc-filetree.js");
const { captureBeforeSnapshot, emitDiffForTool } = require("../src/main/diff-capture.js");

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ft-proj-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ft-out-"));
const sessionId = "sess_sec";

registerFileTreeHandlers({
  sessionManager: { findById: (id) => (id === sessionId ? { id, projectId: "p1" } : null) },
  projectManager: { find: (id) => (id === "p1" ? { id, path: projectRoot } : null) },
});

const reject = handlers.get("filetree:reject-change");
const revert = handlers.get("filetree:revert-turn");
const reveal = handlers.get("filetree:reveal");
const open = handlers.get("filetree:open");
assert(typeof reject === "function", "reject-change handler registered");
assert(typeof revert === "function", "revert-turn handler registered");
assert(typeof reveal === "function", "reveal handler registered");
assert(typeof open === "function", "open handler registered");
assert(!handlers.has("filetree:restore-file"), "arbitrary-write restore-file handler removed");

function recordDiff(filePath, before, after) {
  const toolId = `tool_${path.basename(filePath)}`;
  if (before != null) fs.writeFileSync(filePath, before);
  captureBeforeSnapshot(sessionId, toolId, "Write", { file_path: filePath });
  fs.writeFileSync(filePath, after);
  emitDiffForTool(sessionId, toolId, { mainWindow: null }, "turn1");
}

// 1. no diff record -> refused, nothing written
const victim = path.join(projectRoot, "no-record.txt");
let res = await reject(null, { sessionId, filePath: victim, content: "attacker", status: "modified" });
assert(res.ok === false && res.error === "NO_DIFF_RECORD", "no diff record refused");
assert(!fs.existsSync(victim), "refused reject writes nothing");

// 2. renderer-supplied content is ignored — server-side original wins
const modified = path.join(projectRoot, "mod.txt");
recordDiff(modified, "original\n", "agent-edit\n");
res = await reject(null, { sessionId, filePath: modified, content: "attacker-content", status: "modified" });
assert(res.ok === true, "legit reject succeeds");
assert(fs.readFileSync(modified, "utf-8") === "original\n", "restores SERVER-side original, ignores renderer content");

// 3. added file -> deleted on reject (status from server record, not renderer)
const added = path.join(projectRoot, "added.txt");
recordDiff(added, null, "new file\n");
res = await reject(null, { sessionId, filePath: added, content: null, status: "modified" });
assert(res.ok === true && !fs.existsSync(added), "added file deleted using server-side status");

// 4. diff record outside the project root -> contained check refuses
const escapee = path.join(outside, "escape.txt");
recordDiff(escapee, "original\n", "agent-edit\n");
res = await reject(null, { sessionId, filePath: escapee });
assert(res.ok === false && res.error === "PATH_OUTSIDE_PROJECT", "outside-project path refused");
assert(fs.readFileSync(escapee, "utf-8") === "agent-edit\n", "outside file untouched");

// 5. whole-turn revert must apply the same containment rule, not write the
// outside file through diff-capture's lower-level revert helper.
res = revert(null, { sessionId, turnId: "turn1" });
assert(res.ok === false, "turn revert with outside-project diff refused");
assert(fs.readFileSync(escapee, "utf-8") === "agent-edit\n", "turn revert leaves outside file untouched");

// 6. unknown session -> no project root -> refused
res = await reject(null, { sessionId: "ghost", filePath: modified });
assert(res.ok === false, "unknown session refused");

// 7. reveal only accepts absolute local paths. Generated media scripts must
// emit absolute paths; renderer/main must not guess a base directory.
const generated = path.join(projectRoot, "generated-assets", "image.png");
fs.mkdirSync(path.dirname(generated), { recursive: true });
fs.writeFileSync(generated, "png");
res = await reveal(null, { sessionId, filePath: generated });
assert(res.ok === true, "absolute generated output reveal succeeds");
assert(revealed.includes(generated), "absolute reveal opens generated file");

revealed.length = 0;
res = await reveal(null, { sessionId, filePath: `file://${generated}` });
assert(res.ok === true, "file URL generated output reveal succeeds");
assert(revealed.includes(generated), "file URL reveal opens generated file");

revealed.length = 0;
res = await open(null, { sessionId, filePath: generated });
assert(res.ok === true, "absolute generated output open succeeds");
assert(revealed.includes(generated), "absolute open opens generated file");

res = await open(null, { sessionId, filePath: "generated-assets/image.png" });
assert(res.ok === false, "relative generated output open refused");

res = await reveal(null, { sessionId, filePath: "../escape.txt" });
assert(res.ok === false, "relative reveal refused");

res = await reveal(null, { sessionId, filePath: "generated-assets/image.png" });
assert(res.ok === false, "relative generated output reveal refused");

fs.rmSync(projectRoot, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });
console.log("PASS: test-filetree-security");
