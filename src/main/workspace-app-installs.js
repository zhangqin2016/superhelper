"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
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
      const instances = raw.instances && typeof raw.instances === "object"
        ? raw.instances
        : Object.fromEntries(
          Object.values(raw.apps)
            .filter((record) => record && typeof record === "object")
            .map((record) => [record.instanceId || `${record.id}:${record.projectId || record.path || "default"}`, {
              ...record,
              instanceId: record.instanceId || `${record.id}:${record.projectId || record.path || "default"}`,
            }]),
        );
      return {
        schemaVersion: STATE_SCHEMA_VERSION,
        apps: raw.apps,
        instances,
        history: Array.isArray(raw.history) ? raw.history : [],
      };
    }
  } catch {
    // no state yet
  }
  return { schemaVersion: STATE_SCHEMA_VERSION, apps: {}, instances: {}, history: [] };
}

function writeState(state) {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), `${JSON.stringify({
    schemaVersion: STATE_SCHEMA_VERSION,
    apps: state.apps || {},
    instances: state.instances || {},
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

function isDirectChild(parentDir, targetPath) {
  if (!parentDir || !targetPath) return false;
  const parent = path.resolve(parentDir);
  const target = path.resolve(targetPath);
  if (target === parent) return false;
  return path.dirname(target) === parent;
}

function isSamePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(a) === path.resolve(b);
}

function canRemoveInstalledWorkspace(defaultWorkspacePath, record) {
  if (!record?.path) return false;
  if (isInsideInstallRoot(defaultWorkspacePath, record.path)) return true;
  if (!record.managedByAppStore) return false;
  return isDirectChild(record.installParentDir, record.path);
}

function preferredInstallDialogPath(defaultWorkspacePath, record) {
  if (record?.path && fs.existsSync(record.path) && canRemoveInstalledWorkspace(defaultWorkspacePath, record)) {
    return record.path;
  }
  return installRoot(defaultWorkspacePath);
}

function resolveInstallTarget({ selectedDir, defaultWorkspacePath, record, baseName }) {
  const chosen = path.resolve(selectedDir || installRoot(defaultWorkspacePath));
  if (record?.path && canRemoveInstalledWorkspace(defaultWorkspacePath, record) && isSamePath(chosen, record.path)) {
    return {
      baseDir: path.dirname(record.path),
      targetDir: record.path,
      replaceExisting: true,
    };
  }
  return {
    baseDir: chosen,
    targetDir: path.join(chosen, baseName || "workspace-app"),
    replaceExisting: false,
  };
}

function getAppInstances(state, appId) {
  return Object.values(state.instances || {})
    .filter((record) => record?.id === appId)
    .sort((a, b) => String(b.updatedAt || b.installedAt || "").localeCompare(String(a.updatedAt || a.installedAt || "")));
}

function activeRecordForApp(state, appId) {
  return state.apps?.[appId] || getAppInstances(state, appId)[0] || null;
}

function recordInstalled({ app, manifest, project, targetDir, installParentDir, installedDependencies, replaceInstanceId }) {
  const appId = String(app?.id || manifest?.appId || "").trim();
  if (!appId) return null;
  const state = readState();
  const previous = replaceInstanceId
    ? state.instances?.[replaceInstanceId] || state.apps[appId] || null
    : null;
  if (previous) {
    state.history.push({
      ...previous,
      supersededAt: new Date().toISOString(),
    });
  }
  const now = new Date().toISOString();
  const instanceId = previous?.instanceId || crypto.randomUUID();
  const record = {
    id: appId,
    instanceId,
    name: manifest?.name || app?.name || appId,
    version: manifest?.version || app?.latestVersion || "",
    catalogVersion: app?.latestVersion || "",
    projectId: project.id,
    projectName: project.name,
    path: targetDir,
    installParentDir: installParentDir || path.dirname(targetDir),
    managedByAppStore: true,
    sha256: String(app?.sha256 || "").toLowerCase(),
    downloadUrl: app?.downloadUrl || "",
    installedAt: previous?.installedAt || now,
    updatedAt: now,
    installedDependencies: installedDependencies || { skills: [], runtimePacks: [] },
  };
  if (!state.instances || typeof state.instances !== "object") state.instances = {};
  state.instances[instanceId] = record;
  state.apps[appId] = record;
  writeState(state);
  return {
    ...record,
    supersededProjectId: previous?.projectId || null,
    supersededPath: previous?.path || null,
  };
}

function forgetInstalled(appId) {
  const state = readState();
  const record = activeRecordForApp(state, appId);
  const records = getAppInstances(state, appId);
  if (!record && records.length === 0) return null;
  delete state.apps[appId];
  for (const item of records) {
    delete state.instances[item.instanceId];
    state.history.push({ ...item, removedAt: new Date().toISOString() });
  }
  writeState(state);
  return record;
}

function attachInstalledState(result, projectManager) {
  const apps = result?.json?.apps;
  if (!Array.isArray(apps)) return result;
  const state = readState();
  const enriched = apps.map((app) => {
    const instances = getAppInstances(state, app.id);
    const installed = activeRecordForApp(state, app.id);
    if (!installed) return { ...app, installed: false, installedCount: 0, installedInstances: [], updateAvailable: false };
    const enrichedInstances = instances.map((instance) => {
      const project = projectManager?.find?.(instance.projectId);
      return {
        instanceId: instance.instanceId,
        projectId: instance.projectId,
        projectName: instance.projectName,
        path: instance.path,
        version: instance.version || instance.catalogVersion || "",
        available: Boolean(project && fs.existsSync(instance.path || "")),
        installedAt: instance.installedAt,
        updatedAt: instance.updatedAt,
      };
    });
    const availableInstance = enrichedInstances.find((instance) => instance.available) || null;
    const installedVersion = installed.version || installed.catalogVersion || "";
    const latestVersion = app.latestVersion || "";
    return {
      ...app,
      installed: true,
      installedVersion,
      installedAt: installed.installedAt,
      installedProjectId: installed.projectId,
      installedPath: installed.path,
      installedCount: instances.length,
      installedInstances: enrichedInstances,
      installedAvailable: Boolean(availableInstance),
      installedAvailableProjectId: availableInstance?.projectId || null,
      installedAvailablePath: availableInstance?.path || null,
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
  return Object.values(readState().instances || {});
}

module.exports = {
  statePath,
  readState,
  writeState,
  installRoot,
  isInsideInstallRoot,
  isSamePath,
  canRemoveInstalledWorkspace,
  preferredInstallDialogPath,
  resolveInstallTarget,
  getAppInstances,
  activeRecordForApp,
  recordInstalled,
  forgetInstalled,
  attachInstalledState,
  listInstalled,
};
