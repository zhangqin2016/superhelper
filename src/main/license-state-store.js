"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const jsonFile = require("./json-file");
const path = require("node:path");
const { userDataPath } = require("./config");

const LICENSE_FILE = "license-state.json";
const LICENSE_BACKUP_FILE = `${LICENSE_FILE}.bak`;
const secretStorage = require("./secret-storage");
// Names kept for license-manager; the policy (no silent Base64) is the seam's.
const protectText = (text) => secretStorage.protectSecret(text);
const unprotectText = (record) => secretStorage.unprotectSecret(record);

function statePath() {
  return userDataPath(LICENSE_FILE);
}

function backupStatePath() {
  return userDataPath(LICENSE_BACKUP_FILE);
}

function readState() {
  for (const [index, file] of [statePath(), backupStatePath()].entries()) {
    try {
      if (!fs.existsSync(file)) continue;
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      if (index > 0) console.warn("[license] recovered state from backup snapshot");
      return state && typeof state === "object" && !Array.isArray(state) ? state : {};
    } catch (error) {
      console.warn("[license] state read failed%s: %s", index > 0 ? " (backup)" : "", error?.message || error);
    }
  }
  return {};
}

function writeState(state) {
  const primary = statePath();
  jsonFile.writeJson(primary, state, { mode: 0o600 });
  try {
    jsonFile.writeJson(backupStatePath(), state, { mode: 0o600 });
  } catch (error) {
    console.warn("[license] backup snapshot write failed:", error?.message || error);
  }
}

module.exports = { protectText, readState, unprotectText, writeState };
