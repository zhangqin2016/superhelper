"use strict";

const START_DELAY_MS = 8_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_GAP_MS = 30 * 60 * 1000;

let started = false;
let lastCheckAt = 0;
let inFlight = null;
let lastSkillSyncAt = 0;
let skillSyncInFlight = null;

function warmServiceContext() {
  require("./service-client")
    .refreshClientBootstrap()
    .then(() => Promise.allSettled([
      require("./service-client").registerDevice(),
      require("./license-manager").refreshServerLicense(),
    ]))
    .then(() => require("./remote-config").refreshRemoteConfig())
    .catch((err) => {
      console.warn("[updates:scheduler] warmup", err?.message || err);
    });
}

async function runUpdateCheck(reason = "scheduled") {
  const now = Date.now();
  if (reason !== "kick" && now - lastCheckAt < MIN_GAP_MS) {
    return getUpdateState();
  }
  if (inFlight) return inFlight;
  lastCheckAt = now;

  inFlight = require("./update-manager")
    .checkForUpdatesState()
    .catch((err) => {
      console.warn("[updates:scheduler]", reason, err?.message || err);
      return { ok: false, error: "GENERIC", detail: err?.message || String(err) };
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function anyRunnerBusy(runnerPool) {
  if (!runnerPool) return false;
  for (const sessionId of runnerPool.getSessionIds()) {
    if (runnerPool.get(sessionId)?.isBusy()) return true;
  }
  return false;
}

async function runSkillPackageSync(ctx = {}, reason = "scheduled") {
  const now = Date.now();
  if (reason !== "kick" && now - lastSkillSyncAt < MIN_GAP_MS) {
    return { ok: true, skipped: true, reason: "MIN_GAP" };
  }
  if (skillSyncInFlight) return skillSyncInFlight;
  if (anyRunnerBusy(ctx.runnerPool)) {
    return { ok: true, skipped: true, reason: "RUNNER_BUSY" };
  }
  lastSkillSyncAt = now;

  skillSyncInFlight = require("./skill-manager")
    .syncServiceSkillPackages({ fetch: true })
    .then((result) => {
      if (result.ok && (result.installed?.length || result.updated?.length)) {
        const skillManager = require("./skill-manager");
        if (ctx.sessionManager) skillManager.syncInheritedSessionGuides(ctx.sessionManager);
        for (const sessionId of ctx.runnerPool?.getSessionIds?.() || []) {
          const runner = ctx.runnerPool.get(sessionId);
          if (runner?.isAlive() && !runner.isBusy() && !runner.reloadSkills()) {
            runner.terminate();
          }
        }
      }
      return result;
    })
    .catch((err) => {
      console.warn("[skills:scheduler]", reason, err?.message || err);
      return { ok: false, error: "GENERIC", detail: err?.message || String(err) };
    })
    .finally(() => {
      skillSyncInFlight = null;
    });

  return skillSyncInFlight;
}

function getUpdateState() {
  return require("./update-manager").getUpdateState();
}

function startBackgroundUpdateChecks(ctx = {}) {
  if (started) return;
  started = true;

  warmServiceContext();
  setTimeout(() => {
    runUpdateCheck("bootstrap").catch((err) => {
      console.warn("[updates:scheduler] bootstrap", err?.message || err);
    });
    runSkillPackageSync(ctx, "bootstrap").catch((err) => {
      console.warn("[skills:scheduler] bootstrap", err?.message || err);
    });
  }, START_DELAY_MS);

  setInterval(() => {
    runUpdateCheck("interval").catch((err) => {
      console.warn("[updates:scheduler] interval", err?.message || err);
    });
    runSkillPackageSync(ctx, "interval").catch((err) => {
      console.warn("[skills:scheduler] interval", err?.message || err);
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
  runSkillPackageSync,
};
