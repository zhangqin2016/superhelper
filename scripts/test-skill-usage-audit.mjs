#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildSkillUsageAudit, collectSkillGuideReads } = require("../src/main/skill-usage-audit.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-skill-audit-"));

function makeSkill(id, frontmatter) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\nGuide body\n`, "utf8");
  return dir;
}

try {
  const runtimeDir = makeSkill("lily-runtime-debug", "name: Runtime Debug\ndescription: Use when debugging runtime session routing and event issues.");
  const docDir = makeSkill("lily-docs", "name: Docs\ndescription: Use when writing documents.");
  const manifests = {
    "lily-runtime-debug": {
      id: "lily-runtime-debug",
      name: "Runtime Debug",
      description: "Use when debugging runtime session routing and event issues.",
    },
    "lily-docs": {
      id: "lily-docs",
      name: "Docs",
      description: "Use when writing documents.",
    },
  };
  const dirs = {
    "lily-runtime-debug": runtimeDir,
    "lily-docs": docDir,
  };
  const skillManager = {
    resolveSessionSkillIds: () => ["lily-runtime-debug", "lily-docs"],
    installedSkillDir: (id) => dirs[id],
    readInstalledManifest: (id) => manifests[id],
  };

  const guideReads = collectSkillGuideReads([
    { name: "Read", input: { file_path: path.join(runtimeDir, "SKILL.md") } },
    { name: "Read", input: { file_path: path.join(root, "README.md") } },
  ]);
  assert.deepEqual(guideReads, [path.join(runtimeDir, "SKILL.md").replace(/\\/g, "/")]);

  const used = buildSkillUsageAudit({
    userText: "帮我 debug runtime session routing event 问题",
    session: { id: "s1" },
    tools: [{ name: "Read", input: { file_path: path.join(runtimeDir, "SKILL.md") } }],
    skillManager,
  });
  assert.equal(used.candidateCount, 1);
  assert.equal(used.candidates[0].id, "lily-runtime-debug");
  assert.deepEqual(used.usedSkillIds, ["lily-runtime-debug"]);
  assert.deepEqual(used.missingGuideReads, []);
  assert.equal(used.ok, true);

  const missing = buildSkillUsageAudit({
    userText: "帮我 debug runtime session routing event 问题",
    session: { id: "s1" },
    tools: [],
    skillManager,
  });
  assert.equal(missing.candidateCount, 1);
  assert.deepEqual(missing.usedSkillIds, []);
  assert.deepEqual(missing.missingGuideReads, ["lily-runtime-debug"]);
  assert.equal(missing.ok, false);

  const unrelated = buildSkillUsageAudit({
    userText: "你好，今天吃什么",
    session: { id: "s1" },
    tools: [],
    skillManager,
  });
  assert.equal(unrelated.candidateCount, 0);
  assert.equal(unrelated.ok, true);

  // 2026-09-25: candidates are what the router recommended, not a word-overlap
  // guess — the guess recorded zero skills used over 30 days of real reads.
  {
    const thirdDir = makeSkill("lily-third", "name: Third\ndescription: Something unrelated.");
    dirs["lily-third"] = thirdDir;
    const mgr = { ...skillManager, getAllInstalledSkillIds: () => ["lily-runtime-debug", "lily-docs", "lily-third"] };
    const reads = [
      { name: "read", input: { filePath: path.join(docDir, "SKILL.md") } },
      { name: "read", input: { filePath: path.join(thirdDir, "SKILL.md") } },
    ];
    const audit = buildSkillUsageAudit({ userText: "anything at all", tools: reads, skillManager: mgr, workspaceSkills: [], recommendedSkillIds: ["lily-docs", "lily-runtime-debug", "lily-docs"] });
    assert.equal(audit.candidateSource, "router");
    assert.deepEqual(audit.candidates.map((c) => [c.id, c.matched]), [["lily-docs", "routed"], ["lily-runtime-debug", "routed"]], "the router's recommendation, deduplicated, in its order");
    assert.deepEqual(audit.usedSkillIds, ["lily-docs"], "a recommended guide the model read is used");
    assert.deepEqual(audit.missingGuideReads, ["lily-runtime-debug"], "a recommended guide it did not read is missing");
    assert.deepEqual(audit.unroutedGuideReads, ["lily-third"], "a guide it read that was not recommended is recorded as its own choice");
    const none = buildSkillUsageAudit({ userText: "x", tools: [], skillManager: mgr, workspaceSkills: [], recommendedSkillIds: [] });
    assert.equal(none.candidateCount, 0, "a turn the router recommended nothing for has no candidates — not a guess");
    const legacy = buildSkillUsageAudit({ userText: "debugging runtime session routing", tools: [], skillManager: mgr, workspaceSkills: [] });
    assert.equal(legacy.candidateSource, "token_overlap", "a turn without routing keeps the previous guess");
    const { aggregateSkillUsage } = require("../src/main/skill-usage-metrics.js");
    const summary = aggregateSkillUsage([{ ...audit, guideReadEvidence: [{ path: path.join(docDir, "SKILL.md"), outcome: "success" }] }]);
    assert.equal(summary.byMatchKind.routed.matched, 2);
    assert.equal(summary.byMatchKind.routed.read, 1);
    assert.equal(summary.unrouted["lily-third"], 1, "the report counts the router's blind spots");
  }

  console.log("skill-usage-audit: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
