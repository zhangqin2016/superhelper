"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");

/**
 * L3 skill crystallization: the engine writes generated skills into an inbox
 * directory (exposed via --add-dir); after a turn completes, valid skills are
 * registered as installed skills with source "learned". Workspace-origin
 * skills are bound to the current workspace so new chats in that workspace can
 * use them immediately, without leaking the capability into unrelated spaces.
 */

const DRAFT_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;

function learnedSkillsInboxDir() {
  return userDataPath("learned-skills-inbox");
}

function isZh() {
  try {
    return String(require("./locale-settings").getLocale() || "").startsWith("zh");
  } catch {
    return false;
  }
}

/** Injected into session AGENT.md so the model knows the contract. */
function buildCrystallizationSection() {
  const inbox = learnedSkillsInboxDir();
  if (isZh()) {
    return [
      "",
      "## 把流程保存为技能",
      "",
      "当用户要求把当前流程/方法保存为可复用技能时：",
      `1. 在 \`${inbox}\` 下创建目录 \`<技能英文id>\`（小写字母/数字/连字符）。`,
      "2. 目录内写入 `SKILL.md`（frontmatter 含 name、description 与使用说明）和 `skill.manifest.json`（至少含 id、name、version、description 字段）。",
      "3. 告诉用户：技能已保存到当前工作区，系统会自动注册；后续新对话会加载这项能力。不要让用户去任何“技能审核/启用”入口。",
      "不要直接改动应用的技能安装目录，也不要声称需要人工审核后才生效。",
      "",
    ].join("\n");
  }
  return [
    "",
    "## Saving a workflow as a skill",
    "",
    "When the user asks to save the current workflow/method as a reusable skill:",
    `1. Create a directory \`<skill-id>\` (lowercase letters/digits/hyphens) under \`${inbox}\`.`,
    "2. Write `SKILL.md` (frontmatter with name, description and usage) and `skill.manifest.json` (at least id, name, version, description).",
    "3. Tell the user the skill was saved to the current workspace and will be registered automatically; future chats in this workspace can load it. Do not send the user to any skill review/enable screen.",
    "Never modify the app's installed-skills directory directly, and never claim manual review is required before it takes effect.",
    "",
  ].join("\n");
}

/** Returns the parsed manifest when the generated skill directory is structurally valid. */
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
 * Scan the inbox and register every valid generated skill via the injected callback
 * (skillManager.registerLearnedSkillDir). Successful skills are consumed;
 * invalid ones are left in place for the model to fix on a later attempt.
 * @param {(dir: string, manifest: object, context?: object) => string | null} registerSkillDir
 * @param {string} [inboxDir] test override
 * @param {object} [context] registration context, e.g. { projectId, sessionId }
 * @returns {string[]} registered skill ids
 */
/**
 * Tolerate one level of nesting. A generated skill written to `inbox/<id>/<id>/` (e.g. the
 * generator invoked with --out already including the id) has no manifest at the
 * top dir; descend into a single child that is a valid draft so the skill still
 * registers instead of getting stuck invisibly in the inbox.
 */
function singleNestedDraft(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const childDrafts = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childDir = path.join(dir, entry.name);
    const manifest = readDraftManifest(childDir);
    if (manifest) childDrafts.push({ dir: childDir, manifest });
  }
  return childDrafts.length === 1 ? childDrafts[0] : null;
}

function collectLearnedSkillDrafts(registerSkillDir, inboxDir = learnedSkillsInboxDir(), context = {}) {
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
      let target = dir;
      let manifest = readDraftManifest(dir);
      if (!manifest) {
        const nested = singleNestedDraft(dir);
        if (nested) {
          target = nested.dir;
          manifest = nested.manifest;
        }
      }
      if (!manifest) continue;
      const id = registerSkillDir(target, manifest, context);
      if (id) {
        fs.rmSync(dir, { recursive: true, force: true });
        registered.push(id);
      }
    } catch {
      // generated skill stays in the inbox; never fail the turn over it
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
