"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");
const { compareSemver } = require("./skill-version");

const STATE_SCHEMA_VERSION = 1;

function statePath() {
  return userDataPath("workspace-apps.json");
}

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    if (raw && typeof raw === "object" && raw.apps && typeof raw.apps === "object") {
      return {
        schemaVersion: STATE_SCHEMA_VERSION,
        apps: raw.apps,
        history: Array.isArray(raw.history) ? raw.history : [],
      };
    }
  } catch {
    // no state yet
  }
  return { schemaVersion: STATE_SCHEMA_VERSION, apps: {}, history: [] };
}

function writeState(state) {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), `${JSON.stringify({
    schemaVersion: STATE_SCHEMA_VERSION,
    apps: state.apps || {},
    history: Array.isArray(state.history) ? state.history.slice(-100) : [],
  }, null, 2)}\n`, "utf8");
}

function installRoot(defaultWorkspacePath) {
  return path.join(path.dirname(defaultWorkspacePath), "Lily Apps");
}

function isInsideInstallRoot(defaultWorkspacePath, targetPath) {
  const root = path.resolve(installRoot(defaultWorkspacePath));
  const target = path.resolve(targetPath || "");
  return target === root || target.startsWith(root + path.sep);
}

function recordInstalled({ app, manifest, project, targetDir, installedDependencies }) {
  const appId = String(app?.id || manifest?.appId || "").trim();
  if (!appId) return null;
  const state = readState();
  const previous = state.apps[appId] || null;
  if (previous) {
    state.history.push({
      ...previous,
      supersededAt: new Date().toISOString(),
    });
  }
  const record = {
    id: appId,
    name: manifest?.name || app?.name || appId,
    version: manifest?.version || app?.latestVersion || "",
    catalogVersion: app?.latestVersion || "",
    projectId: project.id,
    projectName: project.name,
    path: targetDir,
    sha256: String(app?.sha256 || "").toLowerCase(),
    downloadUrl: app?.downloadUrl || "",
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    installedDependencies: installedDependencies || { skills: [], runtimePacks: [] },
  };
  state.apps[appId] = record;
  writeState(state);
  return record;
}

function forgetInstalled(appId) {
  const state = readState();
  const record = state.apps[appId];
  if (!record) return null;
  delete state.apps[appId];
  state.history.push({ ...record, removedAt: new Date().toISOString() });
  writeState(state);
  return record;
}

function attachInstalledState(result, projectManager) {
  const apps = result?.json?.apps;
  if (!Array.isArray(apps)) return result;
  const state = readState();
  const enriched = apps.map((app) => {
    const installed = state.apps[app.id] || null;
    if (!installed) return { ...app, installed: false, updateAvailable: false };
    const project = projectManager?.find?.(installed.projectId);
    const installedVersion = installed.version || installed.catalogVersion || "";
    const latestVersion = app.latestVersion || "";
    return {
      ...app,
      installed: true,
      installedVersion,
      installedAt: installed.installedAt,
      installedProjectId: installed.projectId,
      installedPath: installed.path,
      installedAvailable: Boolean(project && fs.existsSync(installed.path || "")),
      updateAvailable: latestVersion && installedVersion
        ? compareSemver(latestVersion, installedVersion) > 0
        : false,
    };
  });
  return {
    ...result,
    json: {
      ...result.json,
      apps: enriched,
    },
  };
}

function listInstalled() {
  return Object.values(readState().apps || {});
}

module.exports = {
  statePath,
  readState,
  writeState,
  installRoot,
  isInsideInstallRoot,
  recordInstalled,
  forgetInstalled,
  attachInstalledState,
  listInstalled,
};
