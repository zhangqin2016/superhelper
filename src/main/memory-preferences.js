"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");

const MEMORY_CATEGORIES = [
  "session_summary",
  "compaction_state",
  "evidence_gap",
  "project_identity",
  "project_memory",
  "workspace_digest",
  "learned_conventions",
];

function safeProjectFile(projectId) {
  return `${String(projectId || "default").replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

function preferencesPath(projectId) {
  return userDataPath("memory-preferences", safeProjectFile(projectId));
}

function normalizeDisabledKinds(value) {
  const allowed = new Set(MEMORY_CATEGORIES);
  return [...new Set(Array.isArray(value) ? value : [])]
    .map((item) => String(item || ""))
    .filter((item) => allowed.has(item));
}

function readMemoryPreferences(projectId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(preferencesPath(projectId), "utf8"));
    return {
      schemaVersion: 1,
      disabledKinds: normalizeDisabledKinds(parsed.disabledKinds),
    };
  } catch {
    return { schemaVersion: 1, disabledKinds: [] };
  }
}

function writeMemoryPreferences(projectId, preferences = {}) {
  const next = {
    schemaVersion: 1,
    disabledKinds: normalizeDisabledKinds(preferences.disabledKinds),
  };
  const filePath = preferencesPath(projectId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function setMemoryCategoryEnabled(projectId, kind, enabled) {
  const current = readMemoryPreferences(projectId);
  const disabled = new Set(current.disabledKinds);
  const key = String(kind || "");
  if (!MEMORY_CATEGORIES.includes(key)) return null;
  if (enabled) disabled.delete(key);
  else disabled.add(key);
  return writeMemoryPreferences(projectId, { disabledKinds: [...disabled] });
}

module.exports = {
  MEMORY_CATEGORIES,
  normalizeDisabledKinds,
  preferencesPath,
  readMemoryPreferences,
  setMemoryCategoryEnabled,
  writeMemoryPreferences,
};
