import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  registerArtifactPath,
  resolveArtifactReference,
  workspaceManifestPath,
} = require("../src/main/artifact-registry.js");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lily-artifact-registry-"));
const generatedDir = path.join(workspace, "generated-assets");
fs.mkdirSync(generatedDir, { recursive: true });

try {
  const original = path.join(generatedDir, "image-1-2026-07-03T11-34-23-346Z-1fd770.png");
  const renamed = path.join(generatedDir, "scene1-mountains.png");
  fs.writeFileSync(original, "same-image-bytes");

  const registered = registerArtifactPath(original, {
    workspacePath: workspace,
    sessionId: "sess_a",
    turnId: "turn_a",
    kind: "image",
  });
  assert.equal(registered.ok, true, "generated artifact registration succeeds");
  assert.match(registered.artifactId, /^art_/, "registration returns stable artifactId");
  assert.equal(registered.currentPath, original);
  assert.equal(fs.existsSync(workspaceManifestPath(workspace)), true, "workspace manifest is persisted");

  fs.renameSync(original, renamed);

  const byOldPath = resolveArtifactReference({
    workspacePath: workspace,
    path: original,
  });
  assert.equal(byOldPath.ok, true, "old generated path resolves after rename");
  assert.equal(byOldPath.path, renamed, "resolver returns renamed path");
  assert.equal(byOldPath.artifactId, registered.artifactId, "resolver preserves artifact identity");
  assert.equal(byOldPath.recovered, true, "resolver marks recovered path");

  const byId = resolveArtifactReference({
    workspacePath: workspace,
    artifactId: registered.artifactId,
  });
  assert.equal(byId.ok, true, "artifactId resolves after rename");
  assert.equal(byId.path, renamed, "artifactId returns current renamed path");

  const ordinaryMissing = resolveArtifactReference({
    workspacePath: workspace,
    path: path.join(workspace, "notes", "missing.png"),
  });
  assert.equal(ordinaryMissing.ok, false, "ordinary missing file is not guessed");
  assert.equal(ordinaryMissing.error, "NOT_FOUND");

  const outside = path.join(os.tmpdir(), "outside-lily-artifact-registry.png");
  fs.writeFileSync(outside, "outside");
  const outsideResult = registerArtifactPath(outside, { workspacePath: workspace });
  assert.equal(outsideResult.ok, false, "outside workspace artifact registration fails closed");
  assert.equal(outsideResult.error, "OUTSIDE_WORKSPACE");
  fs.rmSync(outside, { force: true });

  console.log("artifact registry ok");
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
