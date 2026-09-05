"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { parseFrontmatter } = require("./skill-frontmatter");
const ROOTS = [".agents/skills", ".claude/skills", ".opencode/skills", ".lily/skills"];
const ID = /^[a-z][a-z0-9-]{1,99}$/;

function within(root, file) {
  const rel = path.relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function discoverWorkspaceLocalSkills(workspacePath, { installedIds = [], maxSkills = 40 } = {}) {
  const report = { skills: [], shadowed: [], undescribed: [], skipped: [], fingerprint: "" };
  if (process.env.LILY_WORKSPACE_SKILLS === "0" || !workspacePath) return report;
  try {
    const root = fs.realpathSync(workspacePath);
    const installed = new Set(installedIds);
    const seen = new Set();
    let inspected = 0;
    const hash = createHash("sha256").update(root);
    const limit = Number.isFinite(maxSkills) ? Math.max(0, Math.min(40, maxSkills)) : 40;
    for (const convention of ROOTS) {
      const base = path.join(root, convention);
      let names;
      try {
        if (!within(root, fs.realpathSync(base))) continue;
        names = fs.readdirSync(base).sort();
      } catch { continue; }
      for (const id of names) {
        if (!ID.test(id)) continue;
        if (installed.has(id) || seen.has(id)) { report.shadowed.push(id); continue; }
        if (report.skills.length >= limit || inspected >= 160) { report.skipped.push(id); continue; }
        inspected++;
        try {
          const skillDir = fs.realpathSync(path.join(base, id));
          const file = fs.realpathSync(path.join(skillDir, "SKILL.md"));
          if (!within(root, skillDir) || !within(root, file)) { report.skipped.push(id); continue; }
          const stat = fs.statSync(file);
          if (!stat.isFile() || stat.size > 256 * 1024) { report.skipped.push(id); continue; }
          const raw = fs.readFileSync(file, "utf8");
          hash.update(file).update("\0").update(raw).update("\0");
          const { meta } = parseFrontmatter(raw);
          if (!meta.description?.trim()) { report.undescribed.push(id); continue; }
          seen.add(id);
          const packs = meta["runtime-packs"]?.split(",").map(id => id.trim()) || [];
          report.skills.push({ id, skillDir, guidePath: path.join(skillDir, "SKILL.md"), origin: "workspace-local", manifest: {
            id, name: meta.name || id, description: meta.description,
            requiredRuntimePacks: packs,
          } });
        } catch { report.skipped.push(id); }
      }
    }
    report.fingerprint = hash.digest("hex");
  } catch { /* absent/unreadable workspace leaves today's guide intact */ }
  return report;
}

function selectWorkspaceSkills(skills, session) {
  if (!Array.isArray(session?.enabledSkillIds)) return skills;
  const ids = new Set(session.enabledSkillIds);
  return skills.filter(skill => ids.has(skill.id));
}

function workspaceSkillsForSession(workspacePath, session, installedIds) {
  const report = discoverWorkspaceLocalSkills(workspacePath, { installedIds });
  return { ...report, skills: selectWorkspaceSkills(report.skills, session) };
}

// Dollar invocations and model-authored intent contract IDs are explicit task
// selections. Merely discussing a skill by name must not trigger downloads.
function selectTaskSkills(text, skills, intentContract = null) {
  const tokens = new Set([...String(text || "").matchAll(/(?:^|\s)\$([a-z][a-z0-9-]*)(?![a-z0-9_-])/g)].map(match => match[1]));
  for (const id of Array.isArray(intentContract?.neededCapabilities) ? intentContract.neededCapabilities : []) {
    if (typeof id === "string") tokens.add(id);
  }
  return skills.filter(skill => tokens.has(skill.id));
}

function selectedSkillsForTurn(session, workspacePath, text, manager = null, intentContract = null) {
  try {
    const mgr = manager || require("./skill-manager");
    const installedIds = mgr.getAllInstalledSkillIds();
    const local = workspaceSkillsForSession(workspacePath, session, installedIds).skills;
    const installed = mgr.resolveSessionSkillIds(session).map(id => ({ id, manifest: mgr.readInstalledManifest(id) }));
    return selectTaskSkills(text, [...installed, ...local], intentContract);
  } catch { return []; }
}

module.exports = { discoverWorkspaceLocalSkills, selectWorkspaceSkills, workspaceSkillsForSession, selectTaskSkills, selectedSkillsForTurn };
