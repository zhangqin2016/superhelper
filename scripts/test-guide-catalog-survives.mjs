#!/usr/bin/env node
// The skill catalog is the only channel that tells the model which skills
// exist. The guide truncator kept or dropped each section whole, so on a tight
// (lite, 8000-char) budget the whole catalog vanished and the model no longer
// knew any skill existed (2026-09-28 audit). A list section keeps the entries
// that fit — the ones this turn needs first — and says how many it left out.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { truncateSystemGuidance } = require("../src/main/runtime/opencode-message-parts.js");

const filler = (topic, n = 30) => Array.from({ length: n }, (_, i) => `${topic} rule ${i}: keep the workflow disciplined and verify results before reporting.`).join("\n");
const entries = Array.from({ length: 200 }, (_, i) => `- **lily-skill-${i}（Skill ${i}）** — generic helper number ${i} for routine chores （指南: skills/lily-skill-${i}/SKILL.md）`);
entries.splice(170, 0, "- **lily-excel-report（Excel 报表）** — 生成 Excel 报表、透视表和图表，按用户的数据源自动整理字段、计算汇总并输出可交付的工作簿 （指南: skills/lily-excel-report/SKILL.md）");
const guide = [
  "# Lily Agent Guide",
  "You are Lily. Evidence first; say unknown when unsure.",
  "",
  "## Tool Protocol",
  filler("tool"),
  "",
  "## Lily 平台能力目录（使用前先读取对应指南）",
  "",
  "以下是本会话可用的 Lily 平台能力指南。动手前用 Read 读取对应指南文件。",
  "",
  ...entries,
  "",
  "## Writing Style",
  filler("style", 90),
].join("\n");
assert.ok(guide.length > 11_000, `fixture: a guide larger than the lite budget (${guide.length})`);

const limit = 8000;
const out = truncateSystemGuidance(guide, limit, { intentText: "帮我做一个 Excel 报表" });
assert.ok(out.length <= limit, `the budget holds: ${out.length}`);
assert.match(out, /## Lily 平台能力目录/, "the catalog survives a lite budget");
assert.match(out, /动手前用 Read 读取对应指南文件/, "with its instructions");
assert.match(out, /lily-excel-report/, "and the entry this turn needs, even deep in the list");
assert.match(out, /\(\d+ more entries omitted for this model's input limit\)/, "and it says how many it left out");
assert.match(out, /## Tool Protocol/, "guardrails still come first");
const kept = out.match(/^- \*\*lily-skill-/gm) || [];
assert.ok(kept.length > 5, `as many entries as fit are kept: ${kept.length}`);

// A guide that fits is byte-identical; the kill switch restores whole-or-nothing.
assert.equal(truncateSystemGuidance(guide, guide.length + 10), guide.trim(), "untouched when it fits");
process.env.LILY_GUIDE_PARTIAL_LISTS = "0";
assert.doesNotMatch(truncateSystemGuidance(guide, limit, { intentText: "Excel 报表" }), /lily-excel-report/, "kill switch: whole-or-nothing again");
delete process.env.LILY_GUIDE_PARTIAL_LISTS;

// Prose sections are not lists: never cut mid-paragraph by this path.
const prose = truncateSystemGuidance(guide, limit, {});
assert.doesNotMatch(prose, /style rule 89/, "a prose section that does not fit is still omitted whole, and named");

// What the user explicitly asked Lily to remember rides the guide (the system
// prompt on every turn); on a truncated guide it is kept like a guardrail,
// never shed like a skill section (2026-09-28 audit).
{
  const { buildLearnedSection } = require("../src/main/learned-context.js");
  const fsx = await import("node:fs");
  const os = await import("node:os");
  const pathx = await import("node:path");
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), "lily-guide-conventions-"));
  process.env.LILY_USER_DATA_DIR = dir;
  const { appendLearnedConvention } = require("../src/main/learned-context.js");
  appendLearnedConvention("proj-1", "回复一律用英文");
  const section = buildLearnedSection("proj-1");
  assert.match(section, /回复一律用英文/, "fixture: the real conventions section");
  const withConventions = `${guide}\n${section}`;
  const cut = truncateSystemGuidance(withConventions, limit, { intentText: "帮我做一个 Excel 报表" });
  assert.ok(cut.length <= limit, "the budget holds");
  assert.match(cut, /回复一律用英文/, "the user's remembered instruction survives the truncated guide");
  // Even when the budget cannot hold the guardrails whole (they shrink to their
  // actionable minimum and every skill section is shed), it stays.
  const tight = truncateSystemGuidance(withConventions, 2000, {});
  assert.ok(tight.length <= 2000, "the tight budget holds");
  assert.doesNotMatch(tight, /## Writing Style/, "fixture: ordinary sections are shed at this budget");
  assert.match(tight, /回复一律用英文/, "the remembered instruction is kept like a guardrail");
  fsx.rmSync(dir, { recursive: true, force: true });
  delete process.env.LILY_USER_DATA_DIR;
}

console.log("guide-catalog-survives: ok");
