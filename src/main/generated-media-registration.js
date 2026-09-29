"use strict";

// A generated file is registered (content fingerprint) the moment the tool
// that made it finishes, wherever its output_dir put it. Without that the
// registry knew only files under generated-assets/: an image generated into
// output/…/images/ and renamed to cover.png six seconds later by the agent
// was lost — "在文件夹中显示" said the file did not exist, and the picture
// broke on reload (2026-09-30). With the fingerprint recorded, a missing path
// resolves to the renamed file (artifact-registry.js).
const fs = require("node:fs");
const path = require("node:path");
const { getLogger } = require("./logger");
const { registerArtifactPath } = require("./artifact-registry");

const log = getLogger("generated-media-registration");
const MARKER_BLOCK = /<generated_media\b[^>]*>([\s\S]*?)<\/generated_media>/g;
const FILE_PATH = /<file\s+path=\\?"([^"\\]+)\\?"/g;

function textOf(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value ?? ""); } catch { return ""; }
}

/** Paths a tool result's complete generated_media markers name. */
function generatedMediaPaths(result) {
  const text = textOf(result).slice(0, 200_000);
  const paths = [];
  for (const block of text.matchAll(MARKER_BLOCK)) {
    for (const file of block[1].matchAll(FILE_PATH)) paths.push(file[1]);
  }
  return [...new Set(paths)];
}

function workspaceFor(ctx, sessionId) {
  try {
    const session = ctx?.sessionManager?.findById?.(sessionId);
    const project = session?.projectId ? ctx?.projectManager?.find?.(session.projectId) : null;
    return project?.path ? path.resolve(project.path) : "";
  } catch {
    return "";
  }
}

function registerGeneratedMediaFromTool(ctx, sessionId, tool = {}) {
  if (/fail|error|cancel/i.test(String(tool.status || ""))) return [];
  const files = generatedMediaPaths(tool.result);
  if (!files.length) return [];
  const workspacePath = workspaceFor(ctx, sessionId);
  if (!workspacePath) return [];
  const registered = [];
  for (const file of files) {
    if (!path.isAbsolute(file) || !fs.existsSync(file)) continue;
    const result = registerArtifactPath(file, { workspacePath });
    if (result.ok) registered.push(result.artifactId);
    else if (result.error !== "OUTSIDE_WORKSPACE") log.warn("generated media not registered: %s (%s)", file, result.error);
  }
  return registered;
}

module.exports = { generatedMediaPaths, registerGeneratedMediaFromTool };
