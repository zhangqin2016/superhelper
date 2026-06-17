#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-skillpack-test-"));
const skillDir = path.join(tmp, "lily-test-skill");
const outDir = path.join(tmp, "out");
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Test Skill\n\nUse for tests.\n", "utf8");
fs.writeFileSync(
  path.join(skillDir, "skill.manifest.json"),
  JSON.stringify({ id: "lily-test-skill", name: "Test Skill", version: "1.2.3" }, null, 2),
  "utf8",
);

const stdout = execFileSync(
  process.execPath,
  [path.join(ROOT, "scripts/build-skill-pack.mjs"), "--skill", skillDir, "--out", outDir],
  { cwd: ROOT, encoding: "utf8" },
);
const meta = JSON.parse(stdout);
assert.equal(meta.skillId, "lily-test-skill");
assert.equal(meta.version, "1.2.3");
assert.equal(meta.fileCount, 2);
assert.ok(fs.existsSync(meta.artifactPath), "skill pack artifact should be written");

const bytes = fs.readFileSync(meta.artifactPath);
assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), meta.sha256);
assert.equal(bytes.length, meta.sizeBytes);

const zip = await JSZip.loadAsync(bytes);
assert.ok(zip.file("SKILL.md"), "skill pack must include SKILL.md at root");
assert.ok(zip.file("skill.manifest.json"), "skill pack must include manifest at root");
const normalizedManifest = JSON.parse(await zip.file("skill.manifest.json").async("string"));
assert.equal(normalizedManifest.schemaVersion, 1);
assert.equal(normalizedManifest.id, "lily-test-skill");
assert.equal(normalizedManifest.permissions.filesystem, "none");

const noManifestDir = path.join(tmp, "lily-no-manifest");
fs.mkdirSync(noManifestDir, { recursive: true });
fs.writeFileSync(path.join(noManifestDir, "SKILL.md"), "# No Manifest\n\nUse for pack tests.\n", "utf8");

const noManifestStdout = execFileSync(
  process.execPath,
  [path.join(ROOT, "scripts/build-skill-pack.mjs"), "--skill", noManifestDir, "--out", outDir],
  { cwd: ROOT, encoding: "utf8" },
);
const noManifestMeta = JSON.parse(noManifestStdout);
assert.equal(noManifestMeta.skillId, "lily-no-manifest");
assert.equal(noManifestMeta.version, "1.0.0");
assert.equal(noManifestMeta.fileCount, 2);
const noManifestZip = await JSZip.loadAsync(fs.readFileSync(noManifestMeta.artifactPath));
const synthesizedManifest = JSON.parse(await noManifestZip.file("skill.manifest.json").async("string"));
assert.equal(synthesizedManifest.schemaVersion, 1);
assert.equal(synthesizedManifest.id, "lily-no-manifest");
assert.equal(synthesizedManifest.name, "lily-no-manifest");

const webSystemLearningDir = path.join(ROOT, "resources/skills-catalog/lily-web-system-learning");
if (fs.existsSync(webSystemLearningDir)) {
  const expectedManifest = JSON.parse(fs.readFileSync(path.join(webSystemLearningDir, "skill.manifest.json"), "utf8"));
  const webSystemStdout = execFileSync(
    process.execPath,
    [path.join(ROOT, "scripts/build-skill-pack.mjs"), "--skill", webSystemLearningDir, "--out", outDir],
    { cwd: ROOT, encoding: "utf8" },
  );
  const webSystemMeta = JSON.parse(webSystemStdout);
  assert.equal(webSystemMeta.skillId, "lily-web-system-learning");
  assert.equal(webSystemMeta.version, expectedManifest.version);
  assert.ok(webSystemMeta.fileCount >= 4, "web system learning pack should include scripts and manifest");
}

const pycacheDir = path.join(tmp, "lily-pycache");
fs.mkdirSync(path.join(pycacheDir, "__pycache__"), { recursive: true });
fs.writeFileSync(path.join(pycacheDir, "SKILL.md"), "# Pycache\n\nUse for pack tests.\n", "utf8");
fs.writeFileSync(path.join(pycacheDir, "__pycache__", "scan.cpython-312.pyc"), "cache", "utf8");
const blockedPycache = spawnSync(
  process.execPath,
  [path.join(ROOT, "scripts/build-skill-pack.mjs"), "--skill", pycacheDir, "--out", outDir],
  { cwd: ROOT, encoding: "utf8" },
);
assert.notEqual(blockedPycache.status, 0);
assert.match(blockedPycache.stderr, /blocked directory/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("build-skill-pack: ok");
