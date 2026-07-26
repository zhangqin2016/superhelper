"use strict";

const fs = require("node:fs");
const { readPackManifest } = require("./workspace-share");
const {
  AUTOMATIONS_ENTRY,
  readAutomationEntry,
} = require("./scheduled-task-portability");

const DEFAULT_MAX_PACKAGE_BYTES = 250 * 1024 * 1024;

function stringList(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  )];
}

function unrecognized(reason = "NOT_A_WORKSPACE_PACK") {
  return { ok: true, recognized: false, reason };
}

async function inspectWorkspacePackage(filePath, options = {}) {
  const sourcePath = String(filePath || "").trim();
  let stat;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    return unrecognized("NOT_A_FILE");
  }
  if (!stat.isFile()) return unrecognized("NOT_A_FILE");
  const maxPackageBytes = Math.max(1, Number(
    options.maxPackageBytes || DEFAULT_MAX_PACKAGE_BYTES,
  ));
  if (stat.size > maxPackageBytes) return unrecognized("PACKAGE_TOO_LARGE");

  try {
    const buffer = fs.readFileSync(sourcePath);
    const { zip, manifest } = await readPackManifest(buffer);
    const automations = await readAutomationEntry(zip.file(AUTOMATIONS_ENTRY));
    const kind = String(manifest.kind || "");
    const isApp = kind === "lily-workspace-app";
    return {
      ok: true,
      recognized: true,
      filePath: sourcePath,
      sizeBytes: stat.size,
      kind,
      appId: String(manifest.appId || ""),
      name: String(manifest.name || manifest.appId || "Lily Workspace"),
      version: String(manifest.version || ""),
      publisher: String(manifest.publisher || ""),
      signaturePresent: Boolean(manifest.signature),
      requiredSkills: stringList(manifest.requiredSkills),
      requiredRuntimePacks: stringList(manifest.requiredRuntimePacks),
      workspaceSkills: Array.isArray(manifest.workspaceSkills)
        ? manifest.workspaceSkills.map((skill) => ({
            id: String(skill?.id || ""),
            name: String(skill?.name || skill?.id || ""),
            version: String(skill?.version || ""),
          })).filter((skill) => skill.id)
        : [],
      automationCount: automations.automationTemplates.length,
      automationTemplates: automations.automationTemplates,
      skippedAutomations: automations.skippedAutomations,
      riskWarnings: isApp && !manifest.signature ? ["UNSIGNED_LOCAL_APP"] : [],
    };
  } catch (err) {
    return unrecognized(String(err?.message || "NOT_A_WORKSPACE_PACK"));
  }
}

module.exports = {
  DEFAULT_MAX_PACKAGE_BYTES,
  inspectWorkspacePackage,
};
