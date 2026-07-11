#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { PACK_SPECS } = require(path.join(ROOT, "src/main/runtime-pack-specs.js"));
const lockPath = path.join(ROOT, "resources/runtime/runtime-pack-lock.json");
assert.equal(fs.existsSync(lockPath), true, "runtime-pack lock is required");
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const targets = ["darwin-arm64", "darwin-x64", "win32-x64"];
assert.deepEqual(lock.releaseTargets, targets);
assert.deepEqual(lock.releaseRequiredPackIds, Object.keys(PACK_SPECS).sort());

const entries = Array.isArray(lock.entries) ? lock.entries : [];
const byKey = new Map();
for (const entry of entries) {
  const key = `${entry.packId}:${entry.platform}`;
  assert.equal(byKey.has(key), false, `duplicate lock entry: ${key}`);
  byKey.set(key, entry);
  assert.equal(typeof entry.version, "string");
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.equal(Number.isInteger(entry.sizeBytes) && entry.sizeBytes > 0, true);
  assert.equal(typeof entry.healthProbe, "string");
  assert.equal(entry.enabled, true);
  if (entry.packId === "web-automation") {
    assert.equal(typeof entry.components?.playwright, "string");
    assert.equal(typeof entry.components?.["@playwright/mcp"], "string");
    assert.equal(typeof entry.components?.chromiumRevision, "string");
    assert.equal(
      entry.version,
      `playwright-${entry.components.playwright}_mcp-${entry.components["@playwright/mcp"]}`,
      "web artifact version must exactly match its locked Playwright components",
    );
    assert.match(entry.components.chromiumRevision, /^\d+$/, "Chromium revision must be exact, not a floating channel");
  }
}

const missing = [];
for (const packId of lock.releaseRequiredPackIds) {
  for (const platform of targets) {
    if (!byKey.has(`${packId}:${platform}`)) missing.push(`${packId}:${platform}`);
  }
}
if (process.argv.includes("--strict") || process.argv.includes("--online")) {
  assert.deepEqual(missing, [], `release-blocking runtime-pack gaps: ${missing.join(", ")}`);
} else if (missing.length) {
  console.warn(`[runtime-pack-matrix] pending verified artifacts (${missing.length}); release preflight remains blocked`);
}

async function fetchArtifact(packId, platform) {
  const base = String(process.env.LILY_RUNTIME_PACK_API || "https://lilych.lilywb.cn").replace(/\/+$/, "");
  const url = `${base}/api/runtime-packs/artifact?packId=${encodeURIComponent(packId)}&platform=${encodeURIComponent(platform)}`;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const json = await response.json();
      if (!response.ok) throw new Error(`${response.status} ${json?.code || ""}`);
      return json.artifact;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastError;
}

if (process.argv.includes("--online")) {
  for (const entry of entries) {
    const artifact = await fetchArtifact(entry.packId, entry.platform);
    assert.ok(artifact, `production artifact missing: ${entry.packId}:${entry.platform}`);
    assert.equal(artifact.version, entry.version);
    assert.equal(String(artifact.sha256).toLowerCase(), entry.sha256);
    assert.equal(Number(artifact.sizeBytes || artifact.size), entry.sizeBytes);
    assert.equal(artifact.url, entry.url);
  }
}

console.log(`runtime-pack-release-matrix: ok (${entries.length} verified, ${missing.length} pending)`);
