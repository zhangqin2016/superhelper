#!/usr/bin/env node
/**
 * Simulates assistant:input end-to-end (same code path as the app).
 */
import { app } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

app.setPath(
  "userData",
  path.join(app.getPath("home"), "Library", "Application Support", "terminal-chat-claude"),
);

app.whenReady().then(async () => {
  const { bootstrapAgent } = require(path.join(root, "src/main/agent-bootstrap.js"));
  const ProjectManager = require(path.join(root, "src/main/project-manager.js"));
  const SessionManager = require(path.join(root, "src/main/session-manager.js"));
  const FileStagingManager = require(path.join(root, "src/main/file-staging-manager.js"));
  const { SessionRunnerPool } = require(path.join(root, "src/main/session-runner-pool.js"));
  const { resolveAgentCommand } = require(path.join(root, "src/main/agent-command.js"));
  const { fileStagingDir } = require(path.join(root, "src/main/config.js"));

  const agentBootstrap = bootstrapAgent();
  const projectManager = new ProjectManager(root);
  projectManager.load();
  const sessionManager = new SessionManager(projectManager);
  sessionManager.load();
  const runnerPool = new SessionRunnerPool();

  const session = sessionManager.getActive();
  const cliPath = resolveAgentCommand();

  const report = {
    bootstrap: { ok: agentBootstrap.ok, mode: agentBootstrap.mode, error: agentBootstrap.error },
    cliPath,
    activeSessionId: session?.id,
    projectPath: session
      ? projectManager.find(session.projectId)?.path || projectManager.getActive()?.path
      : null,
  };

  if (session && cliPath) {
    const project =
      projectManager.find(session.projectId) || projectManager.getActive();
    try {
      const runner = runnerPool.ensure(session.id, project.path, {
        disallowedTools: agentBootstrap.agentDefaults?.disallowedTools || [],
        stagingDir: fileStagingDir(),
      });
      report.runnerAlive = runner.isAlive();
      report.sendOk = runner.sendUserMessage("ping");
    } catch (err) {
      report.runnerError = err.message;
      report.runnerStack = err.stack;
    }
  }

  console.log(JSON.stringify(report, null, 2));
  runnerPool.terminateAll();
  app.quit();
});
