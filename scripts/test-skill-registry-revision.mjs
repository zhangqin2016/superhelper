#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-registry-revision-"));
const registryDir = path.join(tmp, "resources", "skills-registry");
const skillDir = path.join(tmp, "resources", "skills-catalog", "lily-demo");
fs.mkdirSync(registryDir, { recursive: true });
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Demo\n\nFirst guide.\n", "utf8");
fs.writeFileSync(
  path.join(skillDir, "skill.manifest.json"),
  JSON.stringify({ schemaVersion: 1, id: "lily-demo", version: "1.0.0" }, null, 2),
  "utf8",
);
fs.writeFileSync(
  path.join(registryDir, "registry.json"),
  JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-07-11T00:00:00.000Z",
    publisher: "Lily Workbench",
    categories: [{ id: "dev", label: "Development" }],
    capabilities: {},
    skills: [{
      id: "lily-demo",
      name: "Demo",
      latestVersion: "1.0.0",
      category: "dev",
      sourceType: "github",
      github: { repo: "lily-workbench/skills", path: "lily-demo", ref: "main" },
    }],
  }, null, 2),
  "utf8",
);

const script = path.join(ROOT, "scripts", "stamp-skill-registry.mjs");
execFileSync(process.execPath, [script, "--root", tmp], { stdio: "pipe" });
const stamped = JSON.parse(fs.readFileSync(path.join(registryDir, "registry.json"), "utf8"));
assert.match(stamped.registryRevision, /^[0-9a-f]{64}$/);
assert.match(stamped.skills[0].contentRevision, /^[0-9a-f]{64}$/);

execFileSync(process.execPath, [script, "--root", tmp, "--check"], { stdio: "pipe" });
fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Demo\n\nChanged guide only.\n", "utf8");
assert.throws(
  () => execFileSync(process.execPath, [script, "--root", tmp, "--check"], { stdio: "pipe" }),
  /Command failed/,
  "guide-only changes must invalidate the stored registry revision",
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("skill-registry-revision: ok");
