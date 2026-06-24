#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-workspace-app-runtime-"));
process.env.LILY_USER_DATA_DIR = path.join(tmp, "user-data");

const { readWorkspaceAppRuntime } = require("../src/main/workspace-app-runtime.js");
const ProjectManager = require("../src/main/project-manager.js");

try {
  const appDir = path.join(tmp, "Daily Stock Analysis");
  const reportsDir = path.join(appDir, "source", "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "lily-workspace.json"), JSON.stringify({
    kind: "lily-workspace-app",
    schemaVersion: 1,
    appId: "daily-stock-analysis",
    name: "股票智能分析 Starter",
    version: "1.0.0",
    appRuntime: {
      manifestPath: "lily-app.json",
      defaultEntrypoint: "analyze_stock",
      resultPath: "source/reports/lily-result.json",
    },
  }, null, 2));
  fs.writeFileSync(path.join(appDir, "lily-app.json"), JSON.stringify({
    schemaVersion: 1,
    appId: "daily-stock-analysis",
    type: "workspace_app",
    name: "股票智能分析 Starter",
    version: "1.0.0",
    capabilities: ["stock.market_data.read", "report.markdown.generate"],
    skills: ["lily-stock-research"],
    runtimePacks: [],
    entrypoints: {
      analyze_stock: {
        command: "python",
        args: ["source/lily_app_runner.py", "--stocks", "{{stocks}}"],
        cwd: ".",
        timeoutSeconds: 420,
        stageEventType: "lily.app.stage",
        resultPath: "source/reports/lily-result.json",
      },
    },
    dataPolicy: {
      model: "platform-managed",
      search: "platform-managed",
      marketData: "platform-adapter-first",
      userSuppliedKeysRequired: false,
    },
    resultProtocol: {
      resultPath: "source/reports/lily-result.json",
      blocks: ["stock_report"],
      files: ["markdown"],
    },
  }, null, 2));
  fs.writeFileSync(path.join(reportsDir, "600171-2026-06-24.md"), "# 上海贝岭分析\n");
  fs.writeFileSync(path.join(reportsDir, "lily-result.json"), JSON.stringify({
    ok: true,
    status: "completed",
    reports: [{
      name: "600171-2026-06-24.md",
      path: path.join(reportsDir, "600171-2026-06-24.md"),
      sizeBytes: 4096,
    }],
  }, null, 2));

  const runtime = readWorkspaceAppRuntime(appDir);
  assert.equal(runtime.appId, "daily-stock-analysis");
  assert.equal(runtime.defaultEntrypoint, "analyze_stock");
  assert.equal(runtime.resultPath, "source/reports/lily-result.json");
  assert.equal(runtime.dataPolicy.userSuppliedKeysRequired, false);
  assert.equal(runtime.entrypoints.analyze_stock.stageEventType, "lily.app.stage");
  assert.equal(runtime.lastResult.ok, true);
  assert.equal(runtime.lastResult.reports[0].name, "600171-2026-06-24.md");

  const manager = new ProjectManager(path.join(tmp, "Default Workspace"));
  manager.load();
  const project = manager.add(appDir);
  const summary = manager.getAppState().projects.find((item) => item.id === project.id);
  assert.equal(summary.workspaceApp.appId, "daily-stock-analysis");
  assert.equal(summary.workspaceApp.lastResult.status, "completed");

  const normalDir = path.join(tmp, "Normal Workspace");
  fs.mkdirSync(normalDir, { recursive: true });
  assert.equal(readWorkspaceAppRuntime(normalDir), null);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("workspace-app-runtime: ok");
