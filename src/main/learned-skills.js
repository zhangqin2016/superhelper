"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");

/**
 * L3 skill crystallization: the engine writes skill DRAFTS into an inbox
 * directory (exposed via --add-dir); after a turn completes, valid drafts are
 * registered as installed skills with source "learned" and enabled:false —
 * the user reviews and enables them in Settings. Never auto-enabled.
 */

const DRAFT_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;

function learnedSkillsInboxDir() {
  return userDataPath("learned-skills-inbox");
}

/** Injected into session AGENT.md so the model knows the contract. */
function buildCrystallizationSection() {
  const inbox = learnedSkillsInboxDir();
  return [
    "",
    "## 把流程保存为技能",
    "",
    "当用户要求把当前流程/方法保存为可复用技能时：",
    `1. 在 \`${inbox}\` 下创建目录 \`<技能英文id>\`（小写字母/数字/连字符）。`,
    "2. 目录内写入 `SKILL.md`（frontmatter 含 name、description 与使用说明）和 `skill.manifest.json`（至少含 id、name、version、description 字段）。",
    "3. 告诉用户：技能草稿已生成，需要在 设置 → 技能 中审核并启用后才会生效。",
    "不要直接改动应用的技能安装目录。",
    "",
  ].join("\n");
}

/** Returns the parsed manifest when the draft directory is structurally valid. */
function readDraftManifest(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "skill.manifest.json"), "utf8"));
    if (!manifest || typeof manifest !== "object") return null;
    if (!DRAFT_ID_RE.test(String(manifest.id || ""))) return null;
    if (!String(manifest.name || "").trim()) return null;
    if (!fs.existsSync(path.join(dir, "SKILL.md"))) return null;
    return manifest;
  } catch {
    return null;
  }
}

/**
 * Scan the inbox and register every valid draft via the injected callback
 * (skillManager.registerLearnedSkillDir). Successful drafts are consumed;
 * invalid ones are left in place for the model to fix on a later attempt.
 * @param {(dir: string, manifest: object) => string | null} registerSkillDir
 * @param {string} [inboxDir] test override
 * @returns {string[]} registered skill ids
 */
function collectLearnedSkillDrafts(registerSkillDir, inboxDir = learnedSkillsInboxDir()) {
  let names = [];
  try {
    names = fs.readdirSync(inboxDir);
  } catch {
    return [];
  }
  const registered = [];
  for (const name of names) {
    const dir = path.join(inboxDir, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      const manifest = readDraftManifest(dir);
      if (!manifest) continue;
      const id = registerSkillDir(dir, manifest);
      if (id) {
        fs.rmSync(dir, { recursive: true, force: true });
        registered.push(id);
      }
    } catch {
      // draft stays in the inbox; never fail the turn over it
    }
  }
  return registered;
}

module.exports = {
  buildCrystallizationSection,
  collectLearnedSkillDrafts,
  learnedSkillsInboxDir,
  readDraftManifest,
};
