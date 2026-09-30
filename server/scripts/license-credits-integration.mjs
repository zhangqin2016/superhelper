#!/usr/bin/env node
// Licence codes join the credit pricing, end to end on a real database and the
// real model gateway (2026-09-30): historical licences move to the highest plan;
// a licence's weekly pool is credits-per-seat × devices in use (capped by seats,
// so 99999 typed seats is not a bottomless pool); licensed devices spend it
// first, then the signed-in account; a device with no account waits for the
// reset; the pool reopens every week; our own failure never blocks a licence.
// [gate: license-credits]  Skips without DATABASE_URL. Throwaway schema.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import pg from "pg";

if (!process.env.DATABASE_URL) { console.log("license credits integration: skipped (DATABASE_URL not configured)"); process.exit(0); }

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = `lic_${crypto.randomUUID().replaceAll("-", "")}`;
const control = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const scoped = new URL(process.env.DATABASE_URL);
scoped.searchParams.set("options", `-c search_path=${schema}`);
const cwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lic-"));
process.chdir(temp);
const upstream = Fastify({ logger: false });
upstream.post("/v1/chat/completions", async () => ({ id: "c", object: "chat.completion", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 50000, completion_tokens: 1000, prompt_cache_hit_tokens: 40000 } }));
const upstreamUrl = await upstream.listen({ host: "127.0.0.1", port: 0 });
Object.assign(process.env, {
  DATABASE_URL: scoped.href, NODE_ENV: "test", ACCOUNT_USAGE_ENFORCEMENT: "true", MODEL_GATEWAY_ENABLED: "true",
  SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
  MODEL_GATEWAY_PROVIDERS: JSON.stringify({ "lic-test": { type: "openai", baseUrl: `${upstreamUrl}/v1`, apiKey: "fixture", model: "deepseek-v4-pro" } }),
});
const step = (label) => console.log(`  · ${label}`);
let app, pool, closeDb;
try {
  await control.query(`create schema ${schema}`);
  const migrate = spawnSync(process.execPath, [path.join(here, "migrate.mjs")], { env: { ...process.env }, encoding: "utf8", cwd: path.resolve(here, "..") });
  assert.equal(migrate.status, 0, migrate.stderr || migrate.stdout);
  const dbMod = await import("../src/db.js");
  ({ pool, closeDb } = dbMod);
  const one = async (q, p) => (await pool.query(q, p)).rows[0];

  step("historical licences move to the highest plan; the old label is kept");
  await pool.query(`insert into licenses(id,license_key_hash,customer_name,plan,seats,expires_at,status) values
    ('lic_big','h1','vvvip','pro',99999,now()+interval '1 year','active'),
    ('lic_team','h2','team co','team',5,now()+interval '1 year','active')`);
  await pool.query("update licenses set legacy_plan=null");
  await pool.query(fs.readFileSync(path.resolve(here, "../migrations/066_license_credits.sql"), "utf8"));
  assert.deepEqual((await pool.query("select id, plan, legacy_plan from licenses order by id")).rows,
    [{ id: "lic_big", plan: "premium", legacy_plan: "pro" }, { id: "lic_team", plan: "premium", legacy_plan: "team" }]);

  step("the pool is credits per seat × devices in use, not the typed seat count");
  await pool.query("insert into devices(id, platform) values('d1','darwin'),('d2','win32'),('d3','darwin')");
  await pool.query("insert into license_devices(id,license_id,device_id,status) values('ld1','lic_big','d1','active'),('ld2','lic_big','d2','active')");
  const { licenseWeekStatus } = await import("../src/services/license-credits.js");
  const lic = await one("select * from licenses where id='lic_big'");
  const status = await licenseWeekStatus(dbMod.db, lic);
  assert.deepEqual([status.seatsInUse, status.perSeat, status.total], [2, 28000, 56000]);

  const [{ modelGatewayRoutes }] = await Promise.all([import("../src/services/model-gateway.js")]);
  app = Fastify({ logger: false });
  await app.register(modelGatewayRoutes);
  const { signModelGatewayToken } = await import("../src/services/model-gateway/auth.js");
  const call = (token, key = crypto.randomUUID()) => app.inject({ method: "POST", url: "/llm/lic-test/v1/chat/completions",
    headers: { authorization: `Bearer ${token}`, "x-lily-idempotency-key": key },
    payload: { model: "deepseek-v4-pro", stream: false, messages: [{ role: "user", content: "x".repeat(4000) }] } });
  const deviceOnly = signModelGatewayToken({ licenseId: "lic_big", deviceId: "d1" });
  const turn = Math.ceil((40000 * 450 + 10000 * 13000 + 1000 * 39000) / 1e6);

  step("a licensed device spends the licence's pool, in credits");
  let res = await call(deviceOnly);
  assert.equal(res.statusCode, 200, res.body);
  await new Promise((r) => setTimeout(r, 200));
  let week = await one("select credits_used::int u, credits_total::int t from license_credit_weeks where license_id='lic_big'");
  assert.deepEqual(week, { u: turn, t: 56000 });
  assert.equal((await one("select count(*)::int n from usage_events where license_id='lic_big' and metadata->>'paidBy'='license'")).n, 2, "reserve + settle, recorded");

  step("used up: a device with no account waits for the reset, told when");
  await pool.query("update license_credit_weeks set credits_used=credits_total where license_id='lic_big'");
  res = await call(deviceOnly);
  assert.equal(res.statusCode, 402);
  const err = res.json().error;
  assert.equal(err.message, "LICENSE_WEEKLY_LIMIT"); assert.ok(err.resetsAt && err.weeklyBudget === 56000);

  step("used up: a signed-in account pays from its own credits");
  await pool.query("insert into users(id, phone_e164) values('usr_l','+8613800000031')");
  await pool.query("insert into user_sessions(id,user_id,refresh_token_hash,device_id,expires_at) values('s_l','usr_l','h','d1',now()+interval '1 day')");
  await pool.query(`insert into wallet_grants(id,user_id,source_type,source_id,grant_type,resource_type,token_total,token_remaining,unit_total,unit_remaining,starts_at,expires_at,status,metadata)
    values('g_l','usr_l','order','o','paid_tokens','token',5000,5000,5000,5000,now()-interval '1 day',now()+interval '30 days','active','{}')`);
  const withAccount = signModelGatewayToken({ licenseId: "lic_big", userId: "usr_l", sessionId: "s_l", deviceId: "d1" });
  res = await call(withAccount);
  assert.equal(res.statusCode, 200, res.body);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(5000 - Number((await one("select unit_remaining from wallet_grants where id='g_l'")).unit_remaining), turn);

  step("a new week reopens the pool (sized from devices in use then)");
  await pool.query("insert into license_devices(id,license_id,device_id,status) values('ld3','lic_big','d3','active')");
  await pool.query("update licenses set created_at=created_at - interval '8 days' where id='lic_big'");
  res = await call(deviceOnly);
  assert.equal(res.statusCode, 200);
  await new Promise((r) => setTimeout(r, 200));
  week = await one("select credits_total::int t, seats_in_use s from license_credit_weeks where license_id='lic_big' order by week_index desc limit 1");
  assert.deepEqual(week, { t: 84000, s: 3 });

  step("our own failure never blocks a paying licence");
  await pool.query("alter table license_credit_weeks rename to license_credit_weeks_off");
  res = await call(deviceOnly);
  assert.equal(res.statusCode, 200, "fail open");
  await pool.query("alter table license_credit_weeks_off rename to license_credit_weeks");
  await pool.query("alter table feature_pricing_rules rename to feature_pricing_rules_off");
  res = await call(deviceOnly);
  assert.equal(res.statusCode, 200, "fail open when the price lookup itself fails");
  await pool.query("alter table feature_pricing_rules_off rename to feature_pricing_rules");

  step("the unlimited plan is never refused for credits, and still metered");
  await pool.query("update licenses set plan='unlimited' where id='lic_big'");
  await pool.query("update license_credit_weeks set credits_used = credits_total * 5 where license_id='lic_big'");
  res = await call(deviceOnly);
  assert.equal(res.statusCode, 200, "no weekly limit");
  await new Promise((r) => setTimeout(r, 200));
  const after = await one("select credits_used::bigint u, credits_total::bigint t from license_credit_weeks where license_id='lic_big' order by week_index desc limit 1");
  assert.equal(Number(after.u), Number(after.t) * 5 + turn, "the usage is still recorded");
  const unl = await licenseWeekStatus(dbMod.db, await one("select * from licenses where id='lic_big'"));
  assert.deepEqual([unl.unlimited, unl.total, unl.remaining], [true, null, null]);
  console.log("license credits integration: ok");
} finally {
  try { await upstream.close(); } catch { /* ignore */ }
  try { await app?.close(); } catch { /* ignore */ }
  try { await closeDb?.(); } catch { try { await pool?.end(); } catch { /* ignore */ } }
  try { await control.query(`drop schema if exists ${schema} cascade`); } catch { /* ignore */ }
  await control.end();
  process.chdir(cwd);
  fs.rmSync(temp, { recursive: true, force: true });
}
