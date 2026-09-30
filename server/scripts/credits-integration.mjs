#!/usr/bin/env node
// Lily credits end to end on a real database: migration 065 converts old token
// balances and their history by value exactly once, and a real model-gateway
// request is charged in credits at that model's rate from the usage the
// provider reports (cached input, fresh input, output) — a reservation first,
// the rest when the answer completes. [gate: lily-credits]
// Skips without DATABASE_URL. Throwaway schema.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import pg from "pg";

if (!process.env.DATABASE_URL) { console.log("credits integration: skipped (DATABASE_URL not configured)"); process.exit(0); }

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = `credits_${crypto.randomUUID().replaceAll("-", "")}`;
const control = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const scoped = new URL(process.env.DATABASE_URL);
scoped.searchParams.set("options", `-c search_path=${schema}`);
const cwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "credits-"));
process.chdir(temp);

// A provider that answers with a cache split, DeepSeek-style.
let reply = { prompt_tokens: 50000, completion_tokens: 1000, prompt_cache_hit_tokens: 40000 };
const upstream = Fastify({ logger: false });
upstream.post("/v1/chat/completions", async () => ({ id: "c", object: "chat.completion", model: "deepseek-v4-pro",
  choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: reply }));
const upstreamUrl = await upstream.listen({ host: "127.0.0.1", port: 0 });
Object.assign(process.env, {
  DATABASE_URL: scoped.href, NODE_ENV: "test", ACCOUNT_USAGE_ENFORCEMENT: "true", MODEL_GATEWAY_ENABLED: "true",
  SESSION_SECRET: crypto.randomBytes(32).toString("hex"), ADMIN_TOKEN: crypto.randomBytes(24).toString("hex"),
  MODEL_GATEWAY_PROVIDERS: JSON.stringify({ "credit-test": { type: "openai", baseUrl: `${upstreamUrl}/v1`, apiKey: "fixture", model: "deepseek-v4-pro" } }),
});
const step = (label) => console.log(`  · ${label}`);
let app, pool, closeDb;
try {
  await control.query(`create schema ${schema}`);
  const migrate = spawnSync(process.execPath, [path.join(here, "migrate.mjs")], { env: { ...process.env }, encoding: "utf8", cwd: path.resolve(here, "..") });
  assert.equal(migrate.status, 0, migrate.stderr || migrate.stdout);
  assert.match(migrate.stdout, /065_credits\.sql/);
  const dbMod = await import("../src/db.js");
  ({ pool, closeDb } = dbMod);
  const one = async (q, p) => (await pool.query(q, p)).rows[0];

  step("065 converts old token balances and their history by value, once");
  await pool.query("delete from app_settings where key='credits_converted'");
  await pool.query("insert into users(id, phone_e164) values('usr_old', '+8613800000011')");
  await pool.query(`insert into wallet_grants(id,user_id,source_type,source_id,grant_type,resource_type,token_total,token_remaining,unit_total,unit_remaining,starts_at,expires_at,status,metadata)
    values('g_old','usr_old','free_signup','usr_old','free_tokens','token',100000,62500,100000,62500,now()-interval '1 day',now()+interval '6 days','active','{}')`);
  await pool.query("insert into wallet_ledger(id,user_id,grant_id,event_type,resource_type,token_delta,unit_delta) values('l_old','usr_old','g_old','consume','token',-37500,-37500)");
  await pool.query("insert into usage_events(id,user_id,feature,spec_key,resource_type,billable_units,billable_tokens,unit_cost,status) values('u_old','usr_old','chat_model','deepseek-flash','token',37500,37500,1,'completed')");
  await pool.query("insert into organizations(id,name,status) values('org_c','C','active')");
  await pool.query("insert into organization_members(organization_id,user_id,role,status,weekly_budget,weekly_used,quota) values('org_c','usr_old','owner','active',3000000,1250000,500000)");
  const sqlText = fs.readFileSync(path.resolve(here, "../migrations/065_credits.sql"), "utf8");
  await pool.query(sqlText);
  assert.deepEqual(await one("select unit_total, unit_remaining, token_remaining from wallet_grants where id='g_old'"), { unit_total: 160, unit_remaining: 100, token_remaining: 100 });
  assert.equal(Number((await one("select metadata->>'legacyTokenRemaining' v from wallet_grants where id='g_old'")).v), 62500, "the old amount is kept for the record");
  const topup = await one("select unit_total, expires_at > now() + interval '29 days' as month from wallet_grants where user_id='usr_old' and source_type='credit_conversion'");
  assert.deepEqual(topup, { unit_total: 1900, month: true }, "a 100-credit balance is topped up to the 2,000 signup gift");
  assert.equal((await one("select unit_delta from wallet_ledger where id='l_old'")).unit_delta, -60);
  assert.deepEqual(await one("select billable_units, billable_tokens from usage_events where id='u_old'"), { billable_units: 60, billable_tokens: 37500 }, "raw tokens stay raw");
  assert.deepEqual(await one("select weekly_budget::int w, weekly_used::int u, quota from organization_members where user_id='usr_old'"), { w: 4800, u: 2000, quota: 800 });
  await pool.query(sqlText);
  assert.equal((await one("select unit_remaining from wallet_grants where id='g_old'")).unit_remaining, 100, "a second run converts nothing");
  assert.equal((await one("select count(*)::int n from wallet_grants where user_id='usr_old' and source_type='credit_conversion'")).n, 1, "and tops up nothing twice");
  assert.equal((await one("select count(*)::int n from feature_pricing_rules where id like 'credit_%'")).n, 4);

  step("a real gateway request is charged in credits at the model's rate");
  const [{ adminRoutes }, { publicRoutes }, { installDocOnlyCompilers }] = await Promise.all([import("../src/routes/admin.js"), import("../src/routes/public.js"), import("../src/openapi.js")]);
  app = Fastify({ logger: false });
  installDocOnlyCompilers(app);
  await app.register((await import("@fastify/cookie")).default);
  await app.register(adminRoutes); await app.register(publicRoutes);
  await app.register((await import("../src/services/model-gateway.js")).modelGatewayRoutes);
  const { signModelGatewayToken } = await import("../src/services/model-gateway/auth.js");
  await pool.query("insert into devices(id, platform) values('dev_c','darwin')");
  await pool.query("insert into users(id, phone_e164) values('usr_new', '+8613800000012')");
  await pool.query("insert into user_sessions(id,user_id,refresh_token_hash,device_id,expires_at) values('s_new','usr_new','h','dev_c',now()+interval '1 day')");
  await pool.query(`insert into wallet_grants(id,user_id,source_type,source_id,grant_type,resource_type,token_total,token_remaining,unit_total,unit_remaining,starts_at,expires_at,status,metadata)
    values('g_new','usr_new','order','o','paid_tokens','token',10000,10000,10000,10000,now()-interval '1 day',now()+interval '30 days','active','{}')`);
  const token = signModelGatewayToken({ userId: "usr_new", sessionId: "s_new", deviceId: "" });
  const call = (model) => app.inject({ method: "POST", url: "/llm/credit-test/v1/chat/completions",
    headers: { authorization: `Bearer ${token}`, "x-lily-idempotency-key": crypto.randomUUID() },
    payload: { model, stream: false, messages: [{ role: "user", content: "x".repeat(4000) }] } });
  const remaining = async () => Number((await one("select unit_remaining from wallet_grants where id='g_new'")).unit_remaining);
  let res = await call("deepseek-v4-pro");
  assert.equal(res.statusCode, 200, `${res.statusCode} ${res.body}`);
  await new Promise((r) => setTimeout(r, 200));
  const proCharge = 10000 - await remaining();
  assert.equal(proCharge, Math.ceil((40000 * 450 + 10000 * 13000 + 1000 * 39000) / 1e6), `pro turn charged ${proCharge}`);
  const events = (await pool.query("select billable_units, billable_tokens, metadata->>'phase' phase from usage_events where user_id='usr_new' order by created_at")).rows;
  assert.deepEqual(events.map((e) => e.phase), ["input_estimate", "usage_reconcile"]);
  assert.equal(events.reduce((sum, e) => sum + Number(e.billable_tokens), 0), 51000, "the raw tokens of the request add up");
  const before = await remaining();
  res = await call("deepseek-v4-flash");
  if (res.statusCode !== 200) console.log("GATEWAY2", res.statusCode, res.body);
  assert.equal(res.statusCode, 200);
  await new Promise((r) => setTimeout(r, 200));
  const flashCharge = before - await remaining();
  assert.equal(flashCharge, Math.ceil((40000 * 60 + 10000 * 2900 + 1000 * 11500) / 1e6));
  assert.ok(proCharge > 4 * flashCharge, "different models consume credits at different speeds");
  const unknownBefore = await remaining();
  res = await call("some-new-model");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(unknownBefore - await remaining(), proCharge, "a model without a rate is charged at the most expensive rate");

  step("the signup gift is in credits");
  const { createSignupGrants } = await import("../src/services/wallet.js");
  const { config } = await import("../src/config.js");
  assert.equal(config.accountFreeTokens, 2000);
  assert.equal(createSignupGrants({ userId: "x", freeTokens: config.accountFreeTokens })[0].unit_total, 2000);

  console.log("credits integration: ok");
} finally {
  try { await upstream.close(); } catch { /* ignore */ }
  try { await app?.close(); } catch { /* ignore */ }
  try { await closeDb?.(); } catch { try { await pool?.end(); } catch { /* ignore */ } }
  try { await control.query(`drop schema if exists ${schema} cascade`); } catch { /* ignore */ }
  await control.end();
  process.chdir(cwd);
  fs.rmSync(temp, { recursive: true, force: true });
}
