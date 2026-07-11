#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

const appBuilder = read("resources/skills-catalog/lily-app-builder/SKILL.md");
const uiQuality = read("resources/skills-catalog/lily-ui-quality/SKILL.md");
const browserQa = read("resources/skills-catalog/lily-browser-qa/SKILL.md");
const codingCore = read("resources/skills-catalog/lily-coding-core/SKILL.md");

for (const token of [
  "Creation mode",
  "Review mode",
  "keyboard",
  "focus",
  "contrast",
  "200%",
  "prefers-reduced-motion",
  "RTL",
  "long text",
]) {
  assert.match(uiQuality, new RegExp(token, "i"), `UI quality guide must cover ${token}`);
}

for (const token of ["lily_process_jobs", "job_status", "job_logs", "progress", "lily-browser-qa"]) {
  assert.match(appBuilder, new RegExp(token, "i"), `App Builder must cover ${token}`);
}
assert.doesNotMatch(appBuilder, /fix one round/i, "App Builder must bound non-progress rather than effort");

for (const token of ["URL", "viewport", "steps", "actual result", "BROWSER_RUNTIME_UNAVAILABLE"]) {
  assert.match(browserQa, new RegExp(token, "i"), `Browser QA guide must report ${token}`);
}

assert.doesNotMatch(codingCore, /wraps planning.*frontend design/i, "Coding Core must not claim to duplicate specialist skills");
for (const skillId of ["lily-app-builder", "lily-ui-quality", "lily-browser-qa", "lily-code-repair"]) {
  assert.match(codingCore, new RegExp(skillId), `Coding Core must link to ${skillId}`);
}

for (const relativePath of [
  "resources/skills/lily-intent-router/skill.manifest.json",
  "resources/skills/lily-image-generation/SKILL.md",
  "resources/skills/lily-diagrams/SKILL.md",
]) {
  const text = read(relativePath);
  assert.equal(text.includes("`frontend-design`"), false, `${relativePath} references removed frontend-design`);
}

console.log("ui-skill-guides: ok");
