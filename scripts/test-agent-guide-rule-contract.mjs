#!/usr/bin/env node
/**
 * Rule-presence contract — the offline half of the "no dumber" ruler.
 *
 * Rules are pushed, not pulled: the assembled guide is the only channel that
 * tells the model a rule exists, so the precondition for the model obeying a
 * rule is that the rule is still in the guide. That precondition is checkable
 * with no model, no network and no credentials, which is why it can gate every
 * change instead of only release runs.
 *
 * For each locale x platform this builds the REAL guide from the REAL skill
 * directories and asserts, by name, that every rule the contract requires is
 * present and every rule it forbids here is absent. A rule that gets reworded,
 * moved behind a condition, pruned by environment, or squeezed out by the byte
 * budget fails with its id.
 *
 * It also guards itself: an anchor that matches in NO configuration is a dead
 * contract entry that has stopped measuring anything, and fails too.
 *
 * Live model adherence — does the model OBEY the rule it was shown — is the
 * other half, in scripts/eval/run-guide-evals.mjs, which needs a gateway.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(fs.readFileSync(path.join(ROOT, "src/shared/agent-guide-rule-contract.json"), "utf8"));

const userData = path.join(os.tmpdir(), "lily-rule-contract-fixed");
fs.mkdirSync(userData, { recursive: true });
process.env.LILY_USER_DATA_DIR ||= userData;
process.env.LILY_HOME ||= userData;

const LOCALES = ["zh-CN", "en", "ar"];
const PLATFORMS = ["win32", "darwin", "linux"];

// --- contract shape -------------------------------------------------------

assert.equal(contract.schemaVersion, 1, "unknown rule-contract schema version");
assert.ok(Array.isArray(contract.rules) && contract.rules.length, "the contract must list rules");
const ids = contract.rules.map((rule) => rule.id);
assert.equal(new Set(ids).size, ids.length, "rule ids must be unique");
for (const rule of contract.rules) {
  assert.ok(rule.id, "every rule needs an id");
  assert.ok(String(rule.why || "").trim(), `${rule.id}: a rule needs to say what breaks without it`);
  for (const locale of LOCALES) {
    assert.ok(
      String(rule.anchors?.[locale] || "").trim(),
      `${rule.id}: needs an anchor for ${locale} — an unanchored locale is an unmeasured locale`,
    );
  }
}

// --- build the real guide per locale x platform ----------------------------

const skillsDir = path.join(ROOT, "resources", "skills");
const skills = fs
  .readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const skillDir = path.join(skillsDir, entry.name);
    const manifest = JSON.parse(fs.readFileSync(path.join(skillDir, "skill.manifest.json"), "utf8"));
    return { id: manifest.id || entry.name, skillDir, manifest };
  })
  .sort((a, b) => a.id.localeCompare(b.id));
assert.ok(skills.length, "resources/skills must contain the bundled skills");

const skillManager = require("../src/main/skill-manager.js");
const realPlatform = process.platform;
const guides = new Map();
for (const platform of PLATFORMS) {
  // Guide blocks read process.platform at call time, so flipping it between
  // builds exercises the real resolution rather than a re-implementation.
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  for (const locale of LOCALES) {
    guides.set(`${locale}|${platform}`, skillManager.buildAgentGuideContent(skills, locale));
  }
}
Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });

function conditionMatches(condition, platform) {
  if (condition === "always") return true;
  if (!condition || typeof condition !== "object") return false;
  if (Array.isArray(condition.platform)) return condition.platform.includes(platform);
  return false;
}

// --- required present, forbidden absent -----------------------------------

const failures = [];
const anchorSeen = new Map(ids.map((id) => [id, 0]));
const knownGaps = [];

for (const rule of contract.rules) {
  const skipLocales = new Set(rule.localesKnownMissing || []);
  for (const platform of PLATFORMS) {
    for (const locale of LOCALES) {
      const guide = guides.get(`${locale}|${platform}`);
      const anchor = rule.anchors[locale];
      const present = guide.includes(anchor);
      if (present) anchorSeen.set(rule.id, anchorSeen.get(rule.id) + 1);

      const required = conditionMatches(rule.requiredWhen, platform);
      const forbidden = conditionMatches(rule.forbiddenWhen, platform);

      if (required && !present) {
        if (skipLocales.has(locale)) {
          knownGaps.push(`${rule.id} @ ${locale}|${platform}`);
          continue;
        }
        failures.push(`${rule.id}: MISSING from ${locale}|${platform} guide (anchor ${JSON.stringify(anchor)}) — ${rule.why}`);
      }
      if (forbidden && present) {
        failures.push(`${rule.id}: must NOT be in the ${locale}|${platform} guide but is (anchor ${JSON.stringify(anchor)})`);
      }
    }
  }
}

// A contract entry whose anchor matches nowhere has stopped measuring the rule
// it names — the same defect class as an assertion that cannot fail.
for (const [id, hits] of anchorSeen) {
  if (hits === 0) {
    const rule = contract.rules.find((entry) => entry.id === id);
    failures.push(
      `${id}: anchor matched in NO configuration, so this entry no longer measures anything. ` +
      `Either the rule left the guide, or the anchor needs re-pointing at the shipped wording (${JSON.stringify(rule.anchors)}).`,
    );
  }
}

// --- report ---------------------------------------------------------------

const width = Math.max(...ids.map((id) => id.length));
console.log(`rule contract: ${contract.rules.length} rules x ${LOCALES.length} locales x ${PLATFORMS.length} platforms\n`);
for (const rule of contract.rules) {
  const scope = rule.requiredWhen === "always" ? "always" : `platform ${(rule.requiredWhen.platform || []).join("/")}`;
  console.log(`  ${rule.id.padEnd(width)}  ${String(anchorSeen.get(rule.id)).padStart(2)}/9 present   required: ${scope}`);
}
if (knownGaps.length) {
  console.log(`\n  recorded gaps (declared in the contract, not failures):`);
  for (const gap of knownGaps) console.log(`    - ${gap}`);
}

if (failures.length) {
  console.error(`\nagent-guide-rule-contract: FAILED\n${failures.map((line) => `  - ${line}`).join("\n")}`);
  process.exit(1);
}
console.log("\nagent-guide-rule-contract: ok");
