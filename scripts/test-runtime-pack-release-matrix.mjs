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

function argValues(name) {
  const values = [];
  for (let i = 2; i < process.argv.length; i += 1) {
    const item = process.argv[i];
    if (item === name && process.argv[i + 1]) {
      values.push(process.argv[i + 1]);
      i += 1;
    } else if (item.startsWith(`${name}=`)) {
      values.push(item.slice(name.length + 1));
    }
  }
  return values.flatMap((value) => String(value || "").split(",")).map((value) => value.trim()).filter(Boolean);
}

function targetPlatforms() {
  const explicit = [
    ...argValues("--platform"),
    ...String(process.env.LILY_RELEASE_PLATFORMS || "").split(","),
  ].map((value) => value.trim()).filter(Boolean);
  if (explicit.length) return [...new Set(explicit)];
  const target = String(process.env.LILY_RELEASE_TARGET || "").trim().toLowerCase();
  if (target === "win" || target === "windows" || target === "win32-x64") return ["win32-x64"];
  if (target === "mac" || target === "darwin") return ["darwin-arm64", "darwin-x64"];
  return targets;
}

const selectedTargets = targetPlatforms();
for (const platform of selectedTargets) {
  assert.ok(targets.includes(platform), `unknown runtime-pack release platform: ${platform}`);
}

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
  for (const platform of selectedTargets) {
    if (!byKey.has(`${packId}:${platform}`)) missing.push(`${packId}:${platform}`);
  }
}
if (process.argv.includes("--strict") && !process.argv.includes("--online")) {
  assert.deepEqual(missing, [], `release-blocking runtime-pack gaps: ${missing.join(", ")}`);
} else if (missing.length) {
  console.warn(`[runtime-pack-matrix] pending verified lock artifacts (${missing.length}); offline strict preflight remains blocked`);
}

async function fetchArtifact(packId, platform) {
  const base = String(process.env.LILY_RUNTIME_PACK_API || "https://lilych.lilywb.cn").replace(/\/+$/, "");
  const url = `${base}/api/runtime-packs/artifact?pack=${encodeURIComponent(packId)}&platform=${encodeURIComponent(platform)}`;
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
  const productionOnly = [];
  for (const packId of lock.releaseRequiredPackIds) {
    for (const platform of selectedTargets) {
      const entry = byKey.get(`${packId}:${platform}`) || null;
      const artifact = await fetchArtifact(packId, platform);
      assert.ok(artifact, `production artifact missing: ${packId}:${platform}`);
      if (!entry) {
        productionOnly.push(`${packId}:${platform}`);
        continue;
      }
      assert.equal(artifact.version, entry.version);
      assert.equal(String(artifact.sha256).toLowerCase(), entry.sha256);
      assert.equal(Number(artifact.sizeBytes || artifact.size), entry.sizeBytes);
      assert.equal(artifact.url, entry.url);
    }
  }
  if (productionOnly.length) {
    console.warn(`[runtime-pack-matrix] production artifacts present without local lock entries: ${productionOnly.join(", ")}`);
  }
}

console.log(`runtime-pack-release-matrix: ok (${entries.length} locked, ${missing.length} pending, targets=${selectedTargets.join(",")})`);
