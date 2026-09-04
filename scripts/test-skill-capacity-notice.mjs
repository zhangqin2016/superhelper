#!/usr/bin/env node
/**
 * The user-facing half of the guide-budget work.
 *
 * The skill index is the only channel that tells the model which skills exist,
 * and past the budget entries are dropped silently. The main process now logs
 * that; this checks the person managing skills is actually told, and — the part
 * that matters for "no dumber" — that a measurement failure degrades to the
 * old behaviour (no notice) instead of breaking the skills page.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const userData = path.join(os.tmpdir(), "lily-capacity-notice-fixed");
fs.mkdirSync(userData, { recursive: true });
process.env.LILY_USER_DATA_DIR ||= userData;
process.env.LILY_HOME ||= userData;

// --- the measurement -------------------------------------------------------

const skillManager = require("../src/main/skill-manager.js");
const measured = skillManager.measureAgentGuideBudget();
assert.ok(Number.isFinite(measured.totalBytes) && measured.totalBytes > 0, "measurement must report real bytes");
assert.equal(measured.maxBytes, skillManager.AGENT_GUIDE_MAX_BYTES, "measurement must carry the budget it was judged against");
assert.ok(measured.share > 0 && measured.share <= 1.5, `share should be a fraction, got ${measured.share}`);
assert.ok(Array.isArray(measured.omittedIds), "omitted skills must be enumerable, not just counted");
// Nothing indexed in a bare fixture, so there is no honest headroom figure.
assert.equal(measured.headroomSkills, null, "headroom must be null rather than Infinity when no skill is indexed");
assert.equal(measured.atRisk, false, "a base guide is not at risk");

// Measuring must not write anything: it is called from an IPC handler.
const guidePath = path.join(userData, "opencode", "AGENT.md");
const before = fs.existsSync(guidePath) ? fs.readFileSync(guidePath, "utf8") : null;
skillManager.measureAgentGuideBudget();
const after = fs.existsSync(guidePath) ? fs.readFileSync(guidePath, "utf8") : null;
assert.equal(after, before, "measuring the budget must not rewrite the agent guide");

// --- the notice ------------------------------------------------------------

const module_ = fs.readFileSync(path.join(ROOT, "src/renderer/modules/skill-capacity-notice.js"), "utf8");
const strings = JSON.parse(fs.readFileSync(path.join(ROOT, "src/renderer/i18n/locales/zh-CN.json"), "utf8"));
for (const key of ["skills.capacityNear", "skills.capacityFull", "skills.capacityUndescribed"]) {
  for (const locale of ["zh-CN", "en", "ar"]) {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, `src/renderer/i18n/locales/${locale}.json`), "utf8"));
    assert.ok(dict[key], `${locale} must translate ${key}`);
  }
}

// Run the real module against a minimal DOM, so the branch logic is executed
// rather than eyeballed.
const t = (key, vars = {}) =>
  String(strings[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`));
const source = module_
  .replace(/^import .*$/gm, "")
  .replace(/export function/g, "function");
const node = { hidden: false, textContent: "", classList: { toggle(name, on) { this[name] = Boolean(on); } } };
const factory = new Function("t", "getLocale", "document", `${source}\nreturn { renderSkillCapacityNotice };`);
const { renderSkillCapacityNotice } = factory(t, () => "zh-CN", { getElementById: () => null });

const cases = [
  { label: "comfortable", budget: { share: 0.53, headroomSkills: 78, omittedCount: 0, undescribedCount: 0 }, hidden: true },
  { label: "just below the notice threshold", budget: { share: 0.79, headroomSkills: 25, omittedCount: 0, undescribedCount: 0 }, hidden: true },
  { label: "approaching", budget: { share: 0.854, headroomSkills: 13, omittedCount: 0, undescribedCount: 0 }, hidden: false, contains: ["85", "13"], danger: false },
  { label: "over budget", budget: { share: 0.99, headroomSkills: 0, omittedCount: 7, undescribedCount: 0 }, hidden: false, contains: ["7"], danger: true },
  { label: "undescribed only", budget: { share: 0.4, headroomSkills: 90, omittedCount: 0, undescribedCount: 2 }, hidden: false, contains: ["2"], danger: false },
  { label: "no measurement", budget: null, hidden: true },
];

for (const testCase of cases) {
  node.hidden = false;
  node.textContent = "";
  node.classList["is-danger"] = undefined;
  renderSkillCapacityNotice(node, testCase.budget);
  assert.equal(node.hidden, testCase.hidden, `${testCase.label}: hidden should be ${testCase.hidden}`);
  for (const needle of testCase.contains || []) {
    assert.ok(node.textContent.includes(needle), `${testCase.label}: message should mention ${needle}, got "${node.textContent}"`);
  }
  if (testCase.hidden === false) {
    assert.equal(Boolean(node.classList["is-danger"]), Boolean(testCase.danger), `${testCase.label}: danger tone mismatch`);
  }
}

// A null node must be tolerated: the settings page may not be built yet.
renderSkillCapacityNotice(null, { share: 0.99, omittedCount: 3 });

// The IPC shape the renderer consumes, including its fail-open contract.
const ipcSource = fs.readFileSync(path.join(ROOT, "src/main/ipc-sessions.js"), "utf8");
assert.match(ipcSource, /guideBudget: publicGuideBudget\(\)/, "skills:list must carry the measurement");
assert.match(ipcSource, /catch\s*\{\s*return null;\s*\}/, "a measurement failure must return null, never throw into skills:list");
assert.match(ipcSource, /omittedIds: measured\.omittedIds\.slice\(0, 20\)/, "id lists must be capped in the IPC payload");

console.log("skill capacity notice: ok");
console.log(`  measured base guide: ${measured.totalBytes}B of ${measured.maxBytes}B (${(measured.share * 100).toFixed(1)}%)`);
