#!/usr/bin/env node
/**
 * Keeps the guide eval honest, with no gateway needed.
 *
 * The live suite (scripts/eval/run-guide-evals.mjs) can only be run with
 * credentials, but three ways it could quietly stop measuring anything are
 * checkable offline, and all three are the same defect class as an assertion
 * that cannot fail:
 *
 *   1. A grader that cannot tell a right answer from a wrong one. Every case
 *      carries a passSample and a failSample and must score them correctly.
 *   2. A discovery prompt that echoes its target skill's own description.
 *      Skill relevance is keyword matching, so such a prompt measures the
 *      matcher rather than discovery.
 *   3. A rule case pointing at a rule the presence contract does not track, so
 *      nothing guarantees the rule is even in the guide being tested.
 *
 * It also enforces that a canary exists, because without one every other case
 * can pass on the model's priors while the guide never reached it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGuideEvalCases } from "./eval/guide-eval-cases.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(fs.readFileSync(path.join(ROOT, "src/shared/agent-guide-rule-contract.json"), "utf8"));
const contractIds = new Set(contract.rules.map((rule) => rule.id));

const skillsDir = path.join(ROOT, "resources", "skills");
const manifests = new Map();
for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = path.join(skillsDir, entry.name, "skill.manifest.json");
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifests.set(manifest.id || entry.name, manifest);
}

const DIAGRAMS_GUIDE = path.join(skillsDir, "lily-diagrams", "SKILL.md");
const cases = buildGuideEvalCases({ skillDirs: { "lily-diagrams": DIAGRAMS_GUIDE } });
assert.ok(cases.length >= 6, "the guide eval needs enough cases to be a baseline, not a smoke test");

const ids = cases.map((item) => item.id);
assert.equal(new Set(ids).size, ids.length, "case ids must be unique");

// A canary is mandatory: it is the only thing that proves the run measured the
// guide at all.
const canaries = cases.filter((item) => item.kind === "canary");
assert.equal(canaries.length, 1, "exactly one canary case is required");
assert.ok(
  canaries[0].check(DIAGRAMS_GUIDE),
  "the canary must key on something only this session's assembled catalog contains",
);
assert.equal(canaries[0].check("/not/the/path/SKILL.md"), false, "the canary must reject a plausible wrong path");

// (1) Every grader must score its own fixtures correctly.
for (const item of cases) {
  assert.ok(String(item.why || "").trim(), `${item.id}: a case must say what it measures`);
  assert.ok(String(item.prompt || "").trim(), `${item.id}: a case needs a prompt`);
  assert.equal(typeof item.check, "function", `${item.id}: a case needs a check`);
  assert.equal(typeof item.passSample, "function", `${item.id}: a case needs a passSample fixture`);
  assert.equal(typeof item.failSample, "function", `${item.id}: a case needs a failSample fixture`);
  assert.equal(item.check(item.passSample()), true, `${item.id}: check must accept its own passSample`);
  assert.equal(item.check(item.failSample()), false, `${item.id}: check must reject its own failSample — a grader that accepts everything measures nothing`);
  assert.equal(item.check(""), false, `${item.id}: check must reject empty output`);
}

// (2) Discovery prompts must not echo the target skill's own description.
const STOPWORDS = new Set(["使用", "设置", "支持", "生成", "保存", "当前", "工作", "服务", "默认", "提供", "能力", "内容", "文件", "以及", "进行", "可以", "需要"]);
function significantTerms(text) {
  const terms = new Set();
  for (const match of String(text || "").matchAll(/[一-鿿]{2,}/g)) {
    // Slide a 2-gram window: Chinese descriptions have no spaces, so shared
    // wording shows up as shared adjacent character pairs.
    const run = match[0];
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const gram = run.slice(i, i + 2);
      if (!STOPWORDS.has(gram)) terms.add(gram);
    }
  }
  for (const match of String(text || "").matchAll(/[a-zA-Z][a-zA-Z0-9.-]{3,}/g)) {
    terms.add(match[0].toLowerCase());
  }
  return terms;
}

const discoveryReport = [];
for (const item of cases.filter((entry) => entry.kind === "discovery")) {
  const manifest = manifests.get(item.skill);
  assert.ok(manifest, `${item.id}: target skill ${item.skill} must actually be installed`);
  const description = manifest.description_i18n?.["zh-CN"] || manifest.description || "";
  assert.ok(description, `${item.id}: target skill needs a description to paraphrase away from`);

  // The prompt names the skill id in some cases only as the ANSWER format; the
  // instruction to output an id is not a hint, so strip the id before checking.
  const promptWithoutId = item.prompt.split(item.skill).join("");
  const descTerms = significantTerms(description);
  const promptTerms = significantTerms(promptWithoutId);
  const shared = [...promptTerms].filter((term) => descTerms.has(term));
  discoveryReport.push({ id: item.id, skill: item.skill, shared });
  assert.equal(
    shared.length,
    0,
    `${item.id}: prompt reuses the target description's wording (${shared.join(", ")}) — that measures keyword matching, not discovery`,
  );
}
assert.ok(discoveryReport.length >= 2, "at least two discovery cases are needed for a meaningful rate");

// (3) Rule cases must point at a tracked rule.
const ruleCases = cases.filter((entry) => entry.kind === "rule");
assert.ok(ruleCases.length >= 3, "at least three rule-adherence cases are needed");
for (const item of ruleCases) {
  assert.ok(
    contractIds.has(item.rule),
    `${item.id}: rule ${JSON.stringify(item.rule)} is not tracked in agent-guide-rule-contract.json, so nothing guarantees it is even in the guide`,
  );
}

console.log("guide eval cases: ok");
console.log(`  ${cases.length} cases: ${canaries.length} canary, ${ruleCases.length} rule, ${discoveryReport.length} discovery`);
console.log(`  every grader scores its own pass/fail fixtures correctly`);
for (const row of discoveryReport) {
  console.log(`  ${row.id} -> ${row.skill}: no shared wording with its description`);
}
