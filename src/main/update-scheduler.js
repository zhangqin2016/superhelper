"use strict";

const START_DELAY_MS = 8_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_GAP_MS = 30 * 60 * 1000;

let started = false;
let lastCheckAt = 0;

async function runUpdateCheck(reason = "scheduled") {
  const now = Date.now();
  if (reason !== "kick" && now - lastCheckAt < MIN_GAP_MS) {
    return getUpdateState();
  }
  lastCheckAt = now;

  const licensed = require("./license-manager").requireValidLicense();
  if (!licensed.ok) {
    return { ok: false, error: licensed.error || "LICENSE_REQUIRED" };
  }

  try {
    return await require("./update-manager").checkForUpdatesState();
  } catch (err) {
    console.warn("[updates:scheduler]", reason, err?.message || err);
    return { ok: false, error: "GENERIC", detail: err?.message || String(err) };
  }
}

function getUpdateState() {
  return require("./update-manager").getUpdateState();
}

function startBackgroundUpdateChecks() {
  if (started) return;
  started = true;

  Promise.allSettled([
    require("./service-client").registerDevice(),
    require("./license-manager").refreshServerLicense(),
  ]).finally(() => {
    setTimeout(() => {
      runUpdateCheck("bootstrap").catch((err) => {
        console.warn("[updates:scheduler] bootstrap", err?.message || err);
      });
    }, START_DELAY_MS);
  });

  setInterval(() => {
    runUpdateCheck("interval").catch((err) => {
      console.warn("[updates:scheduler] interval", err?.message || err);
    });
  }, INTERVAL_MS);
}

function kickUpdateCheck() {
  return runUpdateCheck("kick");
}

module.exports = {
  startBackgroundUpdateChecks,
  kickUpdateCheck,
  runUpdateCheck,
};
