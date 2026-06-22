"use strict";

// Persisted user preference for task-completion alerts (sound + OS notification).
// Tiny JSON in userData, mirroring the other per-feature settings modules.
const fs = require("node:fs");
const { userDataPath } = require("./config");

const DEFAULTS = { sound: true, notify: true };
let cache = null;

function file() {
  return userDataPath("notification-settings.json");
}

function getNotificationSettings() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
    cache = {
      sound: typeof raw.sound === "boolean" ? raw.sound : DEFAULTS.sound,
      notify: typeof raw.notify === "boolean" ? raw.notify : DEFAULTS.notify,
    };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function setNotificationSettings(patch = {}) {
  const next = { ...getNotificationSettings() };
  if (typeof patch.sound === "boolean") next.sound = patch.sound;
  if (typeof patch.notify === "boolean") next.notify = patch.notify;
  cache = next;
  try {
    fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  } catch {
    /* preference is best-effort; never block on disk */
  }
  return next;
}

module.exports = { getNotificationSettings, setNotificationSettings };
