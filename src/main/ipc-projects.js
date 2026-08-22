"use strict";

const { ipcMain, dialog, shell } = require("electron");
const { ensureSessionRunner } = require("./ipc-utils");
const { defaultSessionTitle } = require("./session-manager");
const { fetchArtifactBuffer } = require("./artifact-download");
const { registerWorkspaceExportHandlers } = require("./ipc-workspace-export");
const { registerWorkspaceImportHandlers } = require("./ipc-workspace-import");

// No client-side size cap on workspace-app downloads — the server is the
// authority (it enforces a max at publish time) and the zip is sha256-verified
// after download. A generous timeout so a large, server-approved app still lands.
const WORKSPACE_APP_DOWNLOAD_TIMEOUT_MS = 600_000;

function isProjectBusy(ctx, projectId) {
  try {
    const project = ctx.projectManager?.find?.(projectId);
    if (project && ctx.workspaceVersionService?.isMutating?.(project.path)) return true;
    if (!ctx?.turnOrchestrator?.snapshot || !ctx?.sessionManager?.listForProject) return false;
    return ctx.sessionManager.listForProject(projectId).some((session) => {
      const snapshot = ctx.turnOrchestrator.snapshot(session.id);
      return !snapshot || snapshot.phase !== "idle" || Number(snapshot.queueLength) > 0;
    });
  } catch {
    // A mutating version operation must not race an unknown runner state.
    return true;
  }
}

function isVersionId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{6,99}$/.test(String(value || "").trim());
}

function safeFolderName(value) {
  return String(value || "workspace-app")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .slice(0, 80) || "workspace-app";
}

function workspaceAppFolderName({ manifest, app }) {
  return safeFolderName(
    manifest?.folderName ||
    app?.folderName ||
    manifest?.appId ||
    app?.id ||
    manifest?.name ||
    app?.name ||
    "workspace-app",
  );
}

function restoreWorkspaceSkills(skillManager, workspaceSkills, projectId = "") {
  const restored = [];
  for (const skill of Array.isArray(workspaceSkills) ? workspaceSkills : []) {
    const id = skillManager.restoreWorkspaceSkillDir(skill.dir, skill.manifest, {
      enabled: skill.enabled,
      projectId,
    });
    if (id) restored.push(id);
  }
  return restored;
}

async function downloadWorkspaceApp(app) {
  let url = String(app?.downloadUrl || "").trim();
  // Gated (VIP/pro) apps carry no inline URL in the catalog — resolve it through
  // the signed, entitlement-checked endpoint. A non-entitled device gets 403,
  // which we surface as NOT_ENTITLED so the UI can explain it needs an upgrade.
  if (!url && app?.gated) {
    const res = await require("./service-client").workspaceAppDownload(app?.id, app?.channel);
    if (!res.ok) {
      if (res.status === 403 || res.error === "NOT_ENTITLED") {
        throw new Error("WORKSPACE_APP_NOT_ENTITLED");
      }
      throw new Error("WORKSPACE_APP_DOWNLOAD_UNAVAILABLE");
    }
    url = String(res.json?.app?.downloadUrl || "").trim();
  }
  if (!/^https:\/\//i.test(url)) {
    throw new Error("INVALID_APP_DOWNLOAD_URL");
  }
  try {
    return await fetchArtifactBuffer(url, {
      timeoutMs: WORKSPACE_APP_DOWNLOAD_TIMEOUT_MS,
      maxBytes: Infinity, // no client cap — defer to the server's published-size limit
    });
  } catch (error) {
    if (error?.message === "ARTIFACT_TOO_LARGE") {
      throw new Error("WORKSPACE_APP_TOO_LARGE");
    }
    if (/^HTTP \d+/.test(error?.message || "")) {
      throw new Error(`DOWNLOAD_FAILED_${error.message.replace("HTTP ", "")}`);
    }
    throw error;
  }
}

function registerProjectHandlers(ctx) {
  const { mainWindow, projectManager, sessionManager, runnerPool } = ctx;
  const versionService = ctx.workspaceVersionService;

  function resolveVersionProject(projectId) {
    const project = projectManager.find(String(projectId || ""));
    if (!project) {
      const error = new Error("PROJECT_NOT_FOUND");
      error.code = "PROJECT_NOT_FOUND";
      throw error;
    }
    if (!versionService) {
      const error = new Error("VERSION_CONTROL_UNAVAILABLE");
      error.code = "VERSION_CONTROL_UNAVAILABLE";
      throw error;
    }
    return project;
  }

  async function versionCall(projectId, operation, { mutating = false } = {}) {
    try {
      const project = resolveVersionProject(projectId);
      if (mutating && isProjectBusy(ctx, project.id)) return { ok: false, error: "WORKSPACE_BUSY" };
      return await operation(project);
    } catch (error) {
      return {
        ok: false,
        error: String(error?.code || "VERSION_CONTROL_FAILED").slice(0, 80),
      };
    }
  }

  ipcMain.handle("project:list", () => projectManager.getAppState());

  ipcMain.handle("project:add", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select Folder",
      // createDirectory shows the "New Folder" button in the macOS dialog so a
      // workspace can be created on the spot; Windows' folder picker has it natively.
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    // Adding an already-registered folder just switches to it — tell the
    // renderer so it can say so instead of looking like nothing happened.
    const alreadyExists = projectManager.hasPath(result.filePaths[0]);
    const project = projectManager.add(result.filePaths[0]);
    if (!alreadyExists) {
      sessionManager.create(project.id, defaultSessionTitle());
    } else {
      // projectManager.add changes the active workspace, but does not own the
      // active conversation. Keep both pointers in the same workspace so the
      // next message cannot be sent to the previous project's session.
      const sessions = sessionManager.listForProject(project.id);
      if (sessions.length > 0) sessionManager.switchTo(sessions[0].id);
      else sessionManager.create(project.id, defaultSessionTitle());
    }
    return { ok: true, state: projectManager.getAppState(), existed: alreadyExists, projectId: project.id };
  });

  ipcMain.handle("project:switch", (_event, projectId) => {
    if (!projectManager.switchTo(projectId)) {
      return { ok: false, error: "NOT_FOUND" };
    }
    const sessions = sessionManager.listForProject(projectId);
    if (sessions.length > 0) {
      sessionManager.activeSessionId = sessions[0].id;
      sessionManager.save();
      ensureSessionRunner(ctx, sessions[0].id);
    }
    return { ok: true, state: projectManager.getAppState(), sessions };
  });

  ipcMain.handle("project:rename", (_event, projectId, name) => {
    const trimmed = String(name || "").trim();
    if (!projectManager.rename(projectId, trimmed)) return { ok: false, error: "INVALID" };
    return { ok: true, state: projectManager.getAppState() };
  });

  ipcMain.handle("project:reorder", async (_event, projectIds) => {
    projectManager.reorder(projectIds);
    return { ok: true, state: projectManager.getAppState() };
  });

  ipcMain.handle("project:open", async (_event, projectId) => {
    const project = projectManager.find(projectId);
    if (!project) return { ok: false, error: "NOT_FOUND" };
    const error = await shell.openPath(project.path);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle("project:remove", (_event, projectId) => {
    const sessionIds = sessionManager.purgeProject(projectId);
    for (const sessionId of sessionIds) {
      runnerPool.terminateSession(sessionId);
    }
    const result = projectManager.remove(projectId);
    if (result !== "OK") return { ok: false, error: result };

    const active = projectManager.getActive();
    if (!active) {
      sessionManager.activeSessionId = null;
      sessionManager.save();
    } else {
      sessionManager.ensureDefaultForProject(active.id);
      if (!sessionManager.findById(sessionManager.activeSessionId)) {
        const remaining = sessionManager.listForProject(active.id);
        if (remaining.length > 0) {
          sessionManager.switchTo(remaining[0].id);
        }
      }
    }

    return { ok: true, state: projectManager.getAppState() };
  });

  ipcMain.handle("project:version-status", (_event, projectId) =>
    versionCall(projectId, (project) => versionService.status(project.path)));
  ipcMain.handle("project:version-history", (_event, projectId, limit = 50) =>
    versionCall(projectId, (project) => versionService.history(project.path, limit)));
  ipcMain.handle("project:version-save", (_event, projectId) =>
    versionCall(projectId, (project) => versionService.save(project.path, "manual"), { mutating: true }));
  ipcMain.handle("project:version-restore", (_event, projectId, revision) => {
    const id = String(revision || "").trim();
    if (!isVersionId(id)) return { ok: false, error: "INVALID_VERSION" };
    return versionCall(projectId, (project) => versionService.restore(project.path, id), { mutating: true });
  });
  ipcMain.handle("project:version-preview", (_event, projectId, revision) => {
    const id = String(revision || "").trim();
    if (!isVersionId(id)) return { ok: false, error: "INVALID_VERSION" };
    return versionCall(projectId, (project) => versionService.previewRestore(project.path, id));
  });

  registerWorkspaceExportHandlers(ctx);
  registerWorkspaceImportHandlers(ctx);

  ipcMain.handle("apps:install", async (_event, app) => {
    try {
      const crypto = require("node:crypto");
      const fs = require("node:fs");
      const path = require("node:path");
      const { importWorkspacePack, readPackManifest } = require("./workspace-share");
      const { writeLearnedConventions } = require("./learned-context");
      const skillManager = require("./skill-manager");
      const runtimePackInstaller = require("./runtime-pack-installer");
      const workspaceAppInstalls = require("./workspace-app-installs");

      const zipBuffer = await downloadWorkspaceApp(app);
      const expectedSha = String(app?.sha256 || "").toLowerCase();
      const actualSha = crypto.createHash("sha256").update(zipBuffer).digest("hex");
      if (expectedSha && actualSha !== expectedSha) {
        return { ok: false, error: "CHECKSUM_MISMATCH" };
      }

      // Authenticity: a workspace app carries executable skills/scripts, so verify
      // the publisher's signature over {appId, sha256} — not just integrity. A
      // present-but-invalid signature is always rejected. A missing signature is
      // rejected only when LILY_REQUIRE_APP_SIGNATURE=1 (strict mode); otherwise it
      // installs with a loud warning (transition until the catalog is re-signed).
      {
        const signature = String(app?.signature || "");
        const signedAppId = String(app?.id || "").trim();
        if (signature) {
          const { verifyDetached } = require("./crypto-signing");
          const publicKey = require("./license-manager").loadPublicKey();
          const ok = verifyDetached({ appId: signedAppId, sha256: actualSha }, signature, publicKey);
          if (!ok) {
            return { ok: false, error: "SIGNATURE_INVALID" };
          }
        } else if (process.env.LILY_REQUIRE_APP_SIGNATURE === "1") {
          return { ok: false, error: "SIGNATURE_MISSING" };
        } else {
          require("./logger")
            .getLogger("apps")
            .warn("installing UNSIGNED workspace app %s — no publisher signature", signedAppId || "?");
        }
      }

      const { manifest: peek } = await readPackManifest(zipBuffer);
      const appId = String(app?.id || peek?.appId || "").trim();
      const state = workspaceAppInstalls.readState();
      const existingRecord = app?.forceNewInstance ? null : workspaceAppInstalls.activeRecordForApp(state, appId);
      const defaultBaseDir = workspaceAppInstalls.installRoot(projectManager.defaultPath);
      fs.mkdirSync(defaultBaseDir, { recursive: true });
      // Upgrade in place: when the app is already installed at a managed location,
      // update it right there instead of making the user re-pick a directory.
      // (preferredInstallDialogPath returns the record path only when it exists and
      // is safely replaceable.) Prompt only for a fresh install or "create another".
      const inPlacePath =
        existingRecord &&
        workspaceAppInstalls.preferredInstallDialogPath(projectManager.defaultPath, existingRecord) === existingRecord.path
          ? existingRecord.path
          : null;
      let selectedDir;
      if (inPlacePath) {
        selectedDir = inPlacePath;
      } else {
        const dirPick = await dialog.showOpenDialog(mainWindow, {
          title: existingRecord ? "选择要更新的应用工作空间" : "选择应用工作空间保存位置",
          defaultPath: workspaceAppInstalls.preferredInstallDialogPath(projectManager.defaultPath, existingRecord),
          properties: ["openDirectory", "createDirectory"],
          buttonLabel: existingRecord ? "更新此处" : "创建到此处",
        });
        if (dirPick.canceled || !dirPick.filePaths.length) {
          return { ok: false, canceled: true };
        }
        selectedDir = dirPick.filePaths[0];
      }
      const baseName = workspaceAppFolderName({ manifest: peek, app });
      const resolvedTarget = workspaceAppInstalls.resolveInstallTarget({
        selectedDir,
        defaultWorkspacePath: projectManager.defaultPath,
        record: existingRecord,
        baseName,
      });
      const baseDir = resolvedTarget.baseDir;
      fs.mkdirSync(baseDir, { recursive: true });
      let targetDir = resolvedTarget.targetDir;
      let n = 2;
      while (!resolvedTarget.replaceExisting && fs.existsSync(targetDir)) {
        targetDir = path.join(baseDir, `${baseName}-${n++}`);
      }

      const skillUpdateState = await skillManager.checkRegistryUpdates({ fetch: true });
      const installedSkills = new Set(skillManager.getGloballyEnabledSkillIds());
      const manifestSkills = Array.isArray(peek.requiredSkills) ? peek.requiredSkills : [];
      const catalogSkills = Array.isArray(app?.requiredSkillPackages) ? app.requiredSkillPackages : [];
      const requiredSkills = [...new Set([...manifestSkills, ...catalogSkills])];
      const updateSkillIds = new Set(
        (skillUpdateState.ok ? skillUpdateState.updates : [])
          .map((skill) => skill.id)
          .filter((id) => requiredSkills.includes(id)),
      );
      const skillsToInstall = requiredSkills
        .filter((id) => !installedSkills.has(id) || updateSkillIds.has(id));

      const installedRuntimePacks = runtimePackInstaller.installedRuntimePackIds();
      const manifestRuntimePacks = Array.isArray(peek.requiredRuntimePacks) ? peek.requiredRuntimePacks : [];
      const catalogRuntimePacks = Array.isArray(app?.requiredRuntimePacks) ? app.requiredRuntimePacks : [];
      const requiredRuntimePacks = [...new Set([...manifestRuntimePacks, ...catalogRuntimePacks])];
      const missingRuntimePacks = requiredRuntimePacks
        .filter((id) => !installedRuntimePacks.has(id));
      const installedDependencies = { skills: [], runtimePacks: [] };
      const failedDependencies = { skills: [], runtimePacks: [] };

      for (const skillId of skillsToInstall) {
        const install = await skillManager.installFromRegistry(skillId);
        if (install.ok) installedDependencies.skills.push(skillId);
        else failedDependencies.skills.push({ id: skillId, error: install.error || "INSTALL_FAILED" });
      }
      for (const skillId of requiredSkills) {
        const enabled = skillManager.setSkillEnabled(skillId, true);
        if (!enabled.ok) {
          failedDependencies.skills.push({ id: skillId, error: enabled.error || "ENABLE_FAILED" });
        }
      }

      for (const packId of missingRuntimePacks) {
        const install = await runtimePackInstaller.installRuntimePack(packId);
        if (install.ok) installedDependencies.runtimePacks.push(packId);
        else failedDependencies.runtimePacks.push({ id: packId, error: install.error || "INSTALL_FAILED" });
      }

      if (failedDependencies.skills.length || failedDependencies.runtimePacks.length) {
        if (!resolvedTarget.replaceExisting) {
          fs.rmSync(targetDir, { recursive: true, force: true });
        }
        return {
          ok: false,
          error: "APP_DEPENDENCY_INSTALL_FAILED",
          failedDependencies,
          installedDependencies,
        };
      }

      let backupDir = null;
      if (resolvedTarget.replaceExisting && fs.existsSync(targetDir)) {
        backupDir = `${targetDir}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        fs.renameSync(targetDir, backupDir);
      }

      let manifest;
      let conventions;
      let workspaceSkills;
      try {
        ({ manifest, conventions, workspaceSkills } = await importWorkspacePack(zipBuffer, targetDir));
      } catch (err) {
        fs.rmSync(targetDir, { recursive: true, force: true });
        if (backupDir && fs.existsSync(backupDir) && !fs.existsSync(targetDir)) {
          fs.renameSync(backupDir, targetDir);
        }
        throw err;
      }
      const project = projectManager.add(targetDir);
      if (manifest.name) projectManager.rename(project.id, manifest.name);
      if (conventions) writeLearnedConventions(project.id, conventions);
      const restoredWorkspaceSkills = restoreWorkspaceSkills(skillManager, workspaceSkills, project.id);
      sessionManager.create(project.id, defaultSessionTitle());
      const installedRecord = workspaceAppInstalls.recordInstalled({
        app,
        manifest,
        project,
        targetDir,
        installParentDir: baseDir,
        installedDependencies,
        replaceInstanceId: resolvedTarget.replaceExisting ? existingRecord?.instanceId : null,
      });
      if (backupDir && installedRecord) {
        installedRecord.backupPath = backupDir;
      }
      if (installedRecord?.supersededProjectId && installedRecord.supersededProjectId !== project.id) {
        const sessionIds = sessionManager.purgeProject(installedRecord.supersededProjectId);
        for (const sessionId of sessionIds) runnerPool.terminateSession(sessionId);
        projectManager.remove(installedRecord.supersededProjectId);
      }

      return {
        ok: true,
        state: projectManager.getAppState(),
        projectId: project.id,
        projectName: manifest.name || project.name,
        workspacePath: targetDir,
        missingSkills: [],
        missingRuntimePacks: [],
        installedDependencies,
        installedApp: installedRecord,
        restoredWorkspaceSkills,
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("apps:open-installed", async (_event, payload) => {
    const appId = String(payload?.id || payload?.appId || "").trim();
    const fs = require("node:fs");
    const workspaceAppInstalls = require("./workspace-app-installs");
    const state = workspaceAppInstalls.readState();
    const record = workspaceAppInstalls.getAppInstances(state, appId)
      .find((item) => projectManager.find(item.projectId) && fs.existsSync(item.path || ""))
      || workspaceAppInstalls.activeRecordForApp(state, appId);
    if (!record) return { ok: false, error: "NOT_FOUND" };
    const project = projectManager.find(record.projectId);
    if (!project) return { ok: false, error: "PROJECT_NOT_FOUND" };
    projectManager.switchTo(project.id);
    const sessions = sessionManager.listForProject(project.id);
    if (sessions.length > 0) sessionManager.switchTo(sessions[0].id);
    return { ok: true, state: projectManager.getAppState(), projectId: project.id, projectName: project.name, workspacePath: project.path, sessions };
  });

  ipcMain.handle("apps:uninstall", async (_event, payload) => {
    const fs = require("node:fs");
    const appId = String(payload?.id || payload?.appId || "").trim();
    const workspaceAppInstalls = require("./workspace-app-installs");
    const state = workspaceAppInstalls.readState();
    const records = workspaceAppInstalls.getAppInstances(state, appId);
    if (!records.length) return { ok: false, error: "NOT_FOUND" };
    if (records.some((record) => !workspaceAppInstalls.canRemoveInstalledWorkspace(projectManager.defaultPath, record))) {
      return { ok: false, error: "UNSAFE_APP_PATH" };
    }

    for (const record of records) {
      const project = projectManager.find(record.projectId);
      if (project) {
        const sessionIds = sessionManager.purgeProject(project.id);
        for (const sessionId of sessionIds) runnerPool.terminateSession(sessionId);
        projectManager.remove(project.id);
      }
      fs.rmSync(record.path, { recursive: true, force: true });
    }
    workspaceAppInstalls.forgetInstalled(appId);
    return { ok: true, state: projectManager.getAppState(), appId };
  });
}

module.exports = { registerProjectHandlers, isProjectBusy, isVersionId };
