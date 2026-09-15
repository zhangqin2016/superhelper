"use strict";

const fs = require("node:fs");
const { ipcMain, dialog, shell } = require("electron");
const { readLearnedConventions } = require("./learned-context");
const taskPortability = require("./scheduled-task-portability");
const { exportWorkspacePack, previewExport, previewWorkspaceSkills } = require("./workspace-share");
const { resolveCharacterOwnerScope } = require("./character-worlds/owner-scope");
const {
  collectCharacterWorldsForExport,
  packCharacterWorldsSection,
} = require("./character-worlds/workspace-portability");

/** Collect the Character Worlds section for a project's sessions, or null when
 *  the feature is unavailable (no repo, no resolvable owner scope). */
function characterWorldsPackFor(ctx, projectId) {
  const repo = ctx.characterWorldsRepository;
  const ownerScope = resolveCharacterOwnerScope();
  if (!repo || typeof ownerScope !== "string" || !ownerScope) return null;
  const sessions = (ctx.sessionManager?.listForProject?.(projectId) || [])
    .map((s) => ({ sessionId: s.id, ownerScope }));
  const collected = collectCharacterWorldsForExport(repo, sessions);
  return { repo, ownerScope, collected };
}

/** Collect the 智能体 section (agents bound to the project's sessions), or
 *  null when unavailable. Local role cards ride along only when the caller
 *  also opted into Character Worlds export (they are user content). */
function agentsPackFor(ctx, projectId, { includeRoleCards = false } = {}) {
  try {
    const repo = ctx.agentRepository || ctx.sessionManager?._store?.()?.agents?.();
    const ownerScope = resolveCharacterOwnerScope();
    if (!repo || typeof ownerScope !== "string" || !ownerScope) return null;
    const sessions = (ctx.sessionManager?.listForProject?.(projectId) || [])
      .map((s) => ({ sessionId: s.id, ownerScope }));
    const { collectAgentsForExport, packAgentsSection } = require("./agents/workspace-portability");
    const collected = collectAgentsForExport(repo, ctx.characterWorldsRepository || null, sessions, { includeRoleCards });
    return { collected, ...packAgentsSection(collected) };
  } catch (error) {
    console.warn("[agents] pack export skipped:", error?.message || error);
    return null;
  }
}

function registerWorkspaceExportHandlers(ctx) {
  const { mainWindow, projectManager } = ctx;
  const skillManager = require("./skill-manager");

  ipcMain.handle("project:export-preview", (_event, projectId, options = {}) => {
    const project = projectManager.find(projectId);
    if (!project) return { ok: false, error: "NOT_FOUND" };
    const workspaceSkills = skillManager.listWorkspaceSkillExports(project.id);
    const payload = {
      ok: true,
      name: project.name,
      preview: previewExport(project.path),
      requiredSkills: skillManager.getEnabledRegistrySkillIds(),
      workspaceSkills: previewWorkspaceSkills(workspaceSkills),
      scheduledTasks: taskPortability.previewProjectTasks(ctx.scheduledTaskManager, project.id),
    };
    const agentsPack = agentsPackFor(ctx, project.id);
    payload.agents = agentsPack
      ? { count: agentsPack.count, names: agentsPack.collected.agents.map((a) => a.displayName) }
      : { count: 0, names: [] };
    if (options.includeCharacterWorlds === true) {
      const cw = characterWorldsPackFor(ctx, project.id);
      payload.characterWorlds = cw
        ? {
            enabled: true,
            entityCount: cw.collected.entities.length,
            bindingCount: cw.collected.bindings.length,
            entities: cw.collected.entities.map((e) => ({
              kind: e.kind,
              displayName: e.displayName,
            })),
          }
        : { enabled: false };
    }
    return payload;
  });

  ipcMain.handle("project:export-pack", async (_event, projectId, options = {}) => {
    const project = projectManager.find(projectId);
    if (!project) return { ok: false, error: "NOT_FOUND" };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "导出工作空间能力包",
      defaultPath: `${project.name}.lilyspace.zip`,
      filters: [{ name: "Lily Workspace Pack", extensions: ["zip"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      const cw = options.includeCharacterWorlds === true
        ? characterWorldsPackFor(ctx, project.id)
        : null;
      const buf = await exportWorkspacePack({
        rootPath: project.path,
        name: project.name,
        conventions: readLearnedConventions(project.id),
        requiredSkills: skillManager.getEnabledRegistrySkillIds(),
        workspaceSkills: options.includeWorkspaceSkills === true
          ? skillManager.listWorkspaceSkillExports(project.id)
          : [],
        automationTemplates: taskPortability.exportTaskTemplates(
          taskPortability.previewProjectTasks(ctx.scheduledTaskManager, project.id),
          options.selectedScheduledTaskIds,
        ),
        characterWorlds: cw ? packCharacterWorldsSection(cw.collected).json : "",
        agents: options.includeAgents === false ? "" : (agentsPackFor(ctx, project.id, { includeRoleCards: options.includeCharacterWorlds === true })?.json || ""),
        exportedAt: new Date().toISOString(),
      });
      fs.writeFileSync(result.filePath, buf);
      shell.showItemInFolder(result.filePath);
      return { ok: true, filePath: result.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = { registerWorkspaceExportHandlers };
