"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");

// One autonomy spectrum, three modes — no overlap. Plan (look only) → Ask
// (confirm before acting, the safe default) → Auto (full autonomy).
const PERMISSION_MODES = [
  {
    id: "plan",
    label: "Plan",
    description: "Read-only: analyze the workspace and propose a plan without changing files or running commands.",
  },
  {
    id: "ask",
    label: "Ask",
    description: "Confirm before editing files or running commands. Reading and research stay automatic.",
  },
  {
    id: "full",
    label: "Auto",
    description: "Full autonomy: edit files and run commands without asking. Use only in trusted workspaces.",
  },
];

const DEFAULT_MODE = "ask";

// Retired modes map onto the new spectrum. Only a prior explicit full-access
// choice keeps full autonomy; everything else lands on the safe confirm-first
// default so a migration never silently grants more power.
const LEGACY_MODE_MAP = {
  bypassPermissions: "full",
  auto: "ask",
  acceptEdits: "ask",
  dontAsk: "ask",
  default: "ask",
};

/** Resolve a stored/raw mode id to a current one, or null if unrecognizable. */
function migrateMode(modeId) {
  if (isValidMode(modeId)) return modeId;
  return LEGACY_MODE_MAP[modeId] || null;
}

/** @type {{ activeModeId: string } | null} */
let cachedChoice = null;

function userSettingsPath() {
  return userDataPath("permission-settings.json");
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function isValidMode(modeId) {
  return PERMISSION_MODES.some((mode) => mode.id === modeId);
}

function normalizeSessionPermissionMode(modeId) {
  if (modeId == null || modeId === "" || modeId === "inherit") return null;
  return migrateMode(modeId) || undefined;
}

function getActivePermissionMode() {
  const user = cachedChoice ?? readJson(userSettingsPath(), null);
  const migrated = migrateMode(user?.activeModeId);
  if (migrated) {
    cachedChoice = { activeModeId: migrated };
    return migrated;
  }
  return DEFAULT_MODE;
}

function listPermissionsPublic() {
  return {
    activeModeId: getActivePermissionMode(),
    modes: PERMISSION_MODES.map(({ id, label, description }) => ({ id, label, description })),
  };
}

function setActivePermissionMode(modeId) {
  if (!isValidMode(modeId)) return { ok: false, error: "NOT_FOUND" };
  cachedChoice = { activeModeId: modeId };
  writeJson(userSettingsPath(), cachedChoice);
  const mode = PERMISSION_MODES.find((item) => item.id === modeId);
  return { ok: true, activeModeId: modeId, label: mode?.label || modeId };
}

function resolveSessionPermissionMode(session) {
  return normalizeSessionPermissionMode(session?.permissionModeId) || getActivePermissionMode();
}

function listSessionPermissionsPublic(session) {
  const modeId = normalizeSessionPermissionMode(session?.permissionModeId) || null;
  return {
    modeId,
    effectiveModeId: modeId || getActivePermissionMode(),
    inherited: !modeId,
    globalModeId: getActivePermissionMode(),
    modes: PERMISSION_MODES.map(({ id, label, description }) => ({ id, label, description })),
  };
}

module.exports = {
  getActivePermissionMode,
  isValidMode,
  listPermissionsPublic,
  listSessionPermissionsPublic,
  normalizeSessionPermissionMode,
  resolveSessionPermissionMode,
  setActivePermissionMode,
};
