#!/usr/bin/env node
import { app } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

app.setPath(
  "userData",
  "/Users/zhangqin/Library/Application Support/terminal-chat-claude",
);

app.whenReady().then(async () => {
  const ProjectManager = require(path.join(root, "src/main/project-manager.js"));
  const SessionManager = require(path.join(root, "src/main/session-manager.js"));
  const { resolveAgentCommand } = require(path.join(root, "src/main/agent-command.js"));
  const { SessionRunnerPool } = require(path.join(root, "src/main/session-runner-pool.js"));

  const pm = new ProjectManager(root);
  pm.load();
  const sm = new SessionManager(pm);
  sm.load();

  const active = sm.getActive();
  const project = active
    ? pm.find(active.projectId) || pm.getActive()
    : null;
  const cmd = resolveAgentCommand();

  const report = {
    activeSessionId: sm.activeSessionId,
    session: active ? { id: active.id, title: active.title, status: active.status } : null,
    projectPath: project?.path,
    cmd,
    orphanKeys: Object.keys(sm.sessions).filter(
      (id) => !pm.projects.some((p) => p.id === id),
    ),
  };

  if (active && project && cmd) {
    const pool = new SessionRunnerPool();
    try {
      const runner = pool.ensure(active.id, project.path, { disallowedTools: [] });
      report.runnerAlive = runner.isAlive();
      pool.terminateAll();
    } catch (err) {
      report.runnerError = err.message;
    }
  }

  console.log(JSON.stringify(report, null, 2));
  app.quit();
});
