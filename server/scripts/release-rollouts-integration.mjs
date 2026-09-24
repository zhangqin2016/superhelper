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
