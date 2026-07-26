"use strict";

const fs = require("node:fs");
const { ipcMain, dialog, shell } = require("electron");
const { readLearnedConventions } = require("./learned-context");
const taskPortability = require("./scheduled-task-portability");
const { exportWorkspacePack, previewExport, previewWorkspaceSkills } = require("./workspace-share");

function registerWorkspaceExportHandlers(ctx) {
  const { mainWindow, projectManager } = ctx;
  const skillManager = require("./skill-manager");

  ipcMain.handle("project:export-preview", (_event, projectId) => {
    const project = projectManager.find(projectId);
    if (!project) return { ok: false, error: "NOT_FOUND" };
    const workspaceSkills = skillManager.listWorkspaceSkillExports(project.id);
    return {
      ok: true,
      name: project.name,
      preview: previewExport(project.path),
      requiredSkills: skillManager.getEnabledRegistrySkillIds(),
      workspaceSkills: previewWorkspaceSkills(workspaceSkills),
      scheduledTasks: taskPortability.previewProjectTasks(ctx.scheduledTaskManager, project.id),
    };
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
