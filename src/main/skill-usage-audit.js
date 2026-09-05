"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SKILL_GUIDE_BASENAME = "SKILL.md";
const MAX_SKILLS_TO_CONSIDER = 80;
const MAX_MATCHED_SKILLS = 8;
const MIN_TOKEN_OVERLAP = 2;

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "from",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "use",
  "when",
  "with",
  "这个",
  "我们",
  "你来",
  "帮我",
  "一下",
  "可以",
]);

function normalizePath(value = "") {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
}

function readSkillFrontmatter(skillDir = "") {
  try {
    const raw = fs.readFileSync(path.join(skillDir, SKILL_GUIDE_BASENAME), "utf8").replace(/\r\n/g, "\n");
    return require("./skill-frontmatter").parseFrontmatter(raw).meta;
  } catch {
    return {};
  }
}

function localizedField(manifest = {}, field = "") {
  const direct = typeof manifest[field] === "string" ? manifest[field] : "";
  const i18n = manifest[`${field}_i18n`];
  if (!i18n || typeof i18n !== "object") return direct;
  return [i18n["zh-CN"], i18n.zh, i18n.en, direct].filter(Boolean).join(" ");
}

function tokenize(text = "") {
  const source = String(text || "").toLowerCase();
  const tokens = new Set();
  for (const match of source.matchAll(/[a-z0-9][a-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}/g)) {
    const token = match[0];
    if (!STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

function skillGuidePath(skillDir = "") {
  return normalizePath(path.join(skillDir, SKILL_GUIDE_BASENAME));
}

function isSkillGuideRead(tool = {}) {
  const name = String(tool.name || tool.tool || "").toLowerCase();
  if (!["read", "notebookread"].includes(name)) return false;
  const input = tool.input || {};
  const filePath = normalizePath(input.file_path || input.filePath || input.path || input.notebook_path || "");
  return Boolean(filePath && path.basename(filePath).toLowerCase() === "skill.md");
}

function pathMatches(file = "", guide = "") {
  const readPath = normalizePath(file);
  const guidePath = normalizePath(guide);
  if (!readPath || !guidePath) return false;
  return readPath === guidePath || readPath.endsWith(`/${guidePath}`) || guidePath.endsWith(`/${readPath}`);
}

function collectSkillGuideReads(tools = []) {
  const reads = [];
  for (const tool of tools || []) {
    if (!isSkillGuideRead(tool)) continue;
    const input = tool.input || {};
    const filePath = normalizePath(input.file_path || input.filePath || input.path || input.notebook_path || "");
    if (filePath) reads.push(filePath);
  }
  return [...new Set(reads)];
}

function buildSkillCandidates({ userText = "", session = null, skillManager = null, workspaceSkills = [] } = {}) {
  const mgr = skillManager || require("./skill-manager");
  const userTokens = tokenize(userText);
  const ids = mgr.resolveSessionSkillIds(session).slice(0, MAX_SKILLS_TO_CONSIDER);
  const candidates = [];
  const entries = [...ids.map(id => ({ id, skillDir: mgr.installedSkillDir(id), manifest: mgr.readInstalledManifest(id) })), ...workspaceSkills];
  for (const entry of entries) {
    const { id, skillDir } = entry;
    const guidePath = path.join(skillDir, SKILL_GUIDE_BASENAME);
    if (!fs.existsSync(guidePath)) continue;
    const manifest = entry.manifest || {};
    const frontmatter = readSkillFrontmatter(skillDir);
    const haystack = [
      id,
      localizedField(manifest, "name"),
      localizedField(manifest, "description"),
      frontmatter.name || "",
      frontmatter.description || "",
    ].join(" ");
    const skillTokens = tokenize(haystack);
    let overlap = 0;
    for (const token of userTokens) {
      if (skillTokens.has(token)) overlap += 1;
    }
    const explicit = userText.includes(id) || (frontmatter.name && userText.includes(frontmatter.name));
    if (!explicit && overlap < MIN_TOKEN_OVERLAP) continue;
    candidates.push({
      id,
      guidePath: skillGuidePath(skillDir),
      matched: explicit ? "explicit" : "token_overlap",
      score: explicit ? 100 : overlap,
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return candidates.slice(0, MAX_MATCHED_SKILLS);
}

function buildSkillUsageAudit({ userText = "", session = null, tools = [], skillManager = null, workspacePath = "", workspaceSkills = null } = {}) {
  const mgr = skillManager || require("./skill-manager");
  const local = workspaceSkills || require("./workspace-local-skills").workspaceSkillsForSession(workspacePath, session, mgr.getAllInstalledSkillIds?.() || mgr.resolveSessionSkillIds(session)).skills;
  const candidates = buildSkillCandidates({ userText, session, skillManager: mgr, workspaceSkills: local });
  const guideReadEvidence = require("./skill-read-evidence").collectSkillGuideReadEvidence(tools, workspacePath);
  const guideReads = collectSkillGuideReads(tools);
  const usedSkillIds = [];
  const missingGuideReads = [];
  for (const candidate of candidates) {
    const read = guideReads.some((file) => pathMatches(file, candidate.guidePath));
    if (read) usedSkillIds.push(candidate.id);
    else missingGuideReads.push(candidate.id);
  }
  return {
    schemaVersion: 2,
    measurement: "candidate matches and current-turn read observations; not model selection or task success",
    guideReadEvidence,
    mode: "advisory",
    candidateCount: candidates.length,
    candidates,
    guideReads,
    usedSkillIds,
    missingGuideReads,
    ok: missingGuideReads.length === 0,
  };
}

module.exports = {
  buildSkillUsageAudit,
  buildSkillCandidates,
  collectSkillGuideReads,
  collectSkillGuideReadEvidence: require("./skill-read-evidence").collectSkillGuideReadEvidence,
};
