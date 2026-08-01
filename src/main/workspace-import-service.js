"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { defaultSessionTitle } = require("./session-manager");
const { importPausedTaskTemplates } = require("./scheduled-task-portability");
const {
  assertImportArchiveLimits,
  importWorkspacePack,
  readPackManifest,
} = require("./workspace-share");
const { DEFAULT_MAX_PACKAGE_BYTES } = require("./workspace-package-inspector");
const {
  importCharacterWorldsPack,
  unpackCharacterWorldsSection,
} = require("./character-worlds/workspace-portability");
const { resolveCharacterOwnerScope } = require("./character-worlds/owner-scope");

function safeFolderName(value) {
  return String(value || "imported-workspace")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .slice(0, 80) || "imported-workspace";
}

function uniqueTargetDir(parentDir, folderName) {
  const baseName = safeFolderName(folderName);
  let targetDir = path.join(parentDir, baseName);
  let suffix = 2;
  while (fs.existsSync(targetDir)) {
    targetDir = path.join(parentDir, `${baseName}-${suffix++}`);
  }
  return targetDir;
}

function restoreWorkspaceSkills(skillManager, workspaceSkills, projectId) {
  const restored = [];
  for (const skill of Array.isArray(workspaceSkills) ? workspaceSkills : []) {
    const id = skillManager?.restoreWorkspaceSkillDir?.(skill.dir, skill.manifest, {
      enabled: skill.enabled,
      projectId,
    });
    if (id) restored.push(id);
  }
  return restored;
}

function selectedTemplates(templates, indexes) {
  const selected = new Set(
    (Array.isArray(indexes) ? indexes : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0),
  );
  return (Array.isArray(templates) ? templates : [])
    .filter((_template, index) => selected.has(index));
}

async function computePackContentSha256(zip) {
  assertImportArchiveLimits(zip);
  const names = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name)
    .filter((name) => name !== ".lilyspace/lily-workspace.json")
    .filter((name) => name !== "lily-workspace.json")
    .sort();
  const hash = crypto.createHash("sha256");
  for (const name of names) {
    const content = await zip.file(name).async("nodebuffer");
    hash.update(`${Buffer.byteLength(name, "utf8")}:`);
    hash.update(name);
    hash.update(`:${content.length}:`);
    hash.update(content);
  }
  return hash.digest("hex");
}

async function verifyLocalApp(manifest, zip, options = {}) {
  if (manifest?.kind !== "lily-workspace-app") return;
  const signature = String(manifest.signature || "");
  if (!signature) {
    if (process.env.LILY_REQUIRE_APP_SIGNATURE === "1") throw new Error("SIGNATURE_MISSING");
    return;
  }
  const appId = String(manifest.appId || "").trim();
  const sha256 = await computePackContentSha256(zip);
  const { verifyDetached } = require("./crypto-signing");
  const publicKey = options.publicKey || require("./license-manager").loadPublicKey();
  if (!verifyDetached({ appId, sha256 }, signature, publicKey)) {
    throw new Error("SIGNATURE_INVALID");
  }
}

async function installAppDependencies(ctx, manifest) {
  const skillManager = ctx.skillManager || require("./skill-manager");
  const runtimePackInstaller = ctx.runtimePackInstaller || require("./runtime-pack-installer");
  const requiredSkills = [...new Set(
    (Array.isArray(manifest.requiredSkills) ? manifest.requiredSkills : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  )];
  const requiredRuntimePacks = [...new Set(
    (Array.isArray(manifest.requiredRuntimePacks) ? manifest.requiredRuntimePacks : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  )];
  const enabledSkills = new Set(skillManager.getGloballyEnabledSkillIds?.() || []);
  const installedPacks = runtimePackInstaller.installedRuntimePackIds?.() || new Set();
  const installedDependencies = { skills: [], runtimePacks: [] };
  const failedDependencies = { skills: [], runtimePacks: [] };

  for (const id of requiredSkills) {
    const alreadyInstalled = Boolean(skillManager.readInstalledManifest?.(id));
    if (!alreadyInstalled && !enabledSkills.has(id)) {
      const installed = await skillManager.installFromRegistry(id);
      if (!installed?.ok) {
        failedDependencies.skills.push({ id, error: installed?.error || "INSTALL_FAILED" });
        continue;
      }
      installedDependencies.skills.push(id);
    }
    const enabled = skillManager.setSkillEnabled(id, true);
    if (!enabled?.ok) {
      failedDependencies.skills.push({ id, error: enabled?.error || "ENABLE_FAILED" });
    }
  }
  for (const id of requiredRuntimePacks) {
    if (installedPacks.has(id)) continue;
    const installed = await runtimePackInstaller.installRuntimePack(id);
    if (installed?.ok) installedDependencies.runtimePacks.push(id);
    else failedDependencies.runtimePacks.push({ id, error: installed?.error || "INSTALL_FAILED" });
  }
  return {
    ok: failedDependencies.skills.length === 0 &&
      failedDependencies.runtimePacks.length === 0,
    installedDependencies,
    failedDependencies,
  };
}

async function importWorkspacePackagePath(ctx, payload = {}) {
  const filePath = String(payload.filePath || "").trim();
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ok: false, error: "NOT_A_FILE" };
  }
  if (!filePath || !stat.isFile()) {
    return { ok: false, error: "NOT_A_FILE" };
  }
  const maxPackageBytes = Math.max(
    1,
    Number(ctx.maxWorkspacePackageBytes || DEFAULT_MAX_PACKAGE_BYTES),
  );
  if (stat.size > maxPackageBytes) {
    return { ok: false, error: "PACKAGE_TOO_LARGE" };
  }
  const zipBuffer = fs.readFileSync(filePath);
  const { manifest: peek, zip } = await readPackManifest(zipBuffer);
  await verifyLocalApp(peek, zip);
  const dependencyResult = peek.kind === "lily-workspace-app"
    ? await installAppDependencies(ctx, peek)
    : { ok: true, installedDependencies: { skills: [], runtimePacks: [] } };
  if (!dependencyResult.ok) {
    return {
      ok: false,
      error: "APP_DEPENDENCY_INSTALL_FAILED",
      failedDependencies: dependencyResult.failedDependencies,
      installedDependencies: dependencyResult.installedDependencies,
    };
  }

  const parentDir = path.resolve(
    payload.targetParent ||
    path.dirname(ctx.projectManager?.defaultPath || filePath),
  );
  fs.mkdirSync(parentDir, { recursive: true });
  const targetDir = uniqueTargetDir(
    parentDir,
    peek.folderName || peek.appId || peek.name || "imported-workspace",
  );

  let project = null;
  try {
    const imported = await importWorkspacePack(zipBuffer, targetDir);
    project = ctx.projectManager.add(targetDir);
    if (imported.manifest.name) {
      ctx.projectManager.rename(project.id, imported.manifest.name);
    }
    const writeConventions = ctx.writeLearnedConventions ||
      require("./learned-context").writeLearnedConventions;
    if (imported.conventions) writeConventions(project.id, imported.conventions);
    const skillManager = ctx.skillManager || require("./skill-manager");
    const restoredWorkspaceSkills = restoreWorkspaceSkills(
      skillManager,
      imported.workspaceSkills,
      project.id,
    );
    const sessionTitle = ctx.defaultSessionTitle?.() || defaultSessionTitle();
    const session = ctx.sessionManager.create(project.id, sessionTitle);
    const chosenAutomations = selectedTemplates(
      imported.automationTemplates,
      payload.selectedAutomationIndexes,
    );
    const automationResult = chosenAutomations.length
      ? importPausedTaskTemplates(ctx.scheduledTaskManager, chosenAutomations, {
          projectId: project.id,
          sessionId: session.id,
        })
      : { ok: true, tasks: [], skipped: [] };
    if (!automationResult?.ok) {
      throw new Error(
        `AUTOMATION_IMPORT_FAILED:${automationResult?.error || "UNKNOWN"}`,
      );
    }

    let installedApp = null;
    if (imported.manifest.kind === "lily-workspace-app") {
      const installs = ctx.workspaceAppInstalls || require("./workspace-app-installs");
      installedApp = installs.recordInstalled({
        app: {
          id: imported.manifest.appId,
          name: imported.manifest.name,
          latestVersion: imported.manifest.version,
          sha256: crypto.createHash("sha256").update(zipBuffer).digest("hex"),
        },
        manifest: imported.manifest,
        project,
        targetDir,
        installParentDir: parentDir,
        installedDependencies: dependencyResult.installedDependencies,
      });
    }

    const installed = new Set(skillManager.getGloballyEnabledSkillIds?.() || []);
    const missingSkills = (imported.manifest.requiredSkills || [])
      .filter((id) => !installed.has(id));

    // Character Worlds section: import into the local library when present.
    // A failure here degrades the PACK, not the workspace: the project still
    // imports, and the section result (with diagnostics) is returned so the
    // UI can surface what did / didn't restore. The same hostile pipeline
    // applies — every entity is validated and gets NEW local ids.
    let characterWorlds = null;
    if (imported.characterWorlds) {
      const repo = ctx.characterWorldsRepository;
      const ownerScope = resolveCharacterOwnerScope();
      try {
        if (!repo || typeof ownerScope !== "string" || !ownerScope) {
          characterWorlds = { ok: false, error: "OWNER_SCOPE_UNAVAILABLE" };
        } else {
          const section = unpackCharacterWorldsSection(imported.characterWorlds);
          characterWorlds = importCharacterWorldsPack(repo, ownerScope, section);
        }
      } catch (error) {
        characterWorlds = {
          ok: false,
          error: error?.code || error?.message || "IMPORT_FAILED",
        };
      }
    }

    return {
      ok: true,
      state: ctx.projectManager.getAppState(),
      projectId: project.id,
      projectName: imported.manifest.name || project.name,
      sessionId: session.id,
      characterWorlds,
      workspacePath: targetDir,
      missingSkills,
      restoredWorkspaceSkills,
      importedAutomations: automationResult.tasks || [],
      skippedAutomations: [
        ...(imported.skippedAutomations || []),
        ...(automationResult.skipped || []),
      ],
      installedApp,
    };
  } catch (err) {
    if (project?.id) {
      ctx.sessionManager?.purgeProject?.(project.id);
      ctx.projectManager?.remove?.(project.id);
    }
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    throw err;
  }
}

module.exports = {
  computePackContentSha256,
  installAppDependencies,
  importWorkspacePackagePath,
  safeFolderName,
  selectedTemplates,
  uniqueTargetDir,
  verifyLocalApp,
};
