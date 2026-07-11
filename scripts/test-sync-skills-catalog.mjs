#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "..");
const {
  diffRegistries,
  mergeExternalEntries,
  validateCandidate,
  writeJsonAtomically,
} = require("../src/main/skill-catalog-sync-policy.js");

const baseline = {
  schemaVersion: 1,
  categories: [{ id: "dev", label: "Development" }, { id: "office", label: "Office" }],
  capabilities: { "lily-core": { kind: "workflow" } },
  skills: [
    { id: "lily-core", latestVersion: "1.0.0", category: "dev", capabilityLayer: "core", riskLevel: "low" },
    { id: "anthropics-pdf", latestVersion: "1.0.0", category: "office", publisher: "Anthropic", sourceKind: "bundled-vendor", description_i18n: { en: "PDF" } },
  ],
};

const candidate = mergeExternalEntries(baseline, [{
  id: "anthropics-pdf",
  latestVersion: "1.1.0",
  category: "office",
  publisher: "Anthropic",
  description: "Updated upstream description",
}], { allowedIdPrefixes: ["anthropics-"], allowAdditions: false });
assert.equal(candidate.skills.find((skill) => skill.id === "anthropics-pdf").latestVersion, "1.1.0");
assert.deepEqual(candidate.skills.find((skill) => skill.id === "anthropics-pdf").description_i18n, { en: "PDF" });
assert.deepEqual(candidate.skills.find((skill) => skill.id === "lily-core"), baseline.skills[0]);
assert.equal(validateCandidate(candidate, baseline).ok, true);
assert.deepEqual(diffRegistries(baseline, candidate), {
  added: [],
  removed: [],
  changed: ["anthropics-pdf"],
});
assert.deepEqual(
  diffRegistries(baseline, {
    ...baseline,
    skills: [
      { ...baseline.skills[0], latestVersion: "1.0.1" },
      { id: "anthropics-docx", latestVersion: "1.0.0", category: "office" },
    ],
  }),
  {
    added: ["anthropics-docx"],
    removed: ["anthropics-pdf"],
    changed: ["lily-core"],
  },
  "registry diff must make additions, removals, and content changes independently auditable",
);

const noAddition = mergeExternalEntries(baseline, [{
  id: "anthropics-new-skill",
  latestVersion: "1.0.0",
  category: "office",
}], { allowedIdPrefixes: ["anthropics-"], allowAdditions: false });
assert.equal(noAddition.skills.some((skill) => skill.id === "anthropics-new-skill"), false);

assert.throws(
  () => mergeExternalEntries(baseline, [{ id: "lily-core", latestVersion: "9.0.0" }], { allowedIdPrefixes: ["anthropics-"] }),
  /allowed namespace/i,
);
assert.equal(validateCandidate({ ...candidate, skills: candidate.skills.filter((skill) => skill.id !== "lily-core") }, baseline).ok, false);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-sync-policy-"));
const target = path.join(tmp, "registry.json");
writeJsonAtomically(target, candidate);
assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), candidate);
assert.equal(fs.readdirSync(tmp).some((name) => name.includes(".tmp-")), false);
fs.rmSync(tmp, { recursive: true, force: true });

const syncSource = fs.readFileSync(path.join(ROOT, "scripts", "sync-skills-catalog.mjs"), "utf8");
assert.match(syncSource, /if \(!apply\)/, "catalog sync must default to a non-applying candidate run");
assert.match(syncSource, /writeJsonAtomically\(CANDIDATE_PATH, candidate\)/, "dry run must write a candidate outside the registry");
assert.match(syncSource, /writeJsonAtomically\(CANDIDATE_DIFF_PATH, diff\)/, "dry run must write a structured diff beside the candidate");
const sources = JSON.parse(fs.readFileSync(path.join(ROOT, "resources", "skills-registry", "catalog-sources.json"), "utf8"));
assert.deepEqual(sources.sources.flatMap((source) => source.allowedIdPrefixes), ["anthropics-"]);
assert.deepEqual(sources.sources[0].includeOnly.sort(), ["doc-coauthoring", "docx", "pdf", "pptx", "xlsx"]);
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
assert.match(packageJson.scripts["sync:skills-catalog:apply"], /--apply/);

console.log("sync-skills-catalog: ok");
