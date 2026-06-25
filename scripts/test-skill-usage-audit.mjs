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

  console.log("skill-usage-audit: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
