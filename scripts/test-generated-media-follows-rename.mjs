#!/usr/bin/env node
// A generated image the agent renames afterwards is still found — by "在文件夹中
// 显示", by "打开" and by the picture itself. Field case 2026-09-30: an image
// generated into output/…/images/ (its own output_dir, not generated-assets/)
// was renamed to cover.png by a later tool call; nothing had registered it and
// recovery looked only in generated-assets/, so reveal said "文件不存在".
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { generatedMediaPaths, registerGeneratedMediaFromTool } = require("../src/main/generated-media-registration.js");
const { resolveArtifactReference } = require("../src/main/artifact-registry.js");
const { createTurnRuntimeEventRouter } = require("../src/main/turn-runtime-event-router.js");

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lily-media-rename-")));
const imagesDir = path.join(workspace, "output", "城市轨道交通客流智能分析平台", "images");
fs.mkdirSync(imagesDir, { recursive: true });
const ctx = {
  sessionManager: { findById: (id) => (id === "s1" ? { id, projectId: "p1" } : null) },
  projectManager: { find: (id) => (id === "p1" ? { id, path: workspace } : null) },
};
const marker = (file) => `已生成\n<generated_media type="image">\n  <file path="${file}" bytes="12" />\n</generated_media>\n`;

try {
  // The marker as it reaches the router: raw, and inside a JSON-encoded result.
  assert.deepEqual(generatedMediaPaths(marker("/a/b.png")), ["/a/b.png"]);
  assert.deepEqual(generatedMediaPaths({ output: marker("/a/b.png") }), ["/a/b.png"]);
  assert.deepEqual(generatedMediaPaths('<generated_media type="image"><file path="/a/c.png"'), [], "an unfinished marker names nothing");

  // Through the real router: the tool finishing registers the file.
  const original = path.join(imagesDir, "image-1-2026-09-29T17-31-21-334Z-5a3806.png");
  fs.writeFileSync(original, "png-bytes-01");
  const state = { turnId: "t1", phase: "streaming", assistantText: "", contentBlocks: [], protocolUnknown: [], processEvents: [], notices: [],
    tools: new Map(), blockIndexToToolId: new Map(), pendingPermissions: new Map(), pendingQuestions: new Map(), pendingHooks: new Map(), timeline: [] };
  const router = createTurnRuntimeEventRouter({ ctx, getState: () => state, emit: () => null, taskRunRuntime: {}, subagentRuntime: {}, now: () => 1 });
  router.applyDraft("s1", { type: "tool.started", payload: { id: "tool_1", name: "bash", input: { command: "generate_image" } } });
  router.applyDraft("s1", { type: "tool.done", payload: { id: "tool_1", status: "done", result: marker(original) } });

  // Six seconds later the agent renames it in place.
  const renamed = path.join(imagesDir, "cover.png");
  fs.renameSync(original, renamed);
  const found = resolveArtifactReference({ workspacePath: workspace, path: original });
  assert.equal(found.ok, true, `the old path resolves after the rename (${found.error})`);
  assert.equal(found.path, renamed, "to the renamed file, by content");

  // Moved into generated-assets/ still resolves, as before.
  const assets = path.join(workspace, "generated-assets");
  fs.mkdirSync(assets);
  fs.renameSync(renamed, path.join(assets, "moved.png"));
  assert.equal(resolveArtifactReference({ workspacePath: workspace, path: original }).path, path.join(assets, "moved.png"));

  // Never a guess: a different picture of the same size is not "the file".
  const other = path.join(imagesDir, "image-2.png");
  fs.writeFileSync(other, "png-bytes-02");
  assert.equal(registerGeneratedMediaFromTool(ctx, "s1", { status: "done", result: marker(other) }).length, 1);
  fs.rmSync(other);
  fs.writeFileSync(path.join(imagesDir, "impostor.png"), "png-bytes-99");
  assert.equal(resolveArtifactReference({ workspacePath: workspace, path: other }).ok, false, "same size, other content: not found");

  // A failed tool registers nothing; a session without a workspace fails open.
  const failed = path.join(imagesDir, "failed.png");
  fs.writeFileSync(failed, "x");
  assert.deepEqual(registerGeneratedMediaFromTool(ctx, "s1", { status: "failed", result: marker(failed) }), []);
  assert.deepEqual(registerGeneratedMediaFromTool(ctx, "nope", { status: "done", result: marker(failed) }), []);
  console.log("test-generated-media-follows-rename: ok");
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
