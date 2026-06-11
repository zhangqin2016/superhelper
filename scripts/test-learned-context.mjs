#!/usr/bin/env node
/**
 * Learned-context layers:
 *  L2 — workspace rule files (.cursorrules/AGENTS.md) are absorbed into the
 *       session guide section, capped, and tracked by the cache signature.
 *  L1 — "记住：…" conventions persist per project with provenance and feed
 *       their own guide section.
 *  L3 — skill drafts in the inbox register only when structurally valid,
 *       always disabled, with the learned- prefix enforced.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "learned-context-test-"));

// Stub electron so config.js userDataPath lands in our temp dir.
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { app: { getPath: () => tempRoot, getName: () => "lily-test" } },
};

const {
  appendLearnedConvention,
  buildLearnedSection,
  buildWorkspaceRulesSection,
  contextSignature,
} = require("../src/main/learned-context.js");
const {
  readDraftManifest,
  collectLearnedSkillDrafts,
} = require("../src/main/learned-skills.js");

try {
  // L2: workspace rules absorbed; CLAUDE.md intentionally NOT read (engine native).
  const workspace = path.join(tempRoot, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, ".cursorrules"), "永远用中文回复");
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "# 团队约定\n提交前跑测试");
  fs.writeFileSync(path.join(workspace, "CLAUDE.md"), "engine-native-should-not-appear");
  const section = buildWorkspaceRulesSection(workspace);
  if (!section.includes("永远用中文回复") || !section.includes("提交前跑测试")) {
    throw new Error(`workspace rules must be absorbed: ${section}`);
  }
  if (section.includes("engine-native-should-not-appear")) {
    throw new Error("CLAUDE.md must be skipped — the engine already reads it natively");
  }
  if (buildWorkspaceRulesSection(path.join(tempRoot, "missing")) !== "") {
    throw new Error("missing workspace must yield an empty section");
  }

  // L1: conventions persist with provenance and change the signature.
  const sigBefore = contextSignature("proj_1", workspace);
  if (buildLearnedSection("proj_1") !== "") {
    throw new Error("no conventions yet → empty learned section");
  }
  appendLearnedConvention("proj_1", "报告统一用宋体  \n 输出 docx");
  const learned = buildLearnedSection("proj_1");
  if (!learned.includes("报告统一用宋体 输出 docx")) {
    throw new Error(`convention must persist (whitespace collapsed): ${learned}`);
  }
  if (contextSignature("proj_1", workspace) === sigBefore) {
    throw new Error("remembering a convention must change the guide signature");
  }
  if (buildLearnedSection("proj_other") !== "") {
    throw new Error("conventions are scoped per project");
  }

  // L3: draft validation + registration flow.
  const inbox = path.join(tempRoot, "inbox");
  const goodDraft = path.join(inbox, "report-helper");
  fs.mkdirSync(goodDraft, { recursive: true });
  fs.writeFileSync(path.join(goodDraft, "SKILL.md"), "---\nname: 报告助手\n---\n步骤…");
  fs.writeFileSync(
    path.join(goodDraft, "skill.manifest.json"),
    JSON.stringify({ id: "report-helper", name: "报告助手", version: "0.1.0", description: "d" }),
  );
  const badDraft = path.join(inbox, "Bad_ID");
  fs.mkdirSync(badDraft, { recursive: true });
  fs.writeFileSync(path.join(badDraft, "skill.manifest.json"), JSON.stringify({ id: "Bad_ID", name: "x" }));

  if (!readDraftManifest(goodDraft)) throw new Error("valid draft must parse");
  if (readDraftManifest(badDraft)) throw new Error("invalid id must be rejected");

  const registeredDirs = [];
  const registered = collectLearnedSkillDrafts((dir, manifest) => {
    registeredDirs.push({ dir, manifest });
    return `learned-${manifest.id}`;
  }, inbox);
  if (registered.join(",") !== "learned-report-helper") {
    throw new Error(`only the valid draft registers: ${registered}`);
  }
  if (fs.existsSync(goodDraft)) throw new Error("registered draft must be consumed");
  if (!fs.existsSync(badDraft)) throw new Error("invalid draft stays for a later fix");

  console.log("learned-context: ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
