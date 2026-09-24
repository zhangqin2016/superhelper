"use strict";

/**
 * Carrying out a mandatory update. What is mandatory is decided by
 * update-enforcement.js; this drives it against the update manager's state.
 *
 * Order is fixed: download, then wait until no task is running, then a
 * countdown the user can cut short ("restart now") or postpone within the
 * delivered limits ("later"). A task started during the countdown sends it
 * back to waiting — a mandate never interrupts work. When the floor cannot be
 * reached automatically the state says why and offers the manual build;
 * nothing is blocked.
 *
 * The update manager is the host: it owns the state, the downloader and the
 * installer, and hands this module only the operations it needs.
 */

const { readJsonObject, writeJson } = require("./json-file");
const enforcement = require("./update-enforcement");

const IDLE_RECHECK_MS = 5_000;

/**
 * @param {object} host
 * @param {() => object} host.getState
 * @param {(patch: object) => object} host.setState
 * @param {() => boolean} host.isDownloadReady
 * @param {() => boolean} host.isBusy
 * @param {() => Promise<unknown>} host.download
 * @param {() => Promise<unknown>} host.install         installs now (caller already checked idleness)
 * @param {() => object|null} host.readRemotePolicy     remote-config's getRemoteUpdatePolicySync
 * @param {(listener: () => void) => void} host.onPolicyChanged
 * @param {() => string} host.deferralFile
 * @param {(a: string, b: string) => number} host.compareVersions
 * @param {() => string} host.appVersion
 * @param {{ downloading: string, checking: string }} host.phases
 */
function createUpdateMandate(host) {
  let timer = null;
  let attemptedFor = "";

  const readDeferral = () => readJsonObject(host.deferralFile(), null);

  function decide() {
    const state = host.getState();
    let raw = null;
    try {
      raw = host.readRemotePolicy();
    } catch {
      raw = null;
    }
    return enforcement.decideUpdateEnforcement({
      currentVersion: state.currentVersion || host.appVersion(),
      latestVersion: state.hasUpdate ? state.latestVersion : "",
      releaseRequiredVersion: state.requiredVersion || "",
      releaseRequiredReason: state.requiredReason || "",
      mandateDeadline: state.mandateDeadline || "",
      policy: enforcement.normalizeUpdatePolicy(raw),
      deferral: readDeferral(),
      now: Date.now(),
      compareVersions: host.compareVersions,
    });
  }

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function drive() {
    clearTimer();
    const decision = decide();
    const state = host.getState();
    if (!decision.required) return state.enforcement ? host.setState({ enforcement: null }) : state;
    const previous = state.enforcement;
    const base = { ...decision, installAt: null, waitingForIdle: false, blocked: null };

    if (!decision.satisfiable) return host.setState({ enforcement: { ...base, blocked: "NO_RELEASE_AT_REQUIRED_VERSION" } });
    if (!state.canAutoInstall) {
      return host.setState({ enforcement: { ...base, blocked: state.package?.url ? "MANUAL_INSTALL_REQUIRED" : "NO_AUTO_UPDATE_FEED" } });
    }
    if (!host.isDownloadReady()) {
      const target = state.latestVersion;
      const downloading = state.phase === host.phases.downloading;
      // One attempt per update check: a failed download reports and waits for
      // the next check instead of retrying in a loop.
      if (!downloading && attemptedFor !== target) {
        attemptedFor = target;
        host.download()
          .catch((err) => console.warn("[update-mandate] download failed", err?.message || err))
          .finally(() => {
            if (!host.isDownloadReady()) drive();
          });
      }
      const current = host.getState();
      const failed = current.phase !== host.phases.downloading && attemptedFor === target && current.error?.code === "AUTO_FEED_FAILED";
      return host.setState({ enforcement: { ...base, blocked: failed ? "DOWNLOAD_FAILED" : null } });
    }
    if (decision.deferredUntil) {
      timer = setTimeout(drive, Math.max(1_000, decision.deferredUntil - Date.now()));
      return host.setState({ enforcement: base });
    }
    if (host.isBusy()) {
      timer = setTimeout(drive, IDLE_RECHECK_MS);
      return host.setState({ enforcement: { ...base, waitingForIdle: true } });
    }
    // The countdown keeps its deadline across re-evaluations of the same mandate.
    const installAt = previous?.installAt && previous.requiredVersion === decision.requiredVersion && !previous.waitingForIdle
      ? previous.installAt
      : Date.now() + decision.countdownSeconds * 1000;
    timer = setTimeout(() => {
      timer = null;
      if (host.isBusy()) {
        drive();
        return;
      }
      host.install().catch((err) => {
        host.setState({ ok: false, error: { code: "INSTALL_FAILED", detail: err?.message || String(err) } });
      });
    }, Math.max(0, installAt - Date.now()));
    return host.setState({ enforcement: { ...base, installAt } });
  }

  /** "Later" on a mandatory update, within the delivered limit. */
  function defer() {
    const next = enforcement.nextDeferral(decide(), readDeferral(), Date.now());
    if (!next) return { ...host.getState(), ok: false, error: { code: "DEFER_NOT_ALLOWED", detail: "" } };
    try {
      writeJson(host.deferralFile(), next, { indent: 0 });
    } catch (err) {
      console.warn("[update-mandate] deferral not persisted", err?.message || err);
      return { ...host.getState(), ok: false, error: { code: "DEFER_NOT_SAVED", detail: "" } };
    }
    return drive();
  }

  /** A new update check starts a new download allowance. */
  function onCheck() {
    attemptedFor = "";
  }

  // A delivery rule can raise or lower the floor at any time.
  let subscribed = false;
  function subscribe() {
    if (subscribed) return;
    subscribed = true;
    try {
      host.onPolicyChanged(() => {
        if (host.getState().phase !== host.phases.checking) drive();
      });
    } catch {
      // remote config unavailable in some test contexts
    }
  }

  return { drive, defer, onCheck, subscribe };
}

module.exports = { createUpdateMandate };
