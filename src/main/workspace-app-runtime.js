"use strict";

const fs = require("node:fs");
const path = require("node:path");

const WORKSPACE_MANIFEST = "lily-workspace.json";

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function safeRelativePath(baseDir, relPath) {
  const value = String(relPath || "").trim();
  if (!value || path.isAbsolute(value)) return null;
  const resolved = path.resolve(baseDir, value);
  const base = path.resolve(baseDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return value;
}

function normalizeResultFilePath(baseDir, filePath) {
  const value = String(filePath || "").trim();
  if (!value) return "";
  if (!path.isAbsolute(value)) {
    return safeRelativePath(baseDir, value) || value;
  }
  const base = path.resolve(baseDir);
  const resolved = path.resolve(value);
  if (resolved === base || resolved.startsWith(base + path.sep)) {
    return path.relative(base, resolved);
  }
  return value;
}

function readWorkspaceAppRuntime(projectPath) {
  const root = String(projectPath || "").trim();
  if (!root) return null;
  const workspaceManifest = safeReadJson(path.join(root, WORKSPACE_MANIFEST));
  if (workspaceManifest?.kind !== "lily-workspace-app") return null;

  const appRuntime = workspaceManifest.appRuntime && typeof workspaceManifest.appRuntime === "object"
    ? workspaceManifest.appRuntime
    : {};
  const manifestPath = safeRelativePath(root, appRuntime.manifestPath || "lily-app.json");
  const appManifest = manifestPath ? safeReadJson(path.join(root, manifestPath)) : null;
  if (appManifest?.type !== "workspace_app") return null;

  const defaultEntrypoint = String(appRuntime.defaultEntrypoint || "").trim()
    || Object.keys(appManifest.entrypoints || {})[0]
    || "";
  const declaredResultPath = appRuntime.resultPath
    || appManifest.entrypoints?.[defaultEntrypoint]?.resultPath
    || appManifest.resultProtocol?.resultPath
    || "";
  const resultPath = safeRelativePath(root, declaredResultPath);

  let lastResult = null;
  if (resultPath) {
    const absoluteResultPath = path.join(root, resultPath);
    const result = safeReadJson(absoluteResultPath);
    if (result && typeof result === "object") {
      lastResult = {
        ok: result.ok === true,
        status: String(result.status || ""),
        updatedAt: fs.statSync(absoluteResultPath).mtime.toISOString(),
        resultPath,
        reports: Array.isArray(result.reports)
          ? result.reports.map((item) => ({
            name: String(item?.name || path.basename(String(item?.path || ""))),
            path: normalizeResultFilePath(root, item?.path),
            sizeBytes: Number(item?.sizeBytes || 0),
          })).slice(0, 20)
          : [],
        diagnosticReport: result.diagnosticReport
          ? String(result.diagnosticReport)
          : "",
        error: result.error ? String(result.error) : "",
      };
    }
  }

  return {
    appId: String(appManifest.appId || workspaceManifest.appId || "").trim(),
    name: String(appManifest.name || workspaceManifest.name || "").trim(),
    version: String(appManifest.version || workspaceManifest.version || "").trim(),
    manifestPath,
    defaultEntrypoint,
    resultPath,
    capabilities: Array.isArray(appManifest.capabilities) ? appManifest.capabilities.slice(0, 100) : [],
    skills: Array.isArray(appManifest.skills) ? appManifest.skills.slice(0, 100) : [],
    runtimePacks: Array.isArray(appManifest.runtimePacks) ? appManifest.runtimePacks.slice(0, 100) : [],
    dataPolicy: appManifest.dataPolicy && typeof appManifest.dataPolicy === "object"
      ? {
        model: String(appManifest.dataPolicy.model || ""),
        search: String(appManifest.dataPolicy.search || ""),
        marketData: String(appManifest.dataPolicy.marketData || ""),
        userSuppliedKeysRequired: appManifest.dataPolicy.userSuppliedKeysRequired === true,
      }
      : null,
    entrypoints: appManifest.entrypoints && typeof appManifest.entrypoints === "object"
      ? Object.fromEntries(Object.entries(appManifest.entrypoints).map(([key, value]) => [key, {
        command: String(value?.command || ""),
        args: Array.isArray(value?.args) ? value.args.map((arg) => String(arg)) : [],
        cwd: String(value?.cwd || "."),
        timeoutSeconds: Number(value?.timeoutSeconds || 0),
        stageEventType: String(value?.stageEventType || ""),
        resultPath: String(value?.resultPath || ""),
      }]))
      : {},
    resultProtocol: appManifest.resultProtocol && typeof appManifest.resultProtocol === "object"
      ? {
        resultPath: String(appManifest.resultProtocol.resultPath || ""),
        blocks: Array.isArray(appManifest.resultProtocol.blocks) ? appManifest.resultProtocol.blocks.map(String) : [],
        files: Array.isArray(appManifest.resultProtocol.files) ? appManifest.resultProtocol.files.map(String) : [],
      }
      : null,
    lastResult,
  };
}

module.exports = {
  readWorkspaceAppRuntime,
};
