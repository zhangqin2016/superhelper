"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JSZip = require("jszip");
const { isAppVersionCompatible } = require("./skill-version");
const { findSkillRoot } = require("./skill-root");
const { copyDirRecursiveShipSafe } = require("./ship-ignore");
const { PROTECTED_BUNDLED_IDS, readJsonFile } = require("./skills-state");
const { safeJoin } = require("./workspace-share");

const SKILL_ID_RE = /^[a-z][a-z0-9-]{1,99}$/;
const MAX_WORKSPACE_SKILL_IMPORT_BYTES = 200 * 1024 * 1024;

function normalizeWorkspaceSkillId(id = "") {
  const raw = String(id || "").trim();
  if (!SKILL_ID_RE.test(raw)) return "";
  const next = raw.startsWith("learned-") ? raw : `learned-${raw}`;
  return SKILL_ID_RE.test(next) ? next : "";
}

function validateWorkspaceSkillRoot(skillRoot) {
  if (!skillRoot || !fs.existsSync(skillRoot)) {
    return { ok: false, error: "INVALID_MANIFEST", detail: "Skill root not found" };
  }
  const skillMdPath = path.join(skillRoot, "SKILL.md");
  const manifestPath = path.join(skillRoot, "skill.manifest.json");
  if (!fs.existsSync(skillMdPath) || !fs.existsSync(manifestPath)) {
    return { ok: false, error: "INVALID_MANIFEST", detail: "SKILL.md and skill.manifest.json are required" };
  }
  const manifest = readJsonFile(manifestPath);
  if (!manifest || manifest.schemaVersion !== 1) {
    return { ok: false, error: "INVALID_MANIFEST", detail: "Invalid skill manifest" };
  }
  const id = normalizeWorkspaceSkillId(manifest.id);
  if (!id) return { ok: false, error: "INVALID_MANIFEST", detail: "Invalid skill id" };
  if (PROTECTED_BUNDLED_IDS.has(id) || PROTECTED_BUNDLED_IDS.has(String(manifest.id || ""))) {
    return { ok: false, error: "BUNDLED_PROTECTED" };
  }
  if (manifest.runtime && manifest.runtime !== "node" && manifest.runtime !== "none") {
    return { ok: false, error: "INVALID_MANIFEST", detail: "Only node or none runtime is supported" };
  }
  if (manifest.minAppVersion && !isAppVersionCompatible(manifest.minAppVersion)) {
    return { ok: false, error: "INVALID_MANIFEST", detail: "A newer version of the application is required" };
  }
  if (fs.existsSync(path.join(skillRoot, "node_modules"))) {
    return { ok: false, error: "INVALID_MANIFEST", detail: "node_modules is not allowed in workspace skills" };
  }
  return {
    ok: true,
    id,
    sourceId: String(manifest.id || ""),
    manifest,
  };
}

function normalizeSkillForImport(skillRoot, targetRoot) {
  const validated = validateWorkspaceSkillRoot(skillRoot);
  if (!validated.ok) return validated;

  const target = path.join(targetRoot, validated.id);
  copyDirRecursiveShipSafe(skillRoot, target);
  const normalizedManifest = {
    ...validated.manifest,
    id: validated.id,
    origin: "workspace",
    workspaceOnly: true,
    publisher: validated.manifest.publisher || "Workspace",
    version: String(validated.manifest.version || "0.1.0"),
  };
  fs.writeFileSync(
    path.join(target, "skill.manifest.json"),
    `${JSON.stringify(normalizedManifest, null, 2)}\n`,
    "utf8",
  );
  return {
    ok: true,
    id: validated.id,
    sourceId: validated.sourceId,
    dir: target,
    enabled: true,
    manifest: normalizedManifest,
  };
}

async function extractZip(zipPath, extractDir) {
  const stat = fs.statSync(zipPath);
  if (stat.size > MAX_WORKSPACE_SKILL_IMPORT_BYTES) {
    throw new Error("SKILLPACK_TOO_LARGE");
  }
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const dest = safeJoin(extractDir, entry.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, await entry.async("nodebuffer"));
  }
}

async function importWorkspacePackSkills(zipPath, tempRoot, options = {}) {
  const { importWorkspacePack } = require("./workspace-share");
  const packDir = path.join(tempRoot, "workspace-pack");
  let imported;
  try {
    imported = await importWorkspacePack(fs.readFileSync(zipPath), packDir);
  } catch (err) {
    if (["NOT_A_WORKSPACE_PACK", "MANIFEST_CORRUPT", "PACK_TOO_NEW", "WORKSPACE_PACK_EMPTY"].includes(err?.message)) {
      return null;
    }
    return { ok: false, error: "INVALID_MANIFEST", detail: err?.message || "Workspace pack import failed" };
  }

  const skills = Array.isArray(imported?.workspaceSkills) ? imported.workspaceSkills : [];
  if (!skills.length) return null;

  const ids = [];
  const normalizedRoot = path.join(tempRoot, "normalized-pack-skills");
  fs.mkdirSync(normalizedRoot, { recursive: true });
  for (const skill of skills) {
    const normalized = normalizeSkillForImport(skill.dir, normalizedRoot);
    if (!normalized.ok) return normalized;
    if (typeof options.restore === "function") {
      const restoredId = options.restore(normalized);
      if (!restoredId) return { ok: false, error: "INVALID_MANIFEST", detail: "Skill could not be restored" };
      ids.push(restoredId);
    } else {
      ids.push(normalized.id);
    }
  }
  return { ok: true, id: ids.join(", "), ids };
}

async function importWorkspaceSkillSource(sourcePath, options = {}) {
  const source = String(sourcePath || "");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-workspace-skill-import-"));
  const normalizedRoot = path.join(tempRoot, "normalized");
  fs.mkdirSync(normalizedRoot, { recursive: true });
  try {
    const stat = fs.statSync(source);
    let searchRoot = source;
    if (stat.isFile()) {
      const packResult = await importWorkspacePackSkills(source, tempRoot, options);
      if (packResult) return packResult;

      const extractDir = path.join(tempRoot, "extract");
      fs.mkdirSync(extractDir, { recursive: true });
      await extractZip(source, extractDir);
      searchRoot = extractDir;
    }
    const skillRoot = findSkillRoot(searchRoot);
    const normalized = normalizeSkillForImport(skillRoot, normalizedRoot);
    if (!normalized.ok) return normalized;

    if (typeof options.restore === "function") {
      const restoredId = options.restore(normalized);
      if (!restoredId) return { ok: false, error: "INVALID_MANIFEST", detail: "Skill could not be restored" };
      return { ok: true, id: restoredId, sourceId: normalized.sourceId, manifest: normalized.manifest };
    }

    return { ok: true, skill: normalized };
  } catch (err) {
    if (err?.message === "SKILLPACK_TOO_LARGE") {
      return { ok: false, error: "INVALID_MANIFEST", detail: "Skill package exceeds size limit" };
    }
    if (err?.message === "ZIP_SLIP" || /^UNSAFE_PATH:/.test(err?.message || "")) {
      return { ok: false, error: "INVALID_MANIFEST", detail: "Archive path is unsafe" };
    }
    return { ok: false, error: "INVALID_MANIFEST", detail: err?.message || "Import failed" };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

module.exports = {
  MAX_WORKSPACE_SKILL_IMPORT_BYTES,
  normalizeWorkspaceSkillId,
  validateWorkspaceSkillRoot,
  importWorkspaceSkillSource,
};
