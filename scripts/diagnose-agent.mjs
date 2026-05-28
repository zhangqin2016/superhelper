#!/usr/bin/env node
/**
 * Run inside Electron to print agent resolution diagnostics.
 * Usage: npx electron scripts/diagnose-agent.mjs
 */
import { app } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

app.whenReady().then(() => {
  const { PROJECT_ROOT } = require(path.join(root, "src/main/config.js"));
  const bootstrap = require(path.join(root, "src/main/agent-bootstrap.js"));
  const { resolveAgentCommand } = require(path.join(root, "src/main/agent-command.js"));

  const report = {
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    PROJECT_ROOT,
    userData: app.getPath("userData"),
    bundleKeys: bootstrap.platformBundleKeys(),
    candidates: bootstrap.findBundledCliSource
      ? []
      : [],
    bundledSource: bootstrap.findBundledCliSource(),
    installedPath: bootstrap.installedCliPath(),
    ensureBundled: bootstrap.ensureBundledCliInstalled(),
    resolve: resolveAgentCommand(),
    bootstrap: bootstrap.bootstrapAgent(),
    DEV_USE_SYSTEM_CLAUDE: process.env.DEV_USE_SYSTEM_CLAUDE || "",
  };

  report.candidates = [];
  const fs = require("node:fs");
  for (const key of report.bundleKeys) {
    for (const base of [process.resourcesPath, PROJECT_ROOT].filter(Boolean)) {
      const p = path.join(base, "bundles", key, "claude");
      report.candidates.push({ path: p, exists: fs.existsSync(p) });
    }
  }

  console.log(JSON.stringify(report, null, 2));
  app.quit();
});
