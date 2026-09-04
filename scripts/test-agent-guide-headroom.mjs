#!/usr/bin/env node
/**
 * Agent-guide headroom gate.
 *
 * The guide is injected as hidden context on EVERY prompt, and its skill index
 * is what tells the model which skills exist. The index is built last, with
 * whatever bytes the fixed prefix leaves over, and when it does not fit the
 * builder drops entries and truncates the document tail.
 *
 * The pre-existing budget assertion only checked `bytes <= AGENT_GUIDE_MAX_BYTES`,
 * which the builder guarantees by amputating the index — so it could never fail,
 * no matter how much of the index was being thrown away. This gate measures the
 * thing that actually matters instead:
 *
 *   1. At supported scale NO skill is silently dropped or left undiscoverable.
 *   2. The worst realistic configuration stays under a hard watermark.
 *   3. Per-configuration bytes are a ratchet: they may fall freely, but a rise
 *      past tolerance fails and must be re-baselined on purpose
 *      (--write-baseline), because growing the prefix silently eats the index.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = path.join(ROOT, "scripts", "agent-guide-headroom-baseline.json");
const WRITE = process.argv.includes("--write-baseline");

// The guide embeds the resolved runtime-bin path, so the userData dir has to be
// pinned: a fresh mkdtemp per run makes byte counts differ by its random name.
const userData = path.join(os.tmpdir(), "lily-guide-headroom-fixed");
fs.mkdirSync(userData, { recursive: true });
process.env.LILY_USER_DATA_DIR ||= userData;
process.env.LILY_HOME ||= userData;

const skillManager = require("../src/main/skill-manager.js");
const MAX = skillManager.AGENT_GUIDE_MAX_BYTES;
const bytesOf = (text) => Buffer.byteLength(text, "utf8");

/** Hard watermark. Above this the index has almost no room to absorb one more
 *  skill, and the next one enabled starts disappearing without a trace. */
const WATERMARK = 0.95;
/** Byte tolerance for the ratchet: absorbs incidental wording edits, not a new
 *  always-inlined rule section. */
const TOLERANCE = 512;
const LOCALES = ["zh-CN", "en", "ar"];

function loadSkills(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const skillDir = path.join(dir, entry.name);
      let manifest = { id: entry.name };
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(skillDir, "skill.manifest.json"), "utf8"));
      } catch {
        // A catalog entry without a manifest still has to be counted, because
        // that is exactly the case that goes undiscoverable.
      }
      return { id: manifest.id || entry.name, skillDir, manifest };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

const installed = loadSkills(path.join(ROOT, "resources", "skills"));
const catalog = loadSkills(path.join(ROOT, "resources", "skills-catalog"));
assert.ok(installed.length > 0, "resources/skills must contain the bundled skills");
assert.ok(catalog.length > 0, "resources/skills-catalog must contain the installable catalog");

// "all" is the ceiling a user can actually reach through the UI: everything
// bundled plus everything installable from the catalog.
const CONFIGS = [
  { key: "installed", skills: installed },
  { key: "all", skills: [...installed, ...catalog] },
];

const baseline = WRITE || !fs.existsSync(BASELINE_PATH)
  ? { note: "Regenerate on purpose with: node scripts/test-agent-guide-headroom.mjs --write-baseline", configs: {} }
  : JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));

const measured = {};
const failures = [];
const rows = [];

for (const locale of LOCALES) {
  for (const config of CONFIGS) {
    const key = `${locale}|${config.key}`;
    const guide = skillManager.buildAgentGuideContent(config.skills, locale);
    const report = skillManager.getLastAgentGuideBudget();
    assert.ok(report, "skill-manager must expose the measured guide budget");
    assert.equal(report.locale, locale, `${key}: budget report must describe the build just made`);

    const total = bytesOf(guide);
    assert.equal(total, report.totalBytes, `${key}: reported bytes must match the produced guide`);

    // (1) Nothing silently dropped, and nothing undiscoverable.
    if (report.omittedIds.length) {
      failures.push(`${key}: ${report.omittedIds.length} skill(s) dropped from the index for budget: ${report.omittedIds.join(", ")}`);
    }
    if (report.undescribedIds.length) {
      failures.push(`${key}: skill(s) with no description are absent from the index and undiscoverable: ${report.undescribedIds.join(", ")}`);
    }
    // Independent of the report: the id has to be readable in the guide text,
    // which is the only channel that tells the model the skill exists.
    const missing = report.indexedIds.filter((id) => !guide.includes(id));
    if (missing.length) failures.push(`${key}: indexed skill(s) absent from the guide text: ${missing.join(", ")}`);

    // (2) Hard watermark.
    const share = total / MAX;
    if (share > WATERMARK) {
      failures.push(`${key}: guide is ${total}B, ${(share * 100).toFixed(1)}% of the ${MAX}B budget (watermark ${(WATERMARK * 100).toFixed(0)}%)`);
    }

    // (3) Ratchet.
    const previous = baseline.configs?.[key]?.totalBytes;
    if (!WRITE && Number.isFinite(previous) && total > previous + TOLERANCE) {
      failures.push(
        `${key}: guide grew ${total - previous}B over the baseline (${previous}B → ${total}B, tolerance ${TOLERANCE}B). ` +
        "The prefix is injected on every prompt and squeezes the skill index; shrink it or re-baseline on purpose with --write-baseline.",
      );
    }

    // Exact: the bytes the real per-skill index lines cost, excluding the
    // section's fixed title and intro, straight from the builder.
    const marginal = Math.max(1, Math.round(report.indexLineBytes / Math.max(1, report.indexed)));
    const headroomSkills = Math.floor((MAX * WATERMARK - total) / marginal);
    measured[key] = { totalBytes: total, prefixBytes: report.prefixBytes, indexed: report.indexedIds.length };
    rows.push({ key, total, share, prefix: report.prefixBytes, indexed: report.indexedIds.length, marginal, headroomSkills });
  }
}

const width = Math.max(...rows.map((row) => row.key.length));
console.log(`agent guide budget = ${MAX}B, watermark ${(WATERMARK * 100).toFixed(0)}% = ${Math.floor(MAX * WATERMARK)}B\n`);
console.log(`${"config".padEnd(width)}   bytes   share   prefix  indexed  B/skill  +skills`);
for (const row of rows) {
  console.log(
    `${row.key.padEnd(width)}  ${String(row.total).padStart(6)}  ${(row.share * 100).toFixed(1).padStart(5)}%  ${String(row.prefix).padStart(6)}  ${String(row.indexed).padStart(7)}  ${String(row.marginal).padStart(7)}  ${String(row.headroomSkills).padStart(7)}`,
  );
}

if (WRITE) {
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify({ ...baseline, configs: measured }, null, 2)}\n`, "utf8");
  console.log(`\nbaseline written: ${path.relative(ROOT, BASELINE_PATH)}`);
}

if (failures.length) {
  console.error(`\nagent-guide-headroom: FAILED\n${failures.map((line) => `  - ${line}`).join("\n")}`);
  process.exit(1);
}
console.log("\nagent-guide-headroom: ok");
