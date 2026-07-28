#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

assert.equal(
  pkg.build.win.artifactName,
  "LilyWorkbench-${version}-${arch}.${ext}",
  "Windows installer artifact names must contain no spaces for Microsoft Store URL validation",
);
assert.equal(
  pkg.build.dmg.artifactName,
  "${productName}-${version}-${arch}.${ext}",
  "the Windows Store naming constraint must not rename macOS artifacts",
);

const {
  releaseArtifactName,
} = await import("./lib/release-artifact-naming.mjs");

assert.equal(
  releaseArtifactName("win32-x64", "Lily Workbench", "0.1.144", "exe"),
  "LilyWorkbench-0.1.144-x64.exe",
);
assert.equal(
  releaseArtifactName("darwin-arm64", "Lily Workbench", "0.1.144", "dmg"),
  "Lily Workbench-0.1.144-arm64.dmg",
);
assert.equal(
  releaseArtifactName("darwin-x64", "Lily Workbench", "0.1.144", "zip"),
  "Lily Workbench-0.1.144-x64.zip",
);

console.log("release-artifact-naming: ok");
