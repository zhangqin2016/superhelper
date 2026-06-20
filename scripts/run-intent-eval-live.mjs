#!/usr/bin/env node
// Pillar 4: live intent-routing eval. Feeds each golden prompt to the configured
// model with the REAL system prompt (identity + router decision procedure + skill
// catalog) and asks it to return the skill IDs it would route to, then scores
// precision/recall/F1 against golden.jsonl. Runs an A/B: WITH the skill catalog
// (current design) vs WITHOUT it (the pre-Pillar-1 "dark skills" baseline), so the
// gain from making every skill discoverable is a measured number.
//
// Credentials come from the environment — nothing is written to disk:
//   DEEPSEEK_API_KEY (or LILY_API_KEY)   required
//   EVAL_BASE_URL   default https://api.deepseek.com   (OpenAI-compatible)
//   EVAL_MODEL      default deepseek-chat
//   EVAL_LIMIT      cap rows (optional)
//
// Usage: DEEPSEEK_API_KEY=sk-... node scripts/run-intent-eval-live.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const skillManager = require("../src/main/skill-manager.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = path.join(ROOT, "resources/skills-catalog/lily-intent-eval/references/golden.jsonl");
const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.LILY_API_KEY || "";
const BASE_URL = (process.env.EVAL_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const MODEL = process.env.EVAL_MODEL || "deepseek-chat";
const LIMIT = Number(process.env.EVAL_LIMIT || 0);

if (!API_KEY) {
  console.error("Missing DEEPSEEK_API_KEY (or LILY_API_KEY) in the environment. Nothing is read from disk.");
  process.exit(2);
}

function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}

// Build skill objects (id + dir + manifest) from the repo's skill folders, the
// same shape buildAgentGuideContent consumes in production.
function allSkills() {
  const out = [];
  for (const rootRel of ["resources/skills", "resources/skills-catalog"]) {
    const root = path.join(ROOT, rootRel);
    if (!fs.existsSync(root)) continue;
    for (const id of fs.readdirSync(root)) {
      const dir = path.join(root, id);
      if (!fs.existsSync(path.join(dir, "SKILL.md")) && !fs.existsSync(path.join(dir, "skill.manifest.json"))) continue;
      const mp = path.join(dir, "skill.manifest.json");
      const manifest = fs.existsSync(mp) ? JSON.parse(fs.readFileSync(mp, "utf8")) : { id, name: id };
      out.push({ id, skillDir: dir, manifest });
    }
  }
  return out;
}

const ROUTE_INSTRUCTION =
  "\n\n## Routing task (eval)\nGiven the user request below, decide which skills you would use. " +
  "Output ONLY a compact JSON array of skill IDs (the folder names, e.g. \"anthropics-pptx\"), no prose, no code fence. " +
  "If no skill applies, output [].";

function systemPrompt(skills, locale, withCatalog) {
  let guide = skillManager.buildAgentGuideContent(skills, locale);
  if (!withCatalog) {
    // Simulate the pre-Pillar-1 world: strip the skill catalog entirely.
    for (const marker of ["## Skill Catalog", "## 技能目录", "## فهرس المهارات"]) {
      const i = guide.indexOf(marker);
      if (i >= 0) guide = guide.slice(0, i).trim();
    }
  }
  return guide + ROUTE_INSTRUCTION;
}

async function callModel(system, user) {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

function parseRoutes(text) {
  const m = String(text).match(/\[[\s\S]*?\]/);
  if (!m) return [];
  try {
    return JSON.parse(m[0]).map((s) => String(s).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function score(rows) {
  let interSum = 0, actualSum = 0, expectedSum = 0, forbiddenHits = 0, exact = 0;
  for (const r of rows) {
    const actual = new Set(r.actual);
    const expected = new Set(r.expected);
    const inter = [...expected].filter((x) => actual.has(x)).length;
    interSum += inter; actualSum += actual.size; expectedSum += expected.size;
    if (r.forbidden.some((x) => actual.has(x))) forbiddenHits += 1;
    if (inter === expected.size && actual.size === expected.size) exact += 1;
  }
  const precision = actualSum ? interSum / actualSum : 0;
  const recall = expectedSum ? interSum / expectedSum : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, forbiddenHits, exact, n: rows.length };
}

const pct = (x) => (x * 100).toFixed(1) + "%";

async function runVariant(golden, skills, withCatalog) {
  const rows = [];
  for (const g of golden) {
    const locale = g.locale || "en";
    const user =
      `Request: ${g.prompt}` +
      (g.attachments?.length ? `\nAttachments: ${g.attachments.join(", ")}` : "");
    let actual = [];
    try {
      actual = parseRoutes(await callModel(systemPrompt(skills, locale, withCatalog), user));
    } catch (err) {
      console.error(`  [${g.id}] model error: ${err.message}`);
    }
    rows.push({ id: g.id, actual, expected: g.expected_route || [], forbidden: g.must_not_route || [] });
  }
  return rows;
}

(async () => {
  let golden = readJsonl(GOLDEN);
  if (LIMIT > 0) golden = golden.slice(0, LIMIT);
  const skills = allSkills();
  console.log(`Live intent eval — model=${MODEL}, ${golden.length} prompts, ${skills.length} skills in catalog\n`);

  console.log("Running WITH skill catalog (current design)…");
  const withRows = await runVariant(golden, skills, true);
  console.log("Running WITHOUT skill catalog (pre-Pillar-1 baseline)…");
  const withoutRows = await runVariant(golden, skills, false);

  const w = score(withRows);
  const b = score(withoutRows);
  const line = (label, s) =>
    `${label.padEnd(26)} precision ${pct(s.precision)}  recall ${pct(s.recall)}  F1 ${pct(s.f1)}  exact ${s.exact}/${s.n}  forbidden ${s.forbiddenHits}`;
  console.log("\n=== Results ===");
  console.log(line("WITH catalog (new)", w));
  console.log(line("WITHOUT catalog (old)", b));
  console.log(`\nRecall gain from the skill catalog: ${pct(w.recall - b.recall)} (the dark-skills fix).`);

  // Per-row detail
  console.log("\n=== Per-row routes (WITH catalog) ===");
  for (const r of withRows) {
    const miss = r.expected.filter((x) => !r.actual.includes(x));
    console.log(`- ${r.id}: picked [${r.actual.join(", ")}]${miss.length ? `  missed [${miss.join(", ")}]` : "  ✓"}`);
  }
})();
