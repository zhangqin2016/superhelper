"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");

const PERMISSION_MODES = [
  {
    id: "default",
    label: "默认权限",
    description: "执行敏感操作前会请求确认。",
  },
  {
    id: "acceptEdits",
    label: "自动审阅",
    description: "自动批准文件修改，其他操作仍会确认。",
  },
  {
    id: "bypassPermissions",
    label: "完全授权",
    description: "无需确认即可读写文件、执行命令。",
  },
];

const DEFAULT_MODE = "bypassPermissions";

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

module.exports = {
  getActivePermissionMode,
  listPermissionsPublic,
  setActivePermissionMode,
};
