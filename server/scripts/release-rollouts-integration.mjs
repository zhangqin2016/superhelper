#!/usr/bin/env node
// Closed loop for staged releases: real Postgres, the REAL migrations, the
// real admin and public routes, 200 simulated devices.
//
//   a legacy release is offered to everyone, exactly as before
//   → a new release created at 10% is, from its first instant, offered only
//     to its slice (release + rollout in one transaction — never unstaged)
//   → the download page (no device) keeps getting the full version
//   → widening keeps everyone already in; narrowing is refused
//   → halt: no new device is offered it; reopen returns it paused, not live
//   → complete: everyone; a partial rollout without its own feed is refused
//   → every move is audited
//
// Skips cleanly without DATABASE_URL. Uses a throwaway schema and drops it.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";

if (!process.env.DATABASE_URL) { console.log("release rollouts integration: skipped (DATABASE_URL not configured)"); process.exit(0); }

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = `release_rollouts_${crypto.randomUUID().replaceAll("-", "")}`;
const control = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const scoped = new URL(process.env.DATABASE_URL);
scoped.searchParams.set("options", `-c search_path=${schema}`);
scoped.searchParams.set("application_name", schema);

const cwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "release-rollouts-"));
process.chdir(temp); // never let dotenv read real operator secrets
const ADMIN_TOKEN = crypto.randomBytes(32).toString("hex");
// Stands in for the CDN: release creation HEADs the installer URL.
const cdn = Fastify({ logger: false });
cdn.head("/*", async (_request, reply) => reply.code(200).send());
const cdnUrl = await cdn.listen({ host: "127.0.0.1", port: 0 });
Object.assign(process.env, {
  DATABASE_URL: scoped.href,
  SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
  ADMIN_TOKEN,
  ADMIN_EMAIL: "test-admin@example.invalid",
  ADMIN_PASSWORD: crypto.randomBytes(16).toString("hex"),
  QINIU_PUBLIC_BASE_URL: "https://cdn.example",
  NODE_ENV: "test",
});

const step = (label) => console.log(`  · ${label}`);
let app, pool, closeDb;
try {
  await control.query(`create schema ${schema}`);
  step("apply the real migrations into the scratch schema");
  const migrate = spawnSync(process.execPath, [path.join(here, "migrate.mjs")], {
    env: { ...process.env, DATABASE_URL: scoped.href }, encoding: "utf8", cwd: path.resolve(here, ".."),
  });
  assert.equal(migrate.status, 0, `migrate failed:\n${migrate.stdout}\n${migrate.stderr}`);
  assert.match(migrate.stdout, /056_release_rollouts\.sql/, "migration 056 must be among those applied");

  const [dbMod, { adminRoutes }, { publicRoutes }, { installDocOnlyCompilers }] = await Promise.all([
    import("../src/db.js"), import("../src/routes/admin.js"), import("../src/routes/public.js"), import("../src/openapi.js"),
  ]);
  ({ pool, closeDb } = dbMod);
  app = Fastify({ logger: false });
  installDocOnlyCompilers(app);
  await app.register(cookie);
  await app.register(adminRoutes);
  await app.register(publicRoutes);

  const call = async (method, url, payload, headers = {}) => {
    const res = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }), headers });
    let body = null; try { body = res.json(); } catch { body = res.body; }
    return { status: res.statusCode, body };
  };
  const asAdmin = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const platform = "darwin-arm64";
  const release = (version, extra = {}) => ({ version, platform, url: `${cdnUrl}/Lily-${version}.dmg`, sha256: "a".repeat(64), sizeBytes: 1, ...extra });
  const devices = Array.from({ length: 200 }, (_, i) => `dev_${String(i).padStart(4, "0")}`);
  const offered = async (deviceId, version = "0.1.100") => {
    const res = await call("GET", `/api/releases/latest?platform=${platform}&version=${version}`, undefined, deviceId ? { "x-lily-device-id": deviceId } : {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };
  const share = async (version) => (await Promise.all(devices.map((d) => offered(d)))).filter((r) => r.version === version).length;

  step("a legacy release is offered to everyone, on the stable feed, as before");
  const legacy = await call("POST", "/api/admin/releases", release("0.1.183"), asAdmin);
  assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
  const legacyOffer = await offered("dev_0001");
  assert.equal(legacyOffer.version, "0.1.183");
  assert.equal(legacyOffer.feedUrl, "https://cdn.example/app/auto-updates/darwin-arm64/stable/latest-mac.yml?v=0.1.183");
  assert.equal(await share("0.1.183"), devices.length);

  step("a partial rollout without its own feed is refused, and nothing is written");
  const noFeed = await call("POST", "/api/admin/releases", release("0.1.184", { rolloutPercent: 10 }), asAdmin);
  assert.equal(noFeed.status, 400, JSON.stringify(noFeed.body));
  assert.equal(noFeed.body.code, "ROLLOUT_NEEDS_IMMUTABLE_FEED");
  assert.equal(Number((await pool.query("select count(*)::int n from releases where version='0.1.184'")).rows[0].n), 0, "no half-written release");

  step("created at 10%: from its first instant only its slice sees it");
  const staged = await call("POST", "/api/admin/releases", release("0.1.184", { immutableFeed: true, rolloutPercent: 10 }), asAdmin);
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  assert.equal(staged.body.rolloutState, "rolling");
  const rolloutId = staged.body.rolloutId;
  const tenPercent = await share("0.1.184");
  assert.ok(tenPercent > 8 && tenPercent < 40, `about 10% of 200, got ${tenPercent}`);
  const firstIn = (await Promise.all(devices.map(async (d) => [(await offered(d)).version, d]))).filter(([v]) => v === "0.1.184").map(([, d]) => d);
  const sample = await offered(firstIn[0]);
  assert.equal(sample.feedUrl, "https://cdn.example/app/auto-updates/darwin-arm64/releases/0.1.184/latest-mac.yml", "the slice is pointed at the version's own feed");
  assert.equal((await offered("")).version, "0.1.183", "the download page (no device) still offers the full version");

  step("the console shows both, with the rollout's reach");
  const summary = await call("GET", "/api/admin/rollouts", undefined, asAdmin);
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  const card = summary.body.platforms.find((p) => p.platform === platform);
  assert.equal(card.full.version, "0.1.183");
  assert.equal(card.active.version, "0.1.184");
  assert.equal(card.active.percent, 10);

  step("widening keeps everyone already in; narrowing is refused");
  assert.equal((await call("PATCH", `/api/admin/rollouts/${rolloutId}`, { action: "raise", percent: 5 }, asAdmin)).body.code, "ROLLOUT_PERCENT_NOT_HIGHER");
  assert.equal((await call("PATCH", `/api/admin/rollouts/${rolloutId}`, { action: "raise", percent: 50 }, asAdmin)).status, 200);
  const fifty = (await Promise.all(devices.map(async (d) => [(await offered(d)).version, d]))).filter(([v]) => v === "0.1.184").map(([, d]) => d);
  assert.ok(firstIn.every((d) => fifty.includes(d)), "no device that had it loses it by widening");
  assert.ok(fifty.length > firstIn.length);

  step("a second rollout on the same platform waits its turn");
  const second = await call("POST", "/api/admin/releases", release("0.1.185", { immutableFeed: true, rolloutPercent: 5 }), asAdmin);
  assert.equal(second.status, 400, JSON.stringify(second.body));
  assert.equal(second.body.code, "ROLLOUT_ALREADY_ACTIVE");

  step("halt: no device is offered it any more; reopen returns it paused, not live");
  assert.equal((await call("PATCH", `/api/admin/rollouts/${rolloutId}`, { action: "halt", reason: "crash spike" }, asAdmin)).status, 200);
  assert.equal(await share("0.1.184"), 0);
  assert.equal((await call("PATCH", `/api/admin/rollouts/${rolloutId}`, { action: "raise", percent: 90 }, asAdmin)).body.code, "ROLLOUT_TRANSITION_INVALID");
  assert.equal((await call("PATCH", `/api/admin/rollouts/${rolloutId}`, { action: "reopen" }, asAdmin)).body.state, "paused");
  assert.equal(await share("0.1.184"), 0, "paused still offers it to no one new");
  assert.equal((await call("PATCH", `/api/admin/rollouts/${rolloutId}`, { action: "resume" }, asAdmin)).body.state, "rolling");

  step("complete: everyone, including the download page");
  assert.equal((await call("PATCH", `/api/admin/rollouts/${rolloutId}`, { action: "complete" }, asAdmin)).body.state, "complete");
  assert.equal(await share("0.1.184"), devices.length);
  assert.equal((await offered("")).version, "0.1.184");

  step("a draft is published and offered to no one");
  const draft = await call("POST", "/api/admin/releases", release("0.1.186", { immutableFeed: true, draft: true }), asAdmin);
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  assert.equal(draft.body.rolloutState, "draft");
  assert.equal(await share("0.1.186"), 0);

  step("support: a minimum supported version and deadline come back with the offer");
  const deadline = "2026-12-01T00:00:00.000Z";
  const setSupport = await call("PATCH", `/api/admin/release-support/stable/${platform}`, { minSupportedVersion: "0.1.183", mandateDeadline: deadline }, asAdmin);
  assert.equal(setSupport.status, 200, JSON.stringify(setSupport.body));
  const below = await offered("dev_0001", "0.1.150");
  assert.deepEqual([below.requiredVersion, below.requiredReason, below.mandateDeadline, below.force], ["0.1.183", "below_minimum", deadline, true]);
  const atFloor = await offered("dev_0001", "0.1.183");
  assert.equal(atFloor.requiredVersion, "", "a client at the floor owes nothing");
  assert.equal((await call("PATCH", `/api/admin/release-support/stable/${platform}`, { minSupportedVersion: "not-a-version" }, asAdmin)).body.code, "RELEASE_SUPPORT_INVALID");

  step("block: a bad version is offered to no one; clients on it move once something newer exists");
  assert.equal((await call("PATCH", `/api/admin/release-support/stable/${platform}`, { blockedVersions: ["0.1.184"] }, asAdmin)).status, 200);
  assert.equal(await share("0.1.184"), 0, "the blocked full version is withdrawn");
  assert.equal((await offered("")).version, "0.1.183", "everyone falls back to the previous full version");
  const onBlocked = await offered("dev_0001", "0.1.184");
  assert.equal(onBlocked.requiredVersion, "", "no newer build yet: the block forces no downgrade");
  const fix = await call("POST", "/api/admin/releases", release("0.1.187", { immutableFeed: true, rolloutPercent: 100 }), asAdmin);
  assert.equal(fix.status, 201, JSON.stringify(fix.body));
  const moved = await offered("dev_0001", "0.1.184");
  assert.deepEqual([moved.version, moved.requiredVersion, moved.requiredReason], ["0.1.187", "0.1.187", "blocked"]);

  step("the row shortcut sets the same support policy, one concept one place");
  const fixRow = (await pool.query("select id from releases where version='0.1.187'")).rows[0].id;
  assert.equal((await call("PATCH", `/api/admin/releases/${fixRow}`, { forceUpdate: true }, asAdmin)).status, 200);
  const floorRow = (await pool.query("select min_supported_version, blocked_versions from release_support where channel='stable' and platform=$1", [platform])).rows[0];
  assert.equal(floorRow.min_supported_version, "0.1.187");
  assert.deepEqual(floorRow.blocked_versions, ["0.1.184"], "setting the floor leaves the block alone");
  assert.equal(Number((await pool.query("select count(*)::int n from releases where force_update")).rows[0].n), 0, "no row-level flag is written");
  await call("PATCH", `/api/admin/releases/${fixRow}`, { forceUpdate: false }, asAdmin);
  assert.equal((await pool.query("select min_supported_version from release_support where channel='stable' and platform=$1", [platform])).rows[0].min_supported_version, null);

  step("beta: a device a rule puts on beta sees beta releases; everyone else does not");
  await pool.query("insert into devices (id, platform, arch, app_version) values ('dev_beta_1', 'darwin', 'arm64', '0.1.187')");
  const rule = await call("POST", "/api/admin/config-profiles", { id: "beta-tester", name: "beta tester", scope: "device", targetId: "dev_beta_1", priority: 0, rolloutPercent: 100, enabled: true, config: { policy: { updateChannel: "beta" } } }, asAdmin);
  assert.equal(rule.status, 201, JSON.stringify(rule.body));
  const beta = await call("POST", "/api/admin/releases", release("0.1.190", { immutableFeed: true, channel: "beta" }), asAdmin);
  assert.equal(beta.status, 201, JSON.stringify(beta.body));
  assert.equal(beta.body.rolloutState, "complete", "beta is opt-in: a beta release goes to all of beta");
  const betaOffer = await offered("dev_beta_1", "0.1.187");
  assert.deepEqual([betaOffer.version, betaOffer.channel], ["0.1.190", "beta"]);
  assert.equal(await share("0.1.190"), 0, "no stable device sees it");
  assert.equal((await offered("")).version, "0.1.187", "nor the download page");

  step("update funnel: signed device reports, one row per stage, shown on the rollout");
  const { stableStringify, sha256 } = await import("../src/services/security.js");
  const key = crypto.generateKeyPairSync("ed25519");
  await pool.query("insert into devices (id, platform, arch, app_version) values ('dev_funnel_1', 'darwin', 'arm64', '0.1.187')");
  await pool.query("insert into device_public_keys (device_id, public_key) values ($1, $2)", ["dev_funnel_1", key.publicKey.export({ type: "spki", format: "pem" })]);
  const signed = (pathname, body) => {
    const timestamp = new Date().toISOString(), nonce = crypto.randomUUID(), bodyHash = sha256(stableStringify(body));
    const signature = crypto.sign(null, Buffer.from(stableStringify({ method: "POST", pathname, timestamp, nonce, bodyHash })), key.privateKey).toString("base64url");
    return { "x-lily-device-id": "dev_funnel_1", "x-lily-timestamp": timestamp, "x-lily-nonce": nonce, "x-lily-body-sha256": bodyHash, "x-lily-signature": signature };
  };
  const unsigned = await call("POST", "/api/updates/events", { deviceId: "dev_funnel_1", platform: "darwin", arch: "arm64", appVersion: "0.1.187", toVersion: "0.1.191", stage: "downloaded" });
  assert.equal(unsigned.status, 401, "an unsigned report is refused");
  const staged2 = await call("POST", "/api/admin/releases", release("0.1.191", { immutableFeed: true, rolloutPercent: 20 }), asAdmin);
  assert.equal(staged2.status, 201, JSON.stringify(staged2.body));
  for (const stage of ["download_started", "downloaded", "downloaded"]) {
    const body = { deviceId: "dev_funnel_1", platform: "darwin", arch: "arm64", appVersion: "0.1.187", toVersion: "0.1.191", stage };
    const res = await call("POST", "/api/updates/events", body, signed("/api/updates/events", body));
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  const funnelCard = (await call("GET", "/api/admin/rollouts", undefined, asAdmin)).body.platforms.find((p) => p.platform === platform).active;
  assert.deepEqual([funnelCard.version, funnelCard.funnel], ["0.1.191", { download_started: 1, downloaded: 1 }], "a repeat is not a second device");

  step("health guard: off flags a worse version; on pauses it, and the pause is audited");
  const seedVersion = async (version, count, errors) => {
    for (let i = 0; i < count; i += 1) {
      const id = `dev_h_${version}_${i}`;
      await pool.query("insert into devices (id, platform, arch, app_version, last_seen_at) values ($1, 'darwin', 'arm64', $2, now()) on conflict do nothing", [id, version]);
      if (i < errors) await pool.query("insert into runtime_diagnostics (id, device_id, platform, arch, app_version, severity, normalized_kind, created_at) values ($1, $2, 'darwin', 'arm64', $3, 'error', 'MODEL_NO_RESPONSE', now())", [`diag_${id}`, id, version]);
    }
  };
  await seedVersion("0.1.187", 30, 3);   // baseline: 0.1 errors per device
  await seedVersion("0.1.191", 25, 10);  // candidate: 0.4 errors per device
  const { runRolloutGuard } = await import("../src/services/rollout-guard.js");
  const offRun = await runRolloutGuard();
  assert.equal(offRun.decisions.find((d) => d.rollout.version === "0.1.191").judgement.verdict, "worse");
  assert.equal((await pool.query("select state from release_rollouts where id=$1", [staged2.body.rolloutId])).rows[0].state, "rolling", "off by default: flagged, not paused");
  const attention = await call("GET", "/api/admin/attention", undefined, asAdmin);
  assert.ok(attention.body.attention.items.some((item) => item.kind === "rolloutUnhealthy"), "the dashboard says so");
  assert.equal((await call("PATCH", "/api/admin/release-settings/auto-pause", { enabled: true, minDevices: 20, worseRatio: 1.5 }, asAdmin)).status, 200);
  await runRolloutGuard();
  assert.equal((await pool.query("select state from release_rollouts where id=$1", [staged2.body.rolloutId])).rows[0].state, "paused");
  const pauseAudit = (await pool.query("select actor from audit_logs where action='rollout.auto_pause' and target_id=$1", [staged2.body.rolloutId])).rows;
  assert.deepEqual(pauseAudit.map((r) => r.actor), ["rollout-guard"]);
  await runRolloutGuard();
  assert.equal((await pool.query("select count(*)::int n from audit_logs where action='rollout.auto_pause'")).rows[0].n, 1, "a paused rollout is not paused twice");

  step("every move is audited");
  const actions = (await pool.query("select action from audit_logs where target_id=$1 order by id", [rolloutId])).rows.map((r) => r.action);
  assert.deepEqual(actions, ["rollout.raise", "rollout.halt", "rollout.reopen", "rollout.resume", "rollout.complete"]);
  const creation = (await pool.query("select metadata from audit_logs where action='release.create' and target_id=$1", [staged.body.id])).rows[0].metadata;
  assert.equal((typeof creation === "string" ? JSON.parse(creation) : creation).rollout.percent, 10, "the release audit records how it started");

  console.log("release rollouts integration: ok");
} finally {
  try { await cdn.close(); } catch { /* ignore */ }
  try { await app?.close(); } catch { /* ignore */ }
  try { await closeDb?.(); } catch { try { await pool?.end(); } catch { /* ignore */ } }
  try { await control.query(`drop schema if exists ${schema} cascade`); } catch { /* ignore */ }
  await control.end();
  process.chdir(cwd);
  fs.rmSync(temp, { recursive: true, force: true });
}
