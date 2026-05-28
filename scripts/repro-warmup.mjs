#!/usr/bin/env node
import { app } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

app.setPath(
  "userData",
  path.join(app.getPath("home"), "Library/Application Support/terminal-chat-claude"),
);

app.whenReady().then(async () => {
  const { bootstrapAgent } = require(path.join(root, "src/main/agent-bootstrap.js"));
  const ProjectManager = require(path.join(root, "src/main/project-manager.js"));
  const SessionManager = require(path.join(root, "src/main/session-manager.js"));
  const FileStagingManager = require(path.join(root, "src/main/file-staging-manager.js"));
  const { SessionRunnerPool } = require(path.join(root, "src/main/session-runner-pool.js"));
  const { registerAll, ensureSessionRunner } = require(path.join(root, "src/main/ipc-handlers.js"));

  const agentBootstrap = bootstrapAgent();
  const projectManager = new ProjectManager(root);
  projectManager.load();
  const sessionManager = new SessionManager(projectManager);
  sessionManager.load();
  const stagingManager = new FileStagingManager();
  const runnerPool = new SessionRunnerPool();

  const ctx = {
    mainWindow: null,
    agentBootstrap,
    projectManager,
    sessionManager,
    stagingManager,
    runnerPool,
  };

  const session = sessionManager.getActive();
  try {
    const result = ensureSessionRunner(ctx, session.id);
    console.log("ensureSessionRunner:", JSON.stringify(result, null, 2));
  } catch (e) {
    console.log("THREW:", e.message, e.stack);
  }

  runnerPool.terminateAll();
  app.quit();
});
