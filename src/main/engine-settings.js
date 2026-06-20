"use strict";

// Which assistant engine the app runs. OpenCode is the only engine; this stays
// a tiny standalone preference (read by SessionRunnerPool, surfaced in settings)
// so additional engines can be slotted in later. The LILY_ENGINE env var, when
// set, overrides the stored choice (dev/CI escape hatch).

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");

const SUPPORTED_ENGINES = ["opencode"];
const DEFAULT_ENGINE = "opencode";

/** @type {string | null} */
let cached = null;

function settingsPath() {
  return userDataPath("engine-settings.json");
}

function normalizeEngine(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return SUPPORTED_ENGINES.includes(value) ? value : DEFAULT_ENGINE;
}

function getStoredEngine() {
  if (cached) return cached;
  try {
    const file = settingsPath();
    if (fs.existsSync(file)) {
      const stored = JSON.parse(fs.readFileSync(file, "utf8"));
      if (stored?.engine && SUPPORTED_ENGINES.includes(stored.engine)) {
        cached = stored.engine;
        return cached;
      }
    }
  } catch {
    /* fall through to default */
  }
  cached = DEFAULT_ENGINE;
  return cached;
}

/** Effective engine: LILY_ENGINE env override wins, else the stored choice. */
function getEngine() {
  if (process.env.LILY_ENGINE) return normalizeEngine(process.env.LILY_ENGINE);
  return getStoredEngine();
}

function setEngine(engine) {
  const next = normalizeEngine(engine);
  cached = next;
  try {
    const file = settingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ engine: next }, null, 2), "utf8");
  } catch {
    /* best effort; cached value still applies for this session */
  }
  return { ok: true, engine: next };
}

function listEnginesPublic() {
  return {
    engine: getEngine(),
    supported: SUPPORTED_ENGINES,
    defaultEngine: DEFAULT_ENGINE,
    envOverride: process.env.LILY_ENGINE ? normalizeEngine(process.env.LILY_ENGINE) : null,
  };
}

module.exports = {
  SUPPORTED_ENGINES,
  DEFAULT_ENGINE,
  normalizeEngine,
  getEngine,
  setEngine,
  listEnginesPublic,
};
