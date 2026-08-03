"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");

const LICENSE_FILE = "license-state.json";
const LICENSE_BACKUP_FILE = `${LICENSE_FILE}.bak`;

function electronSafeStorage() {
  try {
    return require("electron").safeStorage || null;
  } catch {
    return null;
  }
}

function statePath() {
  return userDataPath(LICENSE_FILE);
}

function backupStatePath() {
  return userDataPath(LICENSE_BACKUP_FILE);
}

function protectText(text) {
  const buf = Buffer.from(text, "utf8");
  const safeStorage = electronSafeStorage();
  if (safeStorage?.isEncryptionAvailable?.()) {
    return { encrypted: true, data: safeStorage.encryptString(text).toString("base64") };
  }
  return { encrypted: false, data: buf.toString("base64") };
}

function unprotectText(record) {
  if (!record?.data) return "";
  const buf = Buffer.from(record.data, "base64");
  if (!record.encrypted) return buf.toString("utf8");
  const safeStorage = electronSafeStorage();
  if (!safeStorage?.isEncryptionAvailable?.()) return "";
  try {
    return safeStorage.decryptString(buf);
  } catch (error) {
    console.warn("[license] stored license could not be decrypted:", error?.message || error);
    return "";
  }
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

function atomicWrite(file, text) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, text, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch {
      // The canonical state was not replaced, so a stale temp file is harmless.
    }
  }
}

function writeState(state) {
  const primary = statePath();
  fs.mkdirSync(path.dirname(primary), { recursive: true });
  const serialized = JSON.stringify(state, null, 2);
  atomicWrite(primary, serialized);
  try {
    atomicWrite(backupStatePath(), serialized);
  } catch (error) {
    console.warn("[license] backup snapshot write failed:", error?.message || error);
  }
}

module.exports = { protectText, readState, unprotectText, writeState };
