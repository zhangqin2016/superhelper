"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");

const PERMISSION_MODES = [
  {
    id: "auto",
    label: "智能确认",
    description: "常规操作自动处理，拿不准或风险较高时再请你确认。",
  },
  {
    id: "default",
    label: "每次确认",
    description: "执行可能影响文件或电脑的操作前，都会先问你。",
  },
  {
    id: "acceptEdits",
    label: "自动改文件",
    description: "修改文件不用每次问你，其他重要操作仍会确认。",
  },
  {
    id: "plan",
    label: "先写计划",
    description: "先让助手说明准备怎么做，你同意后再开始执行。",
  },
  {
    id: "dontAsk",
    label: "少打扰",
    description: "不弹出确认；不确定或有风险的操作会直接跳过。",
  },
  {
    id: "bypassPermissions",
    label: "完全放开",
    description: "不再确认，直接读写文件和执行命令。只建议在可信项目里使用。",
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
