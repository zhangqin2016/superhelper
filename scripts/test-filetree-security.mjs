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
const { inspectLocalMediaPath } = require("../src/main/local-media-protocol.js");
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

// 8. local media diagnostics distinguish "exists but not authorized" from
// "not found", so the renderer never has to render a misleading broken image.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ft-user-data-"));
process.env.LILY_USER_DATA_DIR = userData;
fs.writeFileSync(path.join(userData, "projects.json"), JSON.stringify({
  projects: [{ id: "p1", path: projectRoot }],
}, null, 2));
const mediaOk = inspectLocalMediaPath(generated);
assert(mediaOk.ok === true && mediaOk.error === "", "authorized existing media is diagnosable as ok");
assert(mediaOk.url.startsWith("app-file://media/"), "diagnostic includes canonical app-file URL");
assert(mediaOk.artifactId, "generated media status registers a stable artifact id");
const unauthorizedImage = path.join(outside, "image.png");
fs.writeFileSync(unauthorizedImage, "png");
const mediaUnauthorized = inspectLocalMediaPath(unauthorizedImage);
assert(mediaUnauthorized.ok === false && mediaUnauthorized.error === "NOT_AUTHORIZED", "existing outside-root media reports NOT_AUTHORIZED");
const mediaMissing = inspectLocalMediaPath(path.join(projectRoot, "missing.png"));
assert(mediaMissing.ok === false && mediaMissing.error === "NOT_FOUND", "missing media reports NOT_FOUND");

// 9. Generated media may be renamed by the agent after the generation tool emits
// the first image-*.png path. Preview/reveal should recover within the same
// generated-assets directory instead of leaving a broken card, but ordinary
// missing files must still fail closed (covered by the assertion above).
const staleGenerated = path.join(projectRoot, "generated-assets", "image-1-2026-07-03T11-34-23-346Z-1fd770.png");
const renamedGenerated = path.join(projectRoot, "generated-assets", "scene1-mountains.png");
fs.writeFileSync(renamedGenerated, "renamed-png");
const renamedMtime = new Date("2026-07-03T11:34:23.500Z");
fs.utimesSync(renamedGenerated, renamedMtime, renamedMtime);

const mediaRecovered = inspectLocalMediaPath(staleGenerated);
assert(mediaRecovered.ok === true, "missing generated image should recover to a renamed sibling");
assert(mediaRecovered.path === renamedGenerated, "recovered media status returns the existing renamed path");
assert(mediaRecovered.originalPath === staleGenerated, "recovered media status preserves original stale path");
assert(mediaRecovered.recovered === true, "recovered media status is explicit");

// 10. Windows shells can mangle non-ASCII workspace segments in tool stdout into
// question marks. If the generated media filename survives, recover from the
// authorized workspace's generated-assets directory instead of leaving preview broken.
const chineseNameGenerated = path.join(projectRoot, "generated-assets", "image-1-2026-07-03T11-34-25-000Z-cn.png");
fs.writeFileSync(chineseNameGenerated, "cn-png");
const mangledOutputPath = path.join(path.dirname(projectRoot), "????", "generated-assets", path.basename(chineseNameGenerated));
const mediaRecoveredFromMangledOutput = inspectLocalMediaPath(mangledOutputPath);
assert(mediaRecoveredFromMangledOutput.ok === true, "mangled generated media output path should recover by filename");
assert(mediaRecoveredFromMangledOutput.path === chineseNameGenerated, "mangled output recovery returns the real workspace file");
assert(mediaRecoveredFromMangledOutput.originalPath === mangledOutputPath, "mangled output recovery preserves original bad path");
assert(mediaRecoveredFromMangledOutput.recovered === true, "mangled output recovery is explicit");

const registeredOriginal = path.join(projectRoot, "generated-assets", "image-1-2026-07-03T11-34-24-000Z-registered.png");
const registeredRenamed = path.join(projectRoot, "generated-assets", "registered-scene.png");
fs.writeFileSync(registeredOriginal, "registered-image-bytes");
const registeredBeforeRename = inspectLocalMediaPath(registeredOriginal);
assert(registeredBeforeRename.ok === true && registeredBeforeRename.artifactId, "existing generated media is registered before rename");
fs.renameSync(registeredOriginal, registeredRenamed);
const registeredAfterRename = inspectLocalMediaPath(registeredOriginal);
assert(registeredAfterRename.ok === true, "manifest-registered media resolves after rename");
assert(registeredAfterRename.path === registeredRenamed, "manifest resolver returns the renamed media path");
assert(registeredAfterRename.artifactId === registeredBeforeRename.artifactId, "manifest resolver preserves artifact id across rename");

revealed.length = 0;
res = await reveal(null, { sessionId, filePath: staleGenerated });
assert(res.ok === true && res.path === renamedGenerated, "reveal recovers renamed generated media");
assert(revealed.includes(renamedGenerated), "reveal opens the recovered generated media file");

fs.rmSync(projectRoot, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });
fs.rmSync(userData, { recursive: true, force: true });
console.log("PASS: test-filetree-security");
