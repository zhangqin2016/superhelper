"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");

const PERMISSION_MODES = [
  {
    id: "auto",
    label: "Auto (Smart)",
    description: "Routine operations are handled automatically; confirmation is only requested for uncertain or high-risk actions.",
  },
  {
    id: "default",
    label: "Always Ask",
    description: "Confirmation is requested before any operation that may affect files or system settings.",
  },
  {
    id: "acceptEdits",
    label: "Auto-Edit Files",
    description: "File modifications are allowed without per-edit confirmation; other important operations still require approval.",
  },
  {
    id: "plan",
    label: "Plan First",
    description: "The assistant explains its approach first and only begins execution after your approval.",
  },
  {
    id: "dontAsk",
    label: "Low Interruption",
    description: "No confirmation prompts; uncertain or risky operations are skipped silently.",
  },
  {
    id: "bypassPermissions",
    label: "Full Access",
    description: "No confirmations — direct file read/write and command execution. Recommended only for trusted projects.",
  },
];

const DEFAULT_MODE = "auto";

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
  return isValidMode(modeId) ? modeId : undefined;
}

function getActivePermissionMode() {
  const user = cachedChoice ?? readJson(userSettingsPath(), null);
  if (user?.activeModeId && isValidMode(user.activeModeId)) {
    cachedChoice = user;
    return user.activeModeId;
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
