#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";

const require = module.createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-workspace-automations-"));
const userData = path.join(tmp, "userData");
fs.mkdirSync(userData, { recursive: true });

const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      getPath: (name) => (name === "userData" ? userData : tmp),
    },
  },
};

try {
  const portability = require("../src/main/scheduled-task-portability.js");
  const { ScheduledTaskManager } = require("../src/main/scheduled-tasks.js");
  const share = require("../src/main/workspace-share.js");

  const liveTasks = [
    {
      id: "sched_daily",
      projectId: "project-old",
      workspaceId: "project-old",
      sessionId: "session-old",
      title: "Daily summary",
      prompt: "Summarize project changes",
      schedule: { type: "daily", hour: 18, minute: 0 },
      scheduleText: "Daily at 18:00",
      permissionMode: "read_only",
      enabled: true,
      status: "scheduled",
      lastRunAt: "2026-07-25T18:00:00.000Z",
      nextRunAt: "2026-07-26T18:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-25T18:00:00.000Z",
    },
    {
      id: "sched_weekly",
      projectId: "project-old",
      sessionId: "session-old",
      title: "Weekly report",
      prompt: "Create the weekly report",
      schedule: { type: "weekly", weekday: 1, hour: 9, minute: 30 },
      scheduleText: "Monday at 09:30",
      permissionMode: "read_only",
      enabled: false,
      status: "paused",
    },
  ];

  const templates = portability.exportTaskTemplates(liveTasks, ["sched_daily"]);
  assert.equal(templates.length, 1, "only explicitly selected tasks travel");
  assert.deepEqual(
    Object.keys(templates[0]).sort(),
    ["permissionMode", "prompt", "schedule", "scheduleText", "title"],
    "portable templates contain only reusable task definition fields",
  );
  assert.equal(JSON.stringify(templates).includes("project-old"), false, "project identity must not travel");
  assert.equal(JSON.stringify(templates).includes("session-old"), false, "session identity must not travel");
  assert.equal(JSON.stringify(templates).includes("nextRunAt"), false, "runtime timestamps must not travel");
  assert.equal(templates[0].permissionMode, "inherit",
    "legacy task permission metadata must normalize to the actual conversation-inherited behavior");

  const workspace = path.join(tmp, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "README.md"), "# Portable workspace\n");

  const pack = await share.exportWorkspacePack({
    rootPath: workspace,
    name: "Portable workspace",
    automationTemplates: templates,
    exportedAt: "2026-07-26T00:00:00.000Z",
  });
  const imported = await share.importWorkspacePack(pack, path.join(tmp, "imported"));
  assert.equal(imported.manifest.automationCount, 1, "manifest previews embedded automation count");
  assert.equal(imported.automationTemplates.length, 1, "automation templates survive pack round trip");
  assert.equal(imported.automationTemplates[0].schedule.type, "daily");
  assert.deepEqual(imported.skippedAutomations, [], "valid templates are not reported as skipped");

  const manager = new ScheduledTaskManager();
  manager.tasks = [];
  manager.runs = [{
    id: "run_existing",
    taskId: "another-task",
    status: "succeeded",
  }];
  const restored = manager.importPausedTemplates(imported.automationTemplates, {
    projectId: "project-new",
    sessionId: "session-new",
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.tasks.length, 1);
  assert.match(restored.tasks[0].id, /^sched_/);
  assert.notEqual(restored.tasks[0].id, "sched_daily", "import creates a new task identity");
  assert.equal(restored.tasks[0].projectId, "project-new");
  assert.equal(restored.tasks[0].workspaceId, "project-new");
  assert.equal(restored.tasks[0].sessionId, "session-new");
  assert.equal(restored.tasks[0].enabled, false, "imported tasks are always paused");
  assert.equal(restored.tasks[0].status, "paused");
  assert.equal(restored.tasks[0].nextRunAt, null, "paused import does not calculate a next run");
  assert.equal(manager.runs.length, 1, "task run history is never imported");

  const normalized = portability.normalizeTaskTemplates({
    schemaVersion: 1,
    tasks: [
      templates[0],
      { title: "Broken", prompt: "", schedule: { type: "daily", hour: 9 } },
    ],
  });
  assert.equal(normalized.templates.length, 1, "valid task remains importable");
  assert.equal(normalized.skipped.length, 1, "malformed task is skipped and reported");

  const futureAutomationZip = new (await import("jszip")).default();
  futureAutomationZip.file(portability.AUTOMATIONS_ENTRY, JSON.stringify({
    schemaVersion: portability.AUTOMATION_SCHEMA_VERSION + 1,
    tasks: [templates[0]],
  }));
  const futureEntry = futureAutomationZip.file(portability.AUTOMATIONS_ENTRY);
  const futureAutomations = await portability.readAutomationEntry(futureEntry);
  assert.deepEqual(futureAutomations.automationTemplates, []);
  assert.deepEqual(futureAutomations.skippedAutomations, [
    { index: -1, reason: "AUTOMATIONS_TOO_NEW" },
  ]);

  const ipcProjects = fs.readFileSync(path.join(process.cwd(), "src/main/ipc-projects.js"), "utf8");
  const ipcExport = fs.readFileSync(path.join(process.cwd(), "src/main/ipc-workspace-export.js"), "utf8");
  const projectTree = fs.readFileSync(path.join(process.cwd(), "src/renderer/modules/project-tree.js"), "utf8");
  const exportDialog = fs.readFileSync(path.join(process.cwd(), "src/renderer/modules/workspace-export-dialog.js"), "utf8");
  assert.match(
    `${ipcProjects}\n${ipcExport}`,
    /previewProjectTasks\(ctx\.scheduledTaskManager,\s*project\.id\)/,
    "export preview lists only tasks from the selected workspace",
  );
  assert.match(
    `${ipcProjects}\n${ipcExport}`,
    /selectedScheduledTaskIds/,
    "export IPC accepts explicit scheduled-task selections",
  );
  assert.match(
    `${projectTree}\n${exportDialog}`,
    /scheduledTasks/,
    "export confirmation renders scheduled-task choices",
  );
  assert.match(
    `${projectTree}\n${exportDialog}`,
    /selectedScheduledTaskIds/,
    "renderer sends only checked scheduled tasks",
  );

  console.log("workspace-automation-sharing: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
