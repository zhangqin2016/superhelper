#!/usr/bin/env node
// Personal plans (Pro / Max) as a closed loop on a real database, through the
// real fulfilment and refund paths of the payment settlement:
//
//   paid Max order → a plan period (ledger carries the money, no credit) →
//   this week's allowance handed out once, whoever asks first, even racing →
//   charged before older credit → a new week starts fresh (no carry-over) →
//   renewal continues the period → a 0-allowance plan hands out nothing →
//   BYOK: open by default, plan/enterprise-only when the operator turns it on →
//   a full refund ends the plan and the week it handed out.
//
// Skips without DATABASE_URL. Throwaway schema.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

if (!process.env.DATABASE_URL) { console.log("plans integration: skipped (DATABASE_URL not configured)"); process.exit(0); }

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = `plans_${crypto.randomUUID().replaceAll("-", "")}`;
const control = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const scoped = new URL(process.env.DATABASE_URL);
scoped.searchParams.set("options", `-c search_path=${schema}`);
const cwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "plans-"));
process.chdir(temp);
Object.assign(process.env, { DATABASE_URL: scoped.href, NODE_ENV: "test", SESSION_SECRET: crypto.randomBytes(32).toString("hex") });

const step = (label) => console.log(`  · ${label}`);
let closeDb, pool;
try {
  await control.query(`create schema ${schema}`);
  const migrate = spawnSync(process.execPath, [path.join(here, "migrate.mjs")], { env: { ...process.env }, encoding: "utf8", cwd: path.resolve(here, "..") });
  assert.equal(migrate.status, 0, migrate.stderr || migrate.stdout);
  const dbMod = await import("../src/db.js");
  ({ pool, closeDb } = dbMod);
  const db = dbMod.db;
  const wallet = await import("../src/services/wallet.js");
  const { createSettlement } = await import("../src/services/payments/settlement.js");
  let clock = new Date();
  const settlement = createSettlement({ db, gatewayFor: () => ({}), now: () => clock, log: { warn() {}, info() {} } });
  const one = async (q, p) => (await pool.query(q, p)).rows[0];
  const WEEK = 7 * 24 * 3600 * 1000;

  await pool.query(`insert into products(id,kind,name,price_cents,currency,resource_type,unit_amount,duration_seconds,metadata,status,sort_order) values
    ('max_month','subscription','Lily Max 月付',9900,'CNY','plan',22000,2592000,'{"plan":"max","period":"month"}','active',1),
    ('pro_month','subscription','Lily Pro 月付',4900,'CNY','plan',0,2592000,'{"plan":"pro","period":"month"}','active',2)`);
  const user = async (id) => { await pool.query("insert into users(id, phone_e164) values($1, $2)", [id, `+861380000${Math.floor(Math.random() * 9000 + 1000)}`]); return id; };
  const pay = async (userId, productId, cents) => {
    const orderId = `ord_${crypto.randomUUID().slice(0, 8)}`;
    await pool.query("insert into orders(id,user_id,product_id,provider,amount_cents,status) values($1,$2,$3,'alipay',$4,'pending')", [orderId, userId, productId, cents]);
    const order = await one("select * from orders where id=$1", [orderId]);
    await db.transaction().execute((trx) => settlement.fulfil(trx, order, { paymentId: null, provider: "alipay" }));
    return orderId;
  };
  const summary = (id) => wallet.fetchEntitlementSummary(id);
  const charge = (id, units, model = "deepseek-v4-flash") => wallet.consumeEntitlement({ userId: id, feature: "chat_model", model, resourceType: "token", units, idempotencyKey: crypto.randomUUID() });

  step("a paid Max order opens a plan period; the ledger carries the money, not credit");
  const buyer = await user("usr_max");
  const firstOrder = await pay(buyer, "max_month", 9900);
  const plan = await one("select * from wallet_grants where source_type='order' and source_id=$1", [firstOrder]);
  assert.equal(plan.resource_type, "plan"); assert.equal(plan.metadata.plan, "max"); assert.equal(Number(plan.unit_total), 22000);
  const planLedger = await one("select unit_delta, money_delta_cents from wallet_ledger where grant_id=$1", [plan.id]);
  assert.deepEqual([Number(planLedger.unit_delta), Number(planLedger.money_delta_cents)], [0, 9900]);

  step("this week's allowance is handed out once, whoever asks first — even racing");
  const [a, b, c] = await Promise.all([summary(buyer), summary(buyer), summary(buyer)]);
  assert.equal((await one("select count(*)::int n from wallet_grants where grant_type='plan_weekly' and user_id=$1", [buyer])).n, 1);
  for (const s of [a, b, c]) { assert.equal(s.plan.tier, "max"); assert.equal(s.plan.weekRemaining, 22000); }
  assert.equal(a.tokenBalance, 22000, "the balance a client reads includes the week");
  assert.equal(a.extraTokenBalance, 0, "extra credits exclude the plan's week");
  assert.ok(Math.abs(new Date(a.plan.weekResetsAt) - (new Date(plan.starts_at).getTime() + WEEK)) < 1000);

  step("the week is spent before longer-lived credit");
  await pool.query(`insert into wallet_grants(id,user_id,source_type,source_id,grant_type,resource_type,token_total,token_remaining,unit_total,unit_remaining,starts_at,expires_at,status,metadata)
    values('g_pack',$1,'order','x','paid_tokens','token',50000,50000,50000,50000,now()-interval '1 day',now()+interval '300 days','active','{}')`, [buyer]);
  // Credits per request come from the model's rate (credit-pricing.js); here the
  // charges are given in credits directly.
  assert.equal((await charge(buyer, 4000)).ok, true);
  assert.equal((await charge(buyer, 6000, "deepseek-v4-pro")).ok, true);
  let s1 = await summary(buyer);
  assert.equal(s1.plan.weekRemaining, 22000 - 10000);
  assert.equal(Number((await one("select unit_remaining from wallet_grants where id='g_pack'")).unit_remaining), 50000, "the pack is untouched while the week lasts");

  step("a new week starts fresh — what was left does not carry over");
  await pool.query("update wallet_grants set starts_at=starts_at - interval '8 days', expires_at=expires_at - interval '8 days' where id=$1", [plan.id]);
  await pool.query("update wallet_grants set starts_at=starts_at - interval '8 days', expires_at=expires_at - interval '8 days' where grant_type='plan_weekly' and user_id=$1", [buyer]);
  const s2 = await summary(buyer);
  assert.equal(s2.plan.weekRemaining, 22000);
  assert.equal(s2.tokenBalance, 22000 + 50000, "last week's 12,000 leftover expired; the pack remains");
  assert.equal(s2.extraTokenBalance, 50000, "the usage page shows the pack as extra credits");
  assert.equal((await one("select count(*)::int n from wallet_grants where grant_type='plan_weekly' and user_id=$1", [buyer])).n, 2);

  step("renewing continues the period instead of overlapping it");
  const before = new Date((await one("select expires_at from wallet_grants where id=$1", [plan.id])).expires_at).getTime();
  const renewal = await pay(buyer, "max_month", 9900);
  const renewed = await one("select * from wallet_grants where source_type='order' and source_id=$1", [renewal]);
  assert.equal(new Date(renewed.starts_at).getTime(), before, "starts where the current period ends");
  assert.equal(new Date((await summary(buyer)).plan.expiresAt).getTime(), before + 2592000 * 1000);

  step("a plan whose weekly allowance is 0 hands out nothing (the tier still counts)");
  const pro = await user("usr_pro");
  await pay(pro, "pro_month", 4900);
  const sp = await summary(pro);
  assert.equal(sp.plan.tier, "pro"); assert.equal(sp.plan.weekRemaining, undefined);
  assert.equal((await one("select count(*)::int n from wallet_grants where grant_type='plan_weekly' and user_id=$1", [pro])).n, 0);

  step("own model keys: open by default; plan or enterprise only when the operator turns it on");
  const free = await user("usr_free");
  assert.equal((await summary(free)).byokAllowed, true, "off by default — nobody loses their keys");
  await pool.query("insert into app_settings(key,value) values('byok_requires_plan','true'::jsonb)");
  assert.equal((await summary(free)).byokAllowed, false);
  assert.equal((await summary(free)).byokReason, "plan_required");
  assert.equal((await summary(pro)).byokAllowed, true);
  assert.equal((await summary(buyer)).byokAllowed, true);
  await pool.query("insert into organizations(id,name,status) values('org_x','X','active')");
  await pool.query("insert into organization_members(organization_id,user_id,role,status) values('org_x',$1,'member','active')", [free]);
  assert.equal((await summary(free)).byokReason, "organization");

  step("a full refund ends the plan and the week it handed out");
  const payId = `pay_${crypto.randomUUID().slice(0, 8)}`;
  await pool.query("insert into payments(id,order_id,user_id,provider,method,amount_cents,status) values($1,$2,$3,'alipay','page',4900,'succeeded')", [payId, (await one("select id from orders where user_id=$1", [pro])).id, pro]);
  const proOrder = await one("select * from orders where user_id=$1", [pro]);
  await pool.query("update orders set payment_id=$1 where id=$2", [payId, proOrder.id]);
  await pool.query("insert into refunds(id,order_id,payment_id,user_id,amount_cents,status) values('rfd_1',$1,$2,$3,4900,'pending')", [proOrder.id, payId, pro]);
  await settlement.applyRefund("rfd_1", "R1");
  assert.equal((await summary(pro)).plan, null);
  const maxOrder = await one("select * from orders where id=$1", [firstOrder]);
  const pay2 = `pay_${crypto.randomUUID().slice(0, 8)}`;
  await pool.query("insert into payments(id,order_id,user_id,provider,method,amount_cents,status) values($1,$2,$3,'alipay','page',9900,'succeeded')", [pay2, maxOrder.id, buyer]);
  await pool.query("update orders set payment_id=$1 where id=$2", [pay2, maxOrder.id]);
  await pool.query("insert into refunds(id,order_id,payment_id,user_id,amount_cents,status) values('rfd_2',$1,$2,$3,9900,'pending')", [maxOrder.id, pay2, buyer]);
  await settlement.applyRefund("rfd_2", "R2");
  const weeks = (await pool.query("select status from wallet_grants where source_type='plan' and source_id=$1", [plan.id])).rows.map((r) => r.status);
  assert.ok(weeks.length >= 1 && weeks.every((st) => st === "revoked" || st === "active") && weeks.includes("revoked"), JSON.stringify(weeks));
  assert.equal((await summary(buyer)).plan.tier, "max", "the renewal period (not refunded) still stands");

  console.log("plans integration: ok");
} finally {
  try { await closeDb?.(); } catch { try { await pool?.end(); } catch { /* ignore */ } }
  try { await control.query(`drop schema if exists ${schema} cascade`); } catch { /* ignore */ }
  await control.end();
  process.chdir(cwd);
  fs.rmSync(temp, { recursive: true, force: true });
}
