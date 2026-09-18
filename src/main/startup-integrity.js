"use strict";

/**
 * Whether the launch gate has to verify the message database page by page
 * before the app may open.
 *
 * The gate is the only blocking step at launch, and its cost is one thing:
 * `PRAGMA integrity_check` reads every page of the file. Measured on a real
 * 918 MB database, cold: 3729 ms, against 2 ms for everything else the gate
 * decides (header, schema, hot-journal rollback, restore receipt, counts).
 * Because the window is shown once the check passes 800 ms, every user with a
 * large history sat and watched that page on every cold launch.
 *
 * The verification is NOT dropped — dropping it is how someone loses a
 * database. It moves off the critical path: the gate admits on everything it
 * decided before minus the page scan, and the full check runs in the
 * background immediately after, so coverage per launch is unchanged. What
 * changes is only whether the user waits for it.
 *
 * The gate still blocks on the full check whenever there is a reason to doubt
 * the file:
 *   - the previous run did not reach `before-quit` (crash, force quit, power
 *     loss, the OS killing a frozen window — exactly the case where a torn
 *     write is plausible);
 *   - the previous background verification failed or never finished;
 *   - this marker is missing or unreadable, which includes every first launch
 *     and every upgrade from a build that did not write one.
 *
 * Fail-closed by construction: every uncertainty answers "verify". The worst a
 * corrupt marker can do is make launch as slow as it was before.
 * [gate: startup-admission]
 */

const fs = require("node:fs");
const path = require("node:path");

const FILE_NAME = "startup-integrity.json";
const VERSION = 1;

function markerPath(userDataDir) {
  return path.join(userDataDir, FILE_NAME);
}

function readMarker(userDataDir) {
  try {
    const raw = fs.readFileSync(markerPath(userDataDir), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && parsed.version === VERSION ? parsed : null;
  } catch {
    return null;
  }
}

function writeMarker(userDataDir, patch) {
  try {
    const current = readMarker(userDataDir) || { version: VERSION };
    const next = { ...current, version: VERSION, ...patch };
    const file = markerPath(userDataDir);
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(temp, file);
    return next;
  } catch {
    // A marker that cannot be written simply means the next launch verifies.
    return null;
  }
}

/**
 * @returns {{ verify: boolean, reason: string }} `verify: true` means the full
 *   page scan must finish before the app opens.
 */
function decideStartupVerification(userDataDir, env = process.env) {
  if (env.LILY_STARTUP_FAST_ADMIT === "0") return { verify: true, reason: "disabled" };
  const marker = readMarker(userDataDir);
  if (!marker) return { verify: true, reason: "no_marker" };
  if (marker.cleanExit !== true) return { verify: true, reason: "unclean_exit" };
  if (marker.lastVerify?.ok !== true) return { verify: true, reason: "last_verify_not_ok" };
  return { verify: false, reason: "clean_and_verified" };
}

/**
 * Called once the decision has been read: from here until `before-quit` writes
 * the clean flag, this run counts as unclean. A crash therefore leaves the
 * marker dirty without anyone having to catch the crash.
 */
function markLaunchInProgress(userDataDir) {
  return writeMarker(userDataDir, { cleanExit: false, launchedAt: Date.now() });
}

function markCleanExit(userDataDir) {
  return writeMarker(userDataDir, { cleanExit: true, exitedAt: Date.now() });
}

/** Record what the background page scan concluded; a failure makes the next launch block on it. */
function recordVerification(userDataDir, { ok, reason } = {}) {
  return writeMarker(userDataDir, { lastVerify: { ok: ok === true, reason: reason || null, at: Date.now() } });
}

module.exports = {
  FILE_NAME,
  VERSION,
  decideStartupVerification,
  markCleanExit,
  markLaunchInProgress,
  markerPath,
  readMarker,
  recordVerification,
  writeMarker,
};
