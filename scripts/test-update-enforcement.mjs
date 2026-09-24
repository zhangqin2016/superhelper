#!/usr/bin/env node
// "Force update" was a checkbox with no effect: the server delivered
// `force: true`, the client stored it and nothing read it, and the delivered
// `policy.minAppVersion` was never read either. Every release, forced or not,
// installed only when the user happened to quit the app.
//
// This holds the mandate end to end:
//   - the server treats a forced release as a FLOOR (a forced 0.1.185 followed
//     by an ordinary 0.1.186 still binds every client below 0.1.185);
//   - how the mandate lands (countdown, postponement, how many) is delivered
//     policy, bounded and validated on save, with the client fallback equal to
//     the server default;
//   - the client decides in one pure module and the update manager carries it
//     out: download, wait for running tasks, countdown, install — a task that
//     starts during the countdown sends it back to waiting, "later" works only
//     within the delivered limit, and an unreachable floor is a notice, never a
//     locked app.
// [gate: update-enforcement]
// Run: node scripts/test-update-enforcement.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/lily_update_enforcement_test";
let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`ok - ${name}`); };

const enforcement = require("../src/main/update-enforcement.js");
const releaseVersions = await import("../server/src/services/release-versions.js");
const updatePolicy = await import("../server/src/services/update-policy.js");
const compare = releaseVersions.compareVersions;

await check("a forced release is a floor, not a flag on the newest row", () => {
  const rows = [
    { version: "0.1.186", force_update: false },
    { version: "0.1.185", force_update: true },
    { version: "0.1.180", force_update: true },
  ];
  assert.equal(releaseVersions.requiredVersionFor(rows, "0.1.179"), "0.1.185", "the highest forced release above the client");
  assert.equal(releaseVersions.requiredVersionFor(rows, "0.1.183"), "0.1.185", "an ordinary newer release does not cancel it");
  assert.equal(releaseVersions.requiredVersionFor(rows, "0.1.185"), "", "a client at the floor owes nothing");
  assert.equal(releaseVersions.requiredVersionFor(rows, "0.1.99"), "0.1.185", "compared by meaning: 0.1.99 < 0.1.185");
  assert.equal(compare("0.1.0-beta", "0.1.0") < 0, true, "a pre-release comes before its release");
  assert.deepEqual([...releaseVersions.forcedFloors([{ platform: "darwin-arm64", version: "0.1.185", force_update: true }, { platform: "darwin-arm64", version: "0.1.190", force_update: false }])], [["darwin-arm64", "0.1.185"]]);
  const catalog = fs.readFileSync(path.join(ROOT, "server/src/routes/public/catalog.js"), "utf8");
  // The endpoint answers the floor through the one offer decision (release-offer.js).
  assert.match(catalog, /const \{ release, requiredVersion \} = offerRelease\(/, "the update endpoint answers the floor");
  assert.match(fs.readFileSync(path.join(ROOT, "server/src/services/release-offer.js"), "utf8"), /requiredVersionFor\(visible, currentVersion\)/);
  assert.match(catalog, /force: Boolean\(requiredVersion\)/);
  assert.ok(!/function compareVersions/.test(catalog), "version order is not re-implemented in the endpoint");
});

await check("the client fallback is the server default, and both bound the same way", () => {
  assert.deepEqual({ ...enforcement.FALLBACK_UPDATE_POLICY }, { ...updatePolicy.UPDATE_POLICY_DEFAULT });
  assert.deepEqual(JSON.parse(JSON.stringify(enforcement.UPDATE_POLICY_BOUNDS)), JSON.parse(JSON.stringify(updatePolicy.UPDATE_POLICY_BOUNDS)));
  const clientConfig = fs.readFileSync(path.join(ROOT, "server/src/services/client-config.js"), "utf8");
  assert.equal((clientConfig.match(/update: \{ \.\.\.UPDATE_POLICY_DEFAULT \}/g) || []).length, 2, "both delivered baselines carry the default");
});

await check("a rule's update policy is validated on save", async () => {
  const err = updatePolicy.updatePolicyError;
  assert.equal(err(undefined), null);
  assert.equal(err({ minAppVersion: "0.1.185", update: { countdownSeconds: 30, deferMinutes: 15, maxDeferrals: 0 } }), null);
  assert.match(err({ minAppVersion: "latest" }).message, /minAppVersion/);
  assert.match(err({ update: { countdownSeconds: 2 } }).message, /between 10 and 600/, "a countdown too short to save work is refused");
  assert.match(err({ update: { maxDeferrals: 99 } }).message, /between 0 and 10/, "unlimited postponement is no mandate");
  assert.match(err({ update: { deferMinutes: 1.5 } }).message, /integer/);
  assert.match(err({ update: { forever: true } }).message, /not a known setting/);
  const { validateConfigProfileConfig } = await import("../server/src/services/config-profile-validation.js");
  assert.equal(validateConfigProfileConfig({ policy: { update: { countdownSeconds: 5 } } }).code, "CONFIG_PROFILE_INVALID_POLICY");
  assert.equal(validateConfigProfileConfig({ policy: { minAppVersion: "0.1.185" } }), null);
});

const policy = (raw) => enforcement.normalizeUpdatePolicy(raw);
const decide = (input) => enforcement.decideUpdateEnforcement({ compareVersions: compare, now: 1_000_000, policy: policy(null), deferral: null, ...input });

await check("the decision: which floor binds, whether a build reaches it, what may be postponed", () => {
  assert.deepEqual(decide({ currentVersion: "0.1.186", latestVersion: "0.1.186", releaseRequiredVersion: "0.1.185" }), { required: false });
  const byRelease = decide({ currentVersion: "0.1.180", latestVersion: "0.1.186", releaseRequiredVersion: "0.1.185" });
  assert.equal(byRelease.required, true);
  assert.equal(byRelease.requiredVersion, "0.1.185");
  assert.deepEqual(byRelease.reasons, ["release"]);
  assert.equal(byRelease.satisfiable, true);
  const both = decide({ currentVersion: "0.1.180", latestVersion: "0.1.190", releaseRequiredVersion: "0.1.185", policy: policy({ minAppVersion: "0.1.188", update: {} }) });
  assert.equal(both.requiredVersion, "0.1.188", "the higher floor binds");
  assert.deepEqual(both.reasons, ["release", "policy"]);
  const unreachable = decide({ currentVersion: "0.1.180", latestVersion: "0.1.186", policy: policy({ minAppVersion: "0.1.200" }) });
  assert.equal(unreachable.satisfiable, false, "no installable build reaches the floor — the manager must not act on it");
  const tuned = policy({ minAppVersion: "", update: { countdownSeconds: 1, deferMinutes: 99999, maxDeferrals: "x" } });
  assert.deepEqual([tuned.countdownSeconds, tuned.deferMinutes, tuned.maxDeferrals], [10, 1440, 3], "a malformed payload is bounded, never trusted");
  assert.equal(policy(null).source, "fallback");
  assert.equal(policy({ update: { countdownSeconds: 30 } }).source, "delivered");
});

await check("postponements belong to one mandate and run out", () => {
  const p = policy({ update: { countdownSeconds: 30, deferMinutes: 20, maxDeferrals: 2 } });
  const input = { currentVersion: "0.1.180", latestVersion: "0.1.186", releaseRequiredVersion: "0.1.185", policy: p };
  let deferral = null;
  let decision = decide({ ...input, deferral });
  assert.equal(decision.deferralsLeft, 2);
  deferral = enforcement.nextDeferral(decision, deferral, 1_000_000);
  assert.deepEqual(deferral, { version: "0.1.185", count: 1, until: 1_000_000 + 20 * 60_000 });
  decision = decide({ ...input, deferral });
  assert.equal(decision.deferredUntil, deferral.until, "postponed until then");
  assert.equal(decision.deferralsLeft, 1);
  deferral = enforcement.nextDeferral(decision, deferral, 1_000_000);
  decision = decide({ ...input, deferral });
  assert.equal(decision.canDefer, false, "the delivered limit is reached");
  assert.equal(enforcement.nextDeferral(decision, deferral, 1_000_000), null);
  const newer = decide({ ...input, releaseRequiredVersion: "0.1.186", deferral });
  assert.equal(newer.deferralsLeft, 2, "a newer floor is a new mandate with its own allowance");
  const expired = decide({ ...input, deferral: { version: "0.1.185", count: 1, until: 999_999 } });
  assert.equal(expired.deferredUntil, null, "a postponement that has passed no longer holds");
});

// ── The update manager carries it out ───────────────────────────────────────
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-update-enforcement-"));
const world = {
  busy: false,
  packaged: true,
  release: { version: "0.1.186", requiredVersion: "0.1.185", force: true, feedUrl: "https://svc.example/feed", url: "https://svc.example/Lily.dmg" },
  remotePolicy: { minAppVersion: "", update: { countdownSeconds: 30, deferMinutes: 20, maxDeferrals: 1 } },
  installs: 0,
  downloads: 0,
  refreshListeners: [],
};
const updaterHandlers = {};
const autoUpdater = {
  on(event, handler) { updaterHandlers[event] = handler; },
  setFeedURL() {},
  async checkForUpdates() {},
  async downloadUpdate() { world.downloads += 1; if (world.downloadFails) throw new Error("feed unreachable"); updaterHandlers["update-downloaded"]?.(); },
  quitAndInstall() { world.installs += 1; },
};
const stubs = {
  electron: { app: { getVersion: () => "0.1.180", getPath: () => userData, get isPackaged() { return world.packaged; } }, shell: { openExternal: async () => {} } },
  "electron-updater": { autoUpdater },
  "./service-client": { getServiceSettings: () => ({ apiBaseUrl: "https://svc.example" }), latestRelease: async () => ({ ok: true, json: world.release }) },
  "./remote-config": { getRemoteUpdatePolicySync: () => world.remotePolicy, onRemoteConfigRefreshed: (fn) => world.refreshListeners.push(fn) },
  "./proxy-aware-fetch": async () => ({ ok: false, status: 404, statusText: "none" }),
  "./license-manager": { loadPublicKey: () => null },
  "./config": { userDataPath: (...segments) => path.join(userData, ...segments) },
};
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request in stubs) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};
// Timers are driven by hand: a countdown is a callback we fire, not a wait.
const timers = [];
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; };
globalThis.clearTimeout = (timer) => { if (timer && typeof timer === "object" && "cleared" in timer) timer.cleared = true; else realClearTimeout(timer); };
const fireDue = () => {
  const due = timers.filter((timer) => !timer.cleared && !timer.fired);
  for (const timer of due) { timer.fired = true; timer.fn(); }
  return due.length;
};

const manager = require("../src/main/update-manager.js");
manager.configure({ runnerPool: { getSessionIds: () => (world.busy ? ["s1"] : []), get: () => ({ isBusy: () => world.busy }) } });
const settle = () => new Promise((resolve) => setImmediate(resolve));

try {
  await check("a forced release downloads, waits for the running task, then counts down and installs", async () => {
    world.busy = true;
    let state = await manager.checkForUpdatesState();
    await settle();
    state = manager.getUpdateState();
    assert.equal(world.downloads, 1, "downloaded without waiting for a click, even with silent updates off");
    assert.equal(state.enforcement.required, true);
    assert.equal(state.enforcement.requiredVersion, "0.1.185");
    assert.equal(state.enforcement.waitingForIdle, true, "a running task holds the mandate back");
    assert.equal(state.enforcement.installAt, null, "no countdown while work runs");
    world.busy = false;
    fireDue(); // the idle re-check
    state = manager.getUpdateState();
    assert.ok(state.enforcement.installAt, "idle: the countdown starts");
    const countdown = timers.filter((t) => !t.cleared && !t.fired).at(-1);
    assert.equal(countdown.ms > 29_000 && countdown.ms <= 30_000, true, `the delivered 30s countdown, got ${countdown.ms}`);
    world.busy = true;
    fireDue(); // countdown ends while a task has just started
    assert.equal(world.installs, 0, "a task that started during the countdown is never interrupted");
    assert.equal(manager.getUpdateState().enforcement.waitingForIdle, true);
    world.busy = false;
    fireDue(); // idle again → new countdown
    fireDue(); // countdown ends → installUpdate
    await settle();
    fireDue(); // installUpdate hands off to quitAndInstall on its own short timer
    assert.equal(world.installs, 1, "installed");
  });

  await check("'later' postpones within the delivered limit, then it is gone", async () => {
    const state = manager.getUpdateState();
    assert.equal(state.enforcement.canDefer, true);
    const deferred = manager.deferUpdate();
    assert.ok(deferred.enforcement.deferredUntil > Date.now(), "postponed");
    assert.equal(deferred.enforcement.installAt, null, "the countdown is withdrawn");
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, "update-deferral.json"), "utf8")).count, 1, "survives a restart");
    const again = manager.deferUpdate();
    assert.equal(again.ok, false);
    assert.equal(again.error.code, "DEFER_NOT_ALLOWED", "maxDeferrals: 1 means one");
  });

  await check("a scope's minimum version is a mandate too, from the delivered policy", async () => {
    fs.rmSync(path.join(userData, "update-deferral.json"), { force: true });
    world.release = { version: "0.1.190", requiredVersion: "", force: false, feedUrl: "https://svc.example/feed", url: "https://svc.example/Lily.dmg" };
    world.remotePolicy = { minAppVersion: "0.1.188", update: { countdownSeconds: 30, deferMinutes: 20, maxDeferrals: 1 } };
    const state = await manager.checkForUpdatesState();
    assert.equal(state.enforcement.required, true);
    assert.deepEqual(state.enforcement.reasons, ["policy"]);
    world.remotePolicy = { minAppVersion: "", update: null };
    for (const listener of world.refreshListeners) listener();
    assert.equal(manager.getUpdateState().enforcement, null, "lowering the floor on the server lifts the mandate without a new check");
  });

  await check("an unreachable floor is a notice with a way out, never a locked app", async () => {
    world.remotePolicy = { minAppVersion: "0.1.200", update: null };
    let state = await manager.checkForUpdatesState();
    assert.equal(state.enforcement.blocked, "NO_RELEASE_AT_REQUIRED_VERSION");
    assert.equal(state.enforcement.installAt, null);
    world.remotePolicy = { minAppVersion: "0.1.188", update: null };
    world.packaged = false;
    const installsBefore = world.installs;
    state = await manager.checkForUpdatesState();
    assert.equal(state.enforcement.blocked, "MANUAL_INSTALL_REQUIRED", "an install that cannot self-update is sent to the download");
    assert.equal(state.package.url, "https://svc.example/Lily.dmg");
    fireDue();
    assert.equal(world.installs, installsBefore, "and nothing is installed or forced");
  });
} finally {
  Module._load = originalLoad;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  fs.rmSync(userData, { recursive: true, force: true });
}

await check("the console can mark a shipped release mandatory, and shows who is still below it", () => {
  const releases = fs.readFileSync(path.join(ROOT, "server/src/routes/admin/releases.js"), "utf8");
  assert.match(releases, /forceUpdate: z\.boolean\(\)\.optional\(\)/, "an existing release can be made mandatory");
  assert.match(releases, /force_update: input\.forceUpdate/);
  const attention = fs.readFileSync(path.join(ROOT, "server/src/services/admin-attention.js"), "utf8");
  assert.match(attention, /kind: "fleetBelowRequired"/, "the dashboard counts active devices below the floor");
  const tables = fs.readFileSync(path.join(ROOT, "web/components/admin-tables.js"), "utf8");
  assert.match(tables, /setReleaseForceAction/);
  assert.match(tables, /<DangerForm action=\{setReleaseForceAction\} confirm=/, "making a release mandatory asks first");
  const preload = fs.readFileSync(path.join(ROOT, "src/preload.js"), "utf8");
  assert.match(preload, /deferUpdate: \(\) => ipcRenderer\.invoke\("updates:defer"\)/);
  for (const locale of ["zh-CN", "en", "ar"]) {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, `src/renderer/i18n/locales/${locale}.json`), "utf8"));
    for (const key of ["update.mandate.title", "update.mandate.countdown", "update.mandate.now", "update.mandate.later", "update.mandate.blocked.NO_RELEASE_AT_REQUIRED_VERSION", "update.mandate.blocked.MANUAL_INSTALL_REQUIRED", "update.mandate.blocked.DOWNLOAD_FAILED", "update.mandate.blocked.NO_AUTO_UPDATE_FEED", "update.error.DEFER_NOT_ALLOWED"]) {
      assert.ok(dict[key], `${locale} has ${key}`);
    }
  }
});

await check("only --mandatory makes a release mandatory; --force can no longer do it by accident", async () => {
  // One --force fed three scripts: "republish unchanged catalog packages" in
  // one, "force update" in the other two — 20 releases were marked mandatory
  // that way before the client honoured the flag.
  const oneClick = fs.readFileSync(path.join(ROOT, "scripts/release-one-click.mjs"), "utf8");
  assert.ok(!/publishArgs\.push\("--force"\)|serverArgs\.push\("--force"\)/.test(oneClick), "--force is not forwarded to a release step");
  assert.match(oneClick, /if \(options\.mandatory\) serverArgs\.push\("--mandatory"\)/);
  assert.match(oneClick, /if \(options\.force\) catalogArgs\.push\("--force"\)/, "--force keeps its catalog meaning");
  assert.match(fs.readFileSync(path.join(ROOT, "scripts/publish-release-server.mjs"), "utf8"), /forceUpdate: Boolean\(options\.mandatory\)/);
  assert.match(fs.readFileSync(path.join(ROOT, "scripts/release-admin.mjs"), "utf8"), /force: Boolean\(options\.mandatory\),/);
  const { spawnSync } = await import("node:child_process");
  for (const script of ["scripts/publish-release-server.mjs", "scripts/release-admin.mjs"]) {
    const run = spawnSync(process.execPath, [path.join(ROOT, script), "manifest", "--force"], { encoding: "utf8", env: { ...process.env, RELEASE_ADMIN_TOKEN: "" } });
    assert.notEqual(run.status, 0, `${script} refuses --force`);
    assert.match(run.stderr, /--mandatory/, `${script} says what to use instead`);
  }
});

console.log(`\n${checks} checks passed (update enforcement)`);
