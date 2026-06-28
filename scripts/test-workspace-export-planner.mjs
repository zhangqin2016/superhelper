#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const planner = require("../src/main/workspace-export-planner.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-export-planner-"));

try {
  const ws = path.join(tmp, "customer-app");
  fs.mkdirSync(path.join(ws, "source"), { recursive: true });
  fs.mkdirSync(path.join(ws, "output"), { recursive: true });
  fs.mkdirSync(path.join(ws, "cases"), { recursive: true });
  fs.mkdirSync(path.join(ws, "assets"), { recursive: true });
  fs.mkdirSync(path.join(ws, ".lily-work/app-data"), { recursive: true });
  fs.mkdirSync(path.join(ws, ".lily-work/cache"), { recursive: true });
  fs.mkdirSync(path.join(ws, "node_modules/pkg"), { recursive: true });
  fs.writeFileSync(path.join(ws, "README.md"), "# Customer App\n");
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "# Rules\n");
  fs.writeFileSync(path.join(ws, "lily-app.json"), JSON.stringify({
    type: "workspace_app",
    appId: "customer-app",
    name: "Customer App",
    version: "1.0.0",
    export: {
      dataPaths: ["cases/", ".lily-work/app-data/"],
      exclude: ["assets/private-drafts/"],
    },
  }, null, 2));
  fs.writeFileSync(path.join(ws, "source", "run.cjs"), "console.log('run')");
  fs.writeFileSync(path.join(ws, "output", "final-report.pdf"), "report");
  fs.writeFileSync(path.join(ws, "cases", "case-1.json"), "{}");
  fs.writeFileSync(path.join(ws, ".lily-work", "app-data", "memory.json"), "{}");
  fs.writeFileSync(path.join(ws, ".lily-work", "cache", "tmp.json"), "{}");
  fs.writeFileSync(path.join(ws, "node_modules/pkg/index.js"), "dep");
  fs.writeFileSync(path.join(ws, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(ws, ".DS_Store"), "finder noise");

  const plan = planner.planWorkspaceExport(ws);
  const included = new Map(plan.files.map((file) => [file.relPath, file]));
  const skippedFiles = new Map(plan.skippedFiles.map((file) => [file.relPath, file]));
  const skippedDirs = new Map(plan.skippedDirs.map((dir) => [dir.relPath, dir]));

  for (const rel of [
    "README.md",
    "AGENTS.md",
    "lily-app.json",
    "source/run.cjs",
    "output/final-report.pdf",
    "cases/case-1.json",
    ".lily-work/app-data/memory.json",
  ]) {
    if (!included.has(rel)) throw new Error(`planner must include ${rel}`);
  }

  if (included.has(".env")) throw new Error("planner must not include real .env secrets");
  if (included.has(".DS_Store")) throw new Error("planner must not include Finder noise");
  if (!skippedFiles.has(".env") || skippedFiles.get(".env").reason !== "secret-file") {
    throw new Error(`planner must explain skipped secret files: ${JSON.stringify(plan.skippedFiles)}`);
  }
  if (skippedFiles.has(".DS_Store")) {
    throw new Error(`benign system files must not create skipped-file warnings: ${JSON.stringify(plan.skippedFiles)}`);
  }
  if (!skippedDirs.has(".lily-work/cache/") || skippedDirs.get(".lily-work/cache/").reason !== "cache-dir") {
    throw new Error(`planner must skip cache dirs with a clear reason: ${JSON.stringify(plan.skippedDirs)}`);
  }
  if (!skippedDirs.has("node_modules/") || skippedDirs.get("node_modules/").reason !== "dependency-dir") {
    throw new Error(`planner must skip dependency dirs with a clear reason: ${JSON.stringify(plan.skippedDirs)}`);
  }
  if (included.get("output/final-report.pdf")?.category !== "user-output") {
    throw new Error(`output/ deliverables must be classified as user-output: ${JSON.stringify(included.get("output/final-report.pdf"))}`);
  }
  if (included.get(".lily-work/app-data/memory.json")?.category !== "app-data") {
    throw new Error(`declared hidden app data must be classified as app-data: ${JSON.stringify(included.get(".lily-work/app-data/memory.json"))}`);
  }
  if (!plan.categorySummary.some((item) => item.category === "user-output" && item.fileCount === 1)) {
    throw new Error(`planner must summarize categories: ${JSON.stringify(plan.categorySummary)}`);
  }
  if (plan.workspaceApp?.appId !== "customer-app") {
    throw new Error(`planner must expose workspace app metadata: ${JSON.stringify(plan.workspaceApp)}`);
  }

  console.log("workspace-export-planner: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
