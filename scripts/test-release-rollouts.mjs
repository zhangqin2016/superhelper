#!/usr/bin/env node
// A release was a row and a mutable file: publishing overwrote the one
// stable/latest.yml every client read, so every release went to everyone at
// once and a bad one could only be overwritten again.
//
// This holds the rollout layer — and, first, that it changes nothing until it
// is used: with no rollout rows the device is offered exactly what it was
// before, delivery-rule rollouts bucket exactly as before, and a legacy
// release's feed URL is byte-for-byte the old one.
// [gate: release-rollouts]
// Run: node scripts/test-release-rollouts.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/lily_release_rollouts_test";
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`ok - ${name}`); };

const { offerRelease, releaseVisibleTo, releaseFeedUrl } = await import("../server/src/services/release-offer.js");
const { transitionRollout } = await import("../server/src/services/release-rollouts.js");
const { rolloutBucket, inRollout } = await import("../server/src/services/rollout-bucket.js");
const { rolloutAllows } = await import("../server/src/services/client-config.js");
const { judgeHealth, baselineFor } = await import("../server/src/services/release-health.js");

const rel = (id, version, extra = {}) => ({ id, version, platform: "darwin-arm64", created_at: "2026-09-20T00:00:00Z", enabled: true, immutable_feed: false, ...extra });
const devices = Array.from({ length: 2000 }, (_, i) => `dev_${i}`);

await check("unused, it changes nothing: no rollout rows → the newest enabled release for everyone", () => {
  const releases = [rel("r1", "0.1.182"), rel("r2", "0.1.183"), rel("r0", "0.1.99")];
  for (const deviceId of ["", "dev_a", "dev_b"]) {
    assert.equal(offerRelease({ releases, rollouts: [], deviceId }).release.id, "r2", "same answer as the old newestRelease, for every device");
  }
  // Delivery-rule rollouts keep their exact buckets (the old inline formula).
  for (const [id, device] of [["rule_a", "dev_1"], ["lily-default-runtime", "dev_x"], ["p", "q"]]) {
    const old = Number.parseInt(createHash("sha256").update(`${id}:${device}`).digest("hex").slice(0, 8), 16) % 100;
    assert.equal(rolloutBucket(id, device), old);
    for (const percent of [1, 37, 99]) assert.equal(rolloutAllows({ id, rollout_percent: percent }, device), old < percent);
  }
  // A legacy release's feed URL is the one clients have always been sent.
  assert.equal(releaseFeedUrl("https://qny.lanrensoft.cn", rel("r2", "0.1.183")),
    "https://qny.lanrensoft.cn/app/auto-updates/darwin-arm64/stable/latest-mac.yml?v=0.1.183");
  assert.equal(releaseFeedUrl("https://cdn/", { platform: "win32-x64", version: "0.1.182" }),
    "https://cdn/app/auto-updates/win32-x64/stable/latest.yml?v=0.1.182");
});

await check("a staged release reaches its slice, and only its slice", () => {
  const releases = [rel("r1", "0.1.183"), rel("r2", "0.1.184", { immutable_feed: true })];
  const rolling = { id: "rol_x", release_id: "r2", state: "rolling", percent: 10 };
  const offered = devices.map((deviceId) => offerRelease({ releases, rollouts: [rolling], deviceId }).release.version);
  const share = offered.filter((v) => v === "0.1.184").length / devices.length;
  assert.ok(share > 0.07 && share < 0.13, `about 10% get it, got ${(share * 100).toFixed(1)}%`);
  assert.equal(offerRelease({ releases, rollouts: [rolling], deviceId: "" }).release.version, "0.1.183", "an anonymous request (the download page) gets what everyone gets");
  const again = devices.map((deviceId) => offerRelease({ releases, rollouts: [rolling], deviceId }).release.version);
  assert.deepEqual(again, offered, "a device's answer is stable across checks");
  const widened = devices.filter((deviceId) => offerRelease({ releases, rollouts: [{ ...rolling, percent: 50 }], deviceId }).release.version === "0.1.184");
  assert.ok(offered.every((v, i) => v !== "0.1.184" || widened.includes(devices[i])), "widening keeps everyone already in");
  const otherRollout = devices.filter((d) => inRollout(10, "rol_y", d));
  const sameSlice = otherRollout.filter((d) => inRollout(10, "rol_x", d)).length;
  assert.ok(sameSlice < otherRollout.length * 0.3, "each rollout reaches a different slice, not the same guinea pigs");
  for (const state of ["draft", "paused", "halted"]) {
    assert.equal(offerRelease({ releases, rollouts: [{ ...rolling, state }], deviceId: "dev_1" }).release.version, "0.1.183", `${state}: no new device is offered it`);
  }
  assert.equal(offerRelease({ releases, rollouts: [{ ...rolling, state: "complete", percent: 100 }], deviceId: "" }).release.version, "0.1.184", "complete: everyone");
  assert.equal(releaseFeedUrl("https://qny.lanrensoft.cn", releases[1]),
    "https://qny.lanrensoft.cn/app/auto-updates/darwin-arm64/releases/0.1.184/latest-mac.yml", "the slice is pointed at the version's own feed");
  // A floor is only binding through a release the device is offered.
  const forced = [rel("r1", "0.1.183"), rel("r2", "0.1.184", { immutable_feed: true, force_update: true })];
  assert.equal(offerRelease({ releases: forced, rollouts: [{ ...rolling, state: "draft" }], deviceId: "dev_1", currentVersion: "0.1.180" }).requiredVersion, "");
  assert.equal(releaseVisibleTo(rel("x", "1"), null, ""), true);
});

await check("the rollout state machine: only widens, needs its own feed, one at a time", () => {
  const base = { state: "draft", percent: 0, immutable_feed: true };
  assert.deepEqual(transitionRollout(base, { action: "start", percent: 10 }, { now: new Date(0) }).patch, { state: "rolling", percent: 10, started_at: new Date(0) });
  assert.equal(transitionRollout(base, { action: "start", percent: 100 }).patch.state, "complete", "100% is complete");
  assert.equal(transitionRollout({ ...base, immutable_feed: false }, { action: "start", percent: 10 }).code, "ROLLOUT_NEEDS_IMMUTABLE_FEED");
  assert.equal(transitionRollout({ ...base, immutable_feed: false }, { action: "start", percent: 100 }).ok, true, "a legacy release can still go to everyone");
  assert.equal(transitionRollout(base, { action: "start", percent: 10 }, { otherActive: { id: "o", version: "0.1.9" } }).code, "ROLLOUT_ALREADY_ACTIVE");
  const rolling = { state: "rolling", percent: 25, immutable_feed: true };
  assert.equal(transitionRollout(rolling, { action: "raise", percent: 10 }).code, "ROLLOUT_PERCENT_NOT_HIGHER", "never narrows");
  assert.equal(transitionRollout(rolling, { action: "raise", percent: 50 }).patch.percent, 50);
  assert.equal(transitionRollout(rolling, { action: "pause" }).patch.state, "paused");
  assert.equal(transitionRollout({ ...rolling, state: "paused" }, { action: "resume" }).patch.state, "rolling");
  assert.equal(transitionRollout(rolling, { action: "halt" }).patch.state, "halted");
  assert.equal(transitionRollout({ ...rolling, state: "halted" }, { action: "raise", percent: 90 }).code, "ROLLOUT_TRANSITION_INVALID", "a halted rollout cannot be widened back to life");
  assert.equal(transitionRollout({ ...rolling, state: "halted" }, { action: "reopen" }).patch.state, "paused", "reopen returns it paused, not live");
  assert.equal(transitionRollout({ state: "complete", percent: 100 }, { action: "halt" }).code, "ROLLOUT_TRANSITION_INVALID");
  assert.deepEqual(transitionRollout(rolling, { action: "complete" }, { now: new Date(0) }).patch, { state: "complete", percent: 100, completed_at: new Date(0) });
  assert.equal(transitionRollout(rolling, { action: "explode" }).code, "ROLLOUT_ACTION_UNKNOWN");
});

await check("health compares like with like", () => {
  const v = (version, devicesCount, errors, reporting = true) => ({ platform: "darwin-arm64", version, devices: devicesCount, errors, reporting });
  assert.equal(judgeHealth(v("2", 5, 1), v("1", 100, 10)).verdict, "insufficient");
  assert.equal(judgeHealth(v("2", 50, 5), null).verdict, "no_baseline");
  assert.equal(judgeHealth(v("2", 50, 5), v("1", 50, 0, false)).verdict, "no_baseline", "a version that never reports is not a perfect baseline");
  assert.equal(judgeHealth(v("2", 50, 20), v("1", 100, 10)).verdict, "worse");
  assert.equal(judgeHealth(v("2", 50, 6), v("1", 100, 10)).verdict, "ok");
  const map = new Map([["a", v("0.1.99", 30, 1)], ["b", v("0.1.182", 30, 1)], ["c", v("0.1.183", 30, 1)], ["d", v("0.1.181", 30, 1, false)]]);
  assert.equal(baselineFor(map, "darwin-arm64", "0.1.183").version, "0.1.182", "the newest earlier reporting version, compared by meaning");
});

await check("the update endpoint decides through the offer, and survives the migration not having run", () => {
  const catalog = read("server/src/routes/public/catalog.js");
  assert.match(catalog, /offerRelease\(\{ releases, rollouts, deviceId, currentVersion \}\)/);
  assert.match(catalog, /request\.headers\["x-lily-device-id"\]/);
  assert.match(catalog, /\.catch\(\(\) => \[\]\), \/\/ before the rollout migration/);
  assert.match(catalog, /feedUrl: releaseFeedUrl\(config\.qiniuPublicBaseUrl, release\)/);
  const migration = read("server/migrations/056_release_rollouts.sql");
  assert.match(migration, /add column if not exists immutable_feed boolean not null default false/);
  assert.match(migration, /create table if not exists release_rollouts/);
});

await check("a staged publish leaves the shared fallbacks alone", () => {
  const oneClick = read("scripts/release-one-click.mjs");
  assert.match(oneClick, /const offerEveryoneNow = !options\.draft && \(rolloutPercent === null \|\| rolloutPercent === 100\);/, "omitting --rollout is today's behaviour");
  const pointerBlock = oneClick.slice(oneClick.indexOf("if (!offerEveryoneNow) {"), oneClick.indexOf('label: "mutable latest pointers"'));
  assert.match(pointerBlock, /\} else if \(options\.upload \|\| options\["dry-run"\]\) \{/, "pointer uploads only in the everyone-now branch");
  assert.match(oneClick, /const cdnUrls = offerEveryoneNow \? \[/, "and only then refreshes the shared pointers");
  assert.match(oneClick, /serverArgs\.push\("--immutable-feed"\)/);
  assert.match(oneClick, /releases\/\$\{nextVersion\}\/\$\{path\.basename\(releaseFeed\)\}/, "every release uploads its own feed");
  // Its own feed is not a pointer, though it shares the file name.
  const fnSource = oneClick.slice(oneClick.indexOf("function isMutablePointerUpload"), oneClick.indexOf("function appBuilderBinPath"));
  const isPointer = new Function("path", `${fnSource}; return isMutablePointerUpload;`)(path);
  assert.equal(isPointer({ key: "app/auto-updates/darwin-arm64/releases/0.1.184/latest-mac.yml", file: "x/latest-mac.yml" }), false);
  assert.equal(isPointer({ key: "app/auto-updates/darwin-arm64/stable/latest-mac.yml", file: "x/latest-mac.yml" }), true);
  assert.equal(isPointer({ key: "app/updates/latest.json", file: "release/0.1.184/latest.json" }), true);
  const run = spawnSync(process.execPath, [path.join(ROOT, "scripts/publish-release-server.mjs"), "--api", "http://127.0.0.1:9", "--token", "x", "--version", "1.0.0", "--rollout", "10", "--artifact", "darwin-arm64=/dev/null=https://cdn/x"], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /needs --immutable-feed/, "a partial rollout without its own feed is refused before anything is written");
});

await check("promotion refuses until the rollout is complete, from the prepared files", async () => {
  const promote = await import("../scripts/release-promote.mjs");
  const oneClick = read("scripts/release-one-click.mjs");
  for (const [key, constant] of [["bucket", "DEFAULT_BUCKET"], ["domain", "DEFAULT_DOMAIN"], ["prefix", "DEFAULT_PREFIX"], ["autoPrefix", "DEFAULT_AUTO_PREFIX"], ["serverApi", "DEFAULT_SERVER_API"]]) {
    assert.match(oneClick, new RegExp(`const ${constant} = "${promote.PROMOTE_DEFAULTS[key].replace(/[/.]/g, "\\$&")}";`), `${key} matches release-one-click`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-promote-"));
  try {
    const dir = path.join(root, "release", "0.1.184");
    fs.mkdirSync(path.join(dir, "auto", "darwin-arm64"), { recursive: true });
    fs.mkdirSync(path.join(dir, "auto", "win32-x64"), { recursive: true });
    fs.writeFileSync(path.join(dir, "latest.json"), "{}");
    fs.writeFileSync(path.join(dir, "auto", "darwin-arm64", "latest-mac.yml"), "version: \"0.1.184\"\n");
    fs.writeFileSync(path.join(dir, "auto", "win32-x64", "latest.yml"), "version: \"0.1.184\"\n");
    const plan = promote.promotionPlan({ version: "0.1.184", root });
    assert.deepEqual(plan.uploads.map((u) => u.key).sort(), ["app/auto-updates/darwin-arm64/stable/latest-mac.yml", "app/auto-updates/win32-x64/stable/latest.yml", "app/updates/latest.json"]);
    const partial = { platforms: [{ platform: "darwin-arm64", full: { version: "0.1.184" } }, { platform: "win32-x64", full: { version: "0.1.183" }, active: { version: "0.1.184", state: "rolling", percent: 25 } }] };
    assert.throws(() => promote.assertComplete(partial, "0.1.184", plan.platforms), /not offered to everyone yet[\s\S]*win32-x64: everyone gets 0\.1\.183 \(0\.1\.184 rolling 25%\)/);
    assert.doesNotThrow(() => promote.assertComplete({ platforms: [{ platform: "darwin-arm64", full: { version: "0.1.184" } }, { platform: "win32-x64", full: { version: "0.1.184" } }] }, "0.1.184", plan.platforms));
    assert.throws(() => promote.promotionPlan({ version: "9.9.9", root }), /missing/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("the real-database closed loop runs when a scratch Postgres is provided", () => {
  // server/scripts/release-rollouts-integration.mjs: real migrations, real routes, 200 devices.
  const url = process.env.LILY_TEST_DATABASE_URL || "";
  if (!url) {
    console.log("  (skipped: set LILY_TEST_DATABASE_URL to a scratch Postgres to run the closed loop)");
    return;
  }
  const run = spawnSync(process.execPath, [path.join(ROOT, "server/scripts/release-rollouts-integration.mjs")], {
    cwd: path.join(ROOT, "server"), env: { ...process.env, DATABASE_URL: url }, encoding: "utf8", timeout: 240_000,
  });
  assert.equal(run.status, 0, `closed loop failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /release rollouts integration: ok/);
});

console.log(`\n${checks} checks passed (release rollouts)`);
