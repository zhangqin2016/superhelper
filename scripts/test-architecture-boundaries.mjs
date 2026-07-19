#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "src/shared/architecture-boundaries.json"), "utf8"));
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

function walk(relativeRoot) {
  const absoluteRoot = path.join(ROOT, relativeRoot);
  const files = [];
  for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true })) {
    const relative = path.posix.join(relativeRoot, entry.name);
    if (entry.isDirectory()) files.push(...walk(relative));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(relative);
  }
  return files;
}

function sourceText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function lineCount(text) {
  if (!text) return 0;
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function importedSpecifiers(text) {
  const pattern = /\brequire\s*\(\s*["']([^"']+)["']\s*\)|\bfrom\s+["']([^"']+)["']|\bimport\s*(?:\(\s*)?["']([^"']+)["']\s*\)?/g;
  return [...text.matchAll(pattern)].map((match) => match[1] || match[2] || match[3]).filter(Boolean);
}

assert.equal(manifest.schemaVersion, 1);
const sourceFiles = manifest.sourceRoots.flatMap(walk);
const hotspotBudgets = manifest.hotspotLineBudgets || {};

for (const [relativePath, maxLines] of Object.entries(hotspotBudgets)) {
  assert(fs.existsSync(path.join(ROOT, relativePath)), `tracked hotspot is missing: ${relativePath}`);
  const actual = lineCount(sourceText(relativePath));
  assert(
    actual <= maxLines,
    `${relativePath} grew from its ${maxLines}-line ratchet to ${actual}; extract a focused module before adding behavior`,
  );
}

for (const relativePath of sourceFiles) {
  const actual = lineCount(sourceText(relativePath));
  if (actual > manifest.newFileMaxLines) {
    assert(
      Object.prototype.hasOwnProperty.call(hotspotBudgets, relativePath),
      `new untracked hotspot ${relativePath} has ${actual} lines; split responsibilities before merging`,
    );
  }
}

for (const boundary of manifest.forbiddenImports || []) {
  const destination = path.resolve(ROOT, boundary.to);
  for (const relativePath of walk(boundary.from)) {
    for (const specifier of importedSpecifiers(sourceText(relativePath))) {
      if (!specifier.startsWith(".")) continue;
      const resolved = path.resolve(ROOT, path.dirname(relativePath), specifier);
      assert(
        resolved !== destination && !resolved.startsWith(`${destination}${path.sep}`),
        `${relativePath} crosses the ${boundary.from} -> ${boundary.to} process boundary via ${specifier}`,
      );
    }
  }
}

const orchestrator = sourceText("src/main/turn-orchestrator.js");
const intentCall = orchestrator.indexOf("const turnIntelligence = resolveTurnIntelligence(");
const readinessCall = orchestrator.indexOf("await prepareTurnCapabilityReadiness(");
assert(intentCall >= 0 && readinessCall > intentCall, "turn intent must resolve before capability readiness");

const semanticsSource = manifest.singleSources.toolSemantics;
for (const relativePath of walk("src/main")) {
  if (relativePath === semanticsSource) continue;
  assert(
    !/(?:const|let|var)\s+(?:READ_ONLY_TOOLS|REPLAY_SAFE_TOOL_NAMES)\s*=/.test(sourceText(relativePath)),
    `${relativePath} duplicates tool semantics instead of using ${semanticsSource}`,
  );
}
for (const consumer of [
  "src/main/task-run-state.js",
  "src/main/tool-call-rescue.js",
  "src/main/opencode-agent-session.js",
  "src/main/turn-artifacts.js",
  "src/main/mcp/tool-broker-registry.js",
]) {
  assert(sourceText(consumer).includes("tool-semantics"), `${consumer} must use the shared tool semantics registry`);
}

const runtimeSchema = sourceText("src/main/runtime-event-schema.js");
assert(runtimeSchema.includes("shared/runtime-contract.json"), "runtime events must use the shared runtime contract");
const taskContract = sourceText("src/main/task-contract.js");
assert(taskContract.includes("enabled: base.enabled !== false"), "remote task intelligence must preserve the local baseline");
assert(!taskContract.includes("enabled: normalizedRemote.enabled"), "remote task intelligence cannot control baseline enablement");

console.log(`architecture-boundaries: ok (${sourceFiles.length} source files, ${Object.keys(hotspotBudgets).length} ratchets)`);
