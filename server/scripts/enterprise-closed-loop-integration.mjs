#!/usr/bin/env node
// The enterprise back office as a closed loop (2026-09-30): real Postgres, the
// REAL migrations, the real routes. Each step drives an action the way a page
// does and then reads back what the other side would see.
//
//   migration 064 backfill (legacy disabled org → platform freeze, audited org →
//     source=platform, typed phones normalised) · self-serve creation closed ·
//   two-layer switch (owner cannot lift a platform freeze; admin cannot pause) ·
//   the identity chosen pays (org pool only / personal only) · weekly member
//   budget with reset · pool shortage named as the pool's · admin peer guard ·
//   invitations normalised + deferred seat granted on re-enable · owner transfer,
//   leave, last-owner guard · removed issued account listed and restorable ·
//   idempotent platform grant + reduce/revoke · no org quota in personal views ·
//   audit trail on both sides · admin search from a person to their org.
//
// Skips cleanly without DATABASE_URL. Throwaway schema, dropped on the way out.

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

if (!process.env.DATABASE_URL) { console.log("enterprise closed loop: skipped (DATABASE_URL not configured)"); process.exit(0); }

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = `enterprise_loop_${crypto.randomUUID().replaceAll("-", "")}`;
const control = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const scoped = new URL(process.env.DATABASE_URL);
scoped.searchParams.set("options", `-c search_path=${schema}`);
scoped.searchParams.set("application_name", schema);

const cwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-loop-"));
process.chdir(temp); // never let dotenv read real operator secrets
const ADMIN_TOKEN = crypto.randomBytes(32).toString("hex");
const upstream = Fastify({ logger: false });
upstream.post("/v1/chat/completions", async () => ({ id: "loop", object: "chat.completion", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
const upstreamUrl = await upstream.listen({ host: "127.0.0.1", port: 0 });
Object.assign(process.env, {
  DATABASE_URL: scoped.href,
  MODEL_GATEWAY_PROVIDERS: JSON.stringify({ "loop-test": { type: "openai", baseUrl: `${upstreamUrl}/v1`, apiKey: "fixture-only", model: "test-model" } }),
  MODEL_GATEWAY_ENABLED: "true",
  ACCOUNT_USAGE_ENFORCEMENT: "true",
  SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
  ADMIN_TOKEN,
  ADMIN_EMAIL: "test-admin@example.invalid",
  ADMIN_PASSWORD: crypto.randomBytes(16).toString("hex"),
  NODE_ENV: "test",
  COLLABORATION_ENABLED: "true",
  COLLABORATION_KILL_SWITCH: "false",
  COLLABORATION_ROLLOUT_ORGANIZATIONS: "",
  COLLAB_MESSAGE_KEK: crypto.randomBytes(32).toString("hex"),
  COLLAB_MESSAGE_KEK_VERSION: "v1",
});

const step = (label) => console.log(`  · ${label}`);
let app, pool, closeDb;
try {
  await control.query(`create schema ${schema}`);

  step("apply the real migrations");
  const migrate = spawnSync(process.execPath, [path.join(here, "migrate.mjs")], { env: { ...process.env, DATABASE_URL: scoped.href }, encoding: "utf8", cwd: path.resolve(here, "..") });
  assert.equal(migrate.status, 0, `migrate failed:\n${migrate.stdout}\n${migrate.stderr}`);
  assert.match(migrate.stdout, /064_enterprise_closed_loop\.sql/);

  const [dbMod, { adminRoutes }, { publicRoutes }, { installDocOnlyCompilers }] = await Promise.all([
    import("../src/db.js"), import("../src/routes/admin.js"), import("../src/routes/public.js"), import("../src/openapi.js"),
  ]);
  ({ pool, closeDb } = dbMod);
  app = Fastify({ logger: false });
  installDocOnlyCompilers(app);
  await app.register(cookie);
  await app.register(adminRoutes);
  await app.register(publicRoutes);
  await app.register((await import("../src/services/model-gateway.js")).modelGatewayRoutes);
  const { createAccessToken } = await import("../src/services/account-auth.js");
  const { signModelGatewayToken } = await import("../src/services/model-gateway/auth.js");
  const { consumeEntitlement } = await import("../src/services/wallet.js");
  const { redeemInvitationsForPhone } = await import("../src/services/enterprise-invitations.js");

  const call = async (method, url, payload, headers = {}) => {
    const res = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }), headers });
    let body = null; try { body = res.json(); } catch { body = res.body; }
    return { status: res.statusCode, body };
  };
  const asAdmin = { authorization: `Bearer ${ADMIN_TOKEN}` };
  await pool.query("insert into devices(id, platform) values('loop-device', 'darwin')");
  const people = new Map();
  const person = async (name, phone) => {
    const id = `usr_${name}_${crypto.randomUUID().slice(0, 8)}`;
    await pool.query("insert into users(id, phone_e164, display_name) values($1,$2,$3)", [id, phone, name]);
    await pool.query("insert into user_sessions(id,user_id,refresh_token_hash,device_id,expires_at) values($1,$2,$3,'loop-device',now()+interval '1 day')", [`s-${id}`, id, crypto.randomUUID()]);
    const p = { id, phone, headers: { authorization: `Bearer ${createAccessToken({ userId: id, sessionId: `s-${id}` })}` },
      gatewayToken: signModelGatewayToken({ userId: id, sessionId: `s-${id}`, deviceId: "" }) };
    people.set(name, p);
    return p;
  };
  const one = async (sqlText, params) => (await pool.query(sqlText, params)).rows[0];

  step("migration 064 backfill: legacy disabled → platform freeze; audited → source=platform; typed phones normalised");
  await pool.query("alter table organizations drop constraint organizations_status_derived_ck");
  await pool.query("insert into organizations(id,name,status) values('org_legacy_off','Legacy Off','disabled'),('org_legacy_sold','Legacy Sold','active')");
  await pool.query("insert into audit_logs(actor,action,target_type,target_id) values('admin','enterprise_org_create','organization','org_legacy_sold')");
  await pool.query(`insert into organization_invitations(id,organization_id,phone_e164,role,status) values
    ('inv_typed','org_legacy_sold','138 0000 1111','member','pending'),('inv_typed_dup','org_legacy_sold','13800001111','member','pending')`);
  await pool.query(fs.readFileSync(path.resolve(here, "../migrations/064_enterprise_closed_loop.sql"), "utf8"));
  assert.deepEqual(await one("select status, owner_status, platform_status from organizations where id='org_legacy_off'"), { status: "disabled", owner_status: "active", platform_status: "suspended" });
  assert.equal((await one("select source from organizations where id='org_legacy_sold'")).source, "platform");
  const typed = (await pool.query("select id, phone_e164, status from organization_invitations where organization_id='org_legacy_sold' order by id")).rows;
  assert.deepEqual(typed.map((r) => [r.phone_e164, r.status]).sort(), [["+8613800001111", "pending"], ["13800001111", "revoked"]].sort(), JSON.stringify(typed));
  await assert.rejects(pool.query("update organizations set status='active' where id='org_legacy_off'"), /organizations_status_derived_ck/, "the effective status can only follow its two sources");

  step("self-serve creation is closed; the platform opens enterprises");
  const owner = await person("owner", "+8613800000001");
  const a1 = await person("admin1", "+8613800000002");
  const a2 = await person("admin2", "+8613800000003");
  const m = await person("member", "+8613800000004");
  const selfServe = await call("POST", "/api/enterprise/organizations", { name: "Mine" }, owner.headers);
  assert.equal(selfServe.status, 403); assert.equal(selfServe.body.code, "ORG_CREATE_PLATFORM_ONLY");
  const created = await call("POST", "/api/admin/enterprise/organizations", { name: "Loop Co", owner: { phoneE164: "13800000001" } }, asAdmin);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const orgId = created.body.organization.id;
  assert.equal(created.body.organization.source, "platform");
  const members = `/api/enterprise/organizations/${orgId}/members`;

  step("phones typed without +86 add registered people directly and invite the rest in E.164");
  for (const [p, role] of [[a1, "admin"], [a2, "admin"], [m, "member"]]) {
    const added = await call("POST", members, { phoneE164: p.phone.replace("+86", ""), role }, owner.headers);
    assert.equal(added.status, 200, JSON.stringify(added.body)); assert.equal(added.body.member?.user_id, p.id, "a registered phone is a member now, not a dead invitation");
  }
  const invited = await call("POST", members, { phoneE164: "139 0000 2222" }, a1.headers);
  assert.equal(invited.status, 200); assert.equal(invited.body.invitation.phone_e164, "+8613900002222");
  assert.ok(new Date(invited.body.invitation.expires_at) > new Date(), "an invitation has an expiry");
  assert.equal((await call("POST", members, { phoneE164: "12345" }, a1.headers)).body.code, "INVALID_PHONE");
  assert.equal((await call("POST", members, { userId: "usr_nobody" }, a1.headers)).body.code, "USER_NOT_FOUND");

  step("admins run the roster but do not act on each other");
  const peer = await call("PATCH", `${members}/${a2.id}`, { status: "disabled" }, a1.headers);
  assert.equal(peer.status, 403); assert.equal(peer.body.code, "ORG_ADMIN_PEER_FORBIDDEN");
  assert.equal((await call("PATCH", `${members}/${m.id}`, { status: "disabled" }, a1.headers)).status, 200);
  assert.equal((await call("PATCH", `${members}/${m.id}`, { status: "active" }, a1.headers)).status, 200);
  assert.equal((await call("PATCH", `${members}/${a2.id}`, { status: "disabled" }, owner.headers)).status, 200, "the owner may");
  assert.equal((await call("PATCH", `${members}/${a2.id}`, { status: "active" }, owner.headers)).status, 200);

  step("two-layer switch: the platform's freeze cannot be lifted by the enterprise");
  const orgPath = `/api/enterprise/organizations/${orgId}`;
  const adminOrg = `/api/admin/enterprise/organizations/${orgId}`;
  const frozen = await call("PATCH", adminOrg, { platformStatus: "suspended", reason: "unpaid" }, asAdmin);
  assert.equal(frozen.status, 200); assert.equal(frozen.body.organization.status, "disabled");
  const lift = await call("PATCH", orgPath, { status: "active" }, owner.headers);
  assert.equal(lift.status, 200); assert.equal(lift.body.organization.status, "disabled", "owner resuming its own pause leaves the freeze in place");
  assert.equal(lift.body.organization.platform_status, "suspended");
  assert.equal((await call("PATCH", orgPath, { status: "disabled" }, a1.headers)).body.code, "ORG_FORBIDDEN", "pausing the org is the owner's call");
  const grant1 = await call("POST", `${adminOrg}/grants`, { resourceType: "token", unitTotal: 1000, idempotencyKey: "form-render-0001" }, asAdmin);
  const grant1Again = await call("POST", `${adminOrg}/grants`, { resourceType: "token", unitTotal: 1000, idempotencyKey: "form-render-0001" }, asAdmin);
  assert.equal(grant1Again.body.idempotent, true); assert.equal(grant1Again.body.grant.id, grant1.body.grant.id, "a retried grant form grants once");
  const gatewayBody = { model: "test-model", messages: [{ role: "user", content: "hi" }], stream: false };
  const viaOrg = (p, extra = {}) => call("POST", "/llm/loop-test/v1/chat/completions", gatewayBody,
    { authorization: `Bearer ${p.gatewayToken}`, "x-lily-organization-id": orgId, "x-lily-idempotency-key": crypto.randomUUID(), ...extra });
  const suspendedCall = await viaOrg(m);
  assert.equal(suspendedCall.status, 403); assert.equal(suspendedCall.body.error.message, "ORG_SUSPENDED");
  assert.equal((await call("PATCH", adminOrg, { platformStatus: "active" }, asAdmin)).body.organization.status, "active");

  step("a seat deferred while the org was paused is granted when it resumes");
  assert.equal((await call("PATCH", orgPath, { status: "disabled" }, owner.headers)).body.organization.owner_status, "disabled");
  assert.equal((await call("PATCH", adminOrg, { platformStatus: "active" }, asAdmin)).body.organization.status, "disabled", "the platform cannot un-pause the owner's pause either");
  const late = await person("late", "+8613900002222");
  const redeemed = await redeemInvitationsForPhone(dbMod.db, { userId: late.id, phoneE164: late.phone });
  assert.deepEqual(redeemed.deferred, [orgId]);
  assert.equal((await call("PATCH", orgPath, { status: "active" }, owner.headers)).body.organization.status, "active");
  assert.equal((await one("select role from organization_members where organization_id=$1 and user_id=$2", [orgId, late.id]))?.role, "member");
  assert.equal((await one("select status from organization_invitations where id=$1", [invited.body.invitation.id])).status, "accepted");

  step("the identity chosen pays: enterprise → pool only, personal → personal only");
  await pool.query(`insert into wallet_grants(id,user_id,source_type,source_id,grant_type,resource_type,token_total,token_remaining,unit_total,unit_remaining,starts_at,expires_at,status,metadata)
    values('g_personal',$1,'admin_adjustment',$1,'tokens','token',50,50,50,50,now()-interval '1 second',now()+interval '1 day','active','{}')`, [m.id]);
  const pool1 = grant1.body.grant.id;
  const remaining = async (id) => Number((await one("select unit_remaining from wallet_grants where id=$1", [id])).unit_remaining);
  const charge = (units, org = orgId, extra = {}) => consumeEntitlement({ userId: m.id, organizationId: org, feature: "chat", resourceType: "token", units, idempotencyKey: crypto.randomUUID(), ...extra });
  assert.equal((await charge(10)).ok, true);
  assert.deepEqual([await remaining(pool1), await remaining("g_personal")], [990, 50]);
  assert.equal((await charge(5, "")).ok, true);
  assert.deepEqual([await remaining(pool1), await remaining("g_personal")], [990, 45]);
  assert.equal((await one("select organization_id from usage_events order by created_at desc limit 1")).organization_id, null);

  step("weekly member budget: the crossing request completes, the next waits for the reset");
  assert.equal((await call("PATCH", `${members}/${m.id}`, { weeklyBudget: 30 }, a1.headers)).status, 200);
  assert.equal((await charge(15)).ok, true, "10 + 15 = 25 of 30");
  assert.equal((await charge(15)).ok, true, "crosses to 40 — completes");
  const limited = await charge(1);
  assert.equal(limited.ok, false); assert.equal(limited.code, "ORG_MEMBER_WEEKLY_LIMIT");
  const start = new Date((await one("select weekly_window_started_at from organization_members where organization_id=$1 and user_id=$2", [orgId, m.id])).weekly_window_started_at);
  assert.equal(new Date(limited.resetsAt).getTime(), start.getTime() + 7 * 24 * 3600 * 1000, "resets 7 days after the window began");
  assert.equal((await charge(3, orgId, { enforceMemberLimits: false })).ok, true, "reconcile charges for work already done");
  const limitedHttp = await viaOrg(m);
  assert.equal(limitedHttp.status, 402); assert.equal(limitedHttp.body.error.message, "ORG_MEMBER_WEEKLY_LIMIT");
  assert.ok(limitedHttp.body.error.resetsAt && limitedHttp.body.error.weeklyBudget === 30, JSON.stringify(limitedHttp.body));
  const mine = await call("GET", orgPath, undefined, m.headers);
  assert.equal(mine.body.organization.me.limited, true); assert.equal(mine.body.organization.quota, undefined, "members see their week, not the pool");
  await pool.query("update organization_members set weekly_window_started_at=now()-interval '8 days' where organization_id=$1 and user_id=$2", [orgId, m.id]);
  assert.equal((await charge(4)).ok, true, "a new week");
  assert.equal(Number((await one("select weekly_used from organization_members where organization_id=$1 and user_id=$2", [orgId, m.id])).weekly_used), 4);
  assert.equal((await call("PATCH", orgPath, { defaultMemberWeeklyBudget: 0 }, a1.headers)).status, 200);
  const a2Charge = await consumeEntitlement({ userId: a2.id, organizationId: orgId, feature: "chat", resourceType: "token", units: 1, idempotencyKey: crypto.randomUUID() });
  assert.equal(a2Charge.code, "ORG_MEMBER_WEEKLY_LIMIT", "the org default applies to members without their own budget");
  await call("PATCH", orgPath, { defaultMemberWeeklyBudget: null }, a1.headers);

  step("platform reduces and revokes; a pool shortage is named as the pool's");
  const before = await remaining(pool1);
  const reduced = await call("POST", `${adminOrg}/grants/${pool1}/reduce`, { units: 100, reason: "typo" }, asAdmin);
  assert.equal(reduced.status, 200, JSON.stringify(reduced.body)); assert.equal(await remaining(pool1), before - 100);
  const revoked = await call("POST", `${adminOrg}/grants/${pool1}/reduce`, { all: true, reason: "contract ended" }, asAdmin);
  assert.equal(revoked.body.grant.state, "revoked"); assert.equal(await remaining(pool1), 0);
  assert.equal((await call("POST", `${adminOrg}/grants/${pool1}/reduce`, { all: true, reason: "again" }, asAdmin)).body.code, "GRANT_NOT_ACTIVE");
  assert.equal((await charge(1)).code, "ORG_POOL_INSUFFICIENT");
  assert.equal((await one("select count(*)::int n from wallet_ledger where grant_id=$1 and event_type in ('adjust','revoke')", [pool1])).n, 2);

  step("org quota never appears as the owner's personal balance");
  // A live pool grant, booked (as every org grant is) under the owner's user id.
  assert.equal((await call("POST", `${adminOrg}/grants`, { resourceType: "token", unitTotal: 500 }, asAdmin)).status, 200);
  const ownerRow = (await call("GET", `/api/admin/users?q=${encodeURIComponent(owner.phone)}`, undefined, asAdmin)).body.users?.find((u) => u.id === owner.id);
  assert.ok(ownerRow, "the owner is findable by phone");
  assert.equal(ownerRow.tokenRemaining, 0, "the org's live 500-unit grant is booked under the owner's id but is not the owner's balance");
  const ownerDetail = await call("GET", `/api/admin/users/${owner.id}`, undefined, asAdmin);
  assert.equal(ownerDetail.body.grants.filter((g) => g.organization_id).length, 0);
  assert.equal(ownerDetail.body.ledger.length, 0, "the org's grant ledger is not the owner's");
  assert.equal(ownerDetail.body.entitlements.tokenBalance, 0);
  assert.deepEqual(ownerDetail.body.organizations.map((o) => [o.id, o.role]), [[orgId, "owner"]], "from a person to their enterprise");

  step("ownership transfer, leaving, and the last-owner guard");
  assert.equal((await call("POST", `${orgPath}/transfer-ownership`, { userId: a1.id }, a2.headers)).body.code, "ORG_FORBIDDEN");
  assert.equal((await call("POST", `${orgPath}/transfer-ownership`, { userId: a1.id }, owner.headers)).status, 200);
  assert.equal((await one("select role from organization_members where organization_id=$1 and user_id=$2", [orgId, owner.id])).role, "admin");
  assert.equal((await call("POST", `${orgPath}/leave`, undefined, a1.headers)).body.code, "ORG_LAST_OWNER");
  assert.equal((await call("PATCH", `${members}/${a1.id}`, { role: "admin" }, a1.headers)).body.code, "ORG_LAST_OWNER");
  assert.equal((await call("POST", `${orgPath}/leave`, undefined, m.headers)).status, 200, "a member can leave");
  assert.equal(await one("select 1 from organization_members where organization_id=$1 and user_id=$2", [orgId, m.id]), undefined);

  step("a removed issued account stays listed and can be restored");
  const issued = await call("POST", `${orgPath}/accounts`, { accounts: [{ loginName: "loop-staff-01" }] }, a1.headers);
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const staff = issued.body.accounts[0].userId;
  assert.equal((await call("DELETE", `${members}/${staff}`, undefined, a1.headers)).status, 200);
  assert.equal((await one("select status from users where id=$1", [staff])).status, "disabled");
  const listed = (await call("GET", `${orgPath}/accounts`, undefined, a1.headers)).body.accounts.find((a) => a.userId === staff);
  assert.equal(listed?.memberStatus, "removed");
  assert.equal((await call("POST", members, { userId: staff }, a1.headers)).status, 200);
  assert.equal((await one("select status from users where id=$1", [staff])).status, "active", "re-adding brings the login back");
  const eAdmin = await person("eadmin", "+8613800000009");
  await call("POST", members, { userId: eAdmin.id, role: "admin" }, a1.headers);
  assert.equal((await call("POST", `${orgPath}/accounts/${a2.id}/reset-password`, undefined, eAdmin.headers)).body.code, "ORG_ADMIN_PEER_FORBIDDEN", "a password reset on a peer is a takeover");

  step("members list says who people are; budgets are the admins' view only");
  const asAdminList = (await call("GET", `${members}?q=admin`, undefined, a1.headers)).body;
  assert.ok(asAdminList.total >= 2 && asAdminList.members.every((row) => row.displayName && "weeklyUsed" in row), JSON.stringify(asAdminList));
  const asMemberList = (await call("GET", members, undefined, late.headers)).body.members;
  assert.ok(asMemberList.every((row) => !("weeklyUsed" in row) && (!row.phone || /\*{4}/.test(row.phone))), "colleagues see a masked phone and no budgets");

  step("both sides can read the org's history; admin finds the org from a person");
  const history = (await call("GET", `${orgPath}/audit`, undefined, a1.headers)).body.entries.map((e) => e.action);
  for (const action of ["enterprise_member_add", "enterprise_member_change", "enterprise_owner_transfer", "enterprise_member_leave", "enterprise_accounts_issue", "enterprise_member_remove", "enterprise_org_change", "enterprise_invitation_create"]) {
    assert.ok(history.includes(action), `enterprise history records ${action}: ${history.join(",")}`);
  }
  const platformHistory = (await call("GET", `${adminOrg}/audit`, undefined, asAdmin)).body.entries.map((e) => e.action);
  for (const action of ["enterprise_org_create", "enterprise_org_status", "enterprise_grant_adjust", "enterprise_grant_reduce", "enterprise_grant_revoke"]) {
    assert.ok(platformHistory.includes(action), `platform history records ${action}`);
  }
  const found = (await call("GET", `/api/admin/enterprise/organizations?q=${encodeURIComponent("13800000004")}`, undefined, asAdmin)).body;
  assert.equal(found.organizations.length, 0, "a member who left is no longer a way in");
  const byStaffPhone = (await call("GET", `/api/admin/enterprise/organizations?q=${encodeURIComponent("138 0000 0002")}`, undefined, asAdmin)).body;
  assert.deepEqual(byStaffPhone.organizations.map((o) => o.id), [orgId]);
  assert.equal(byStaffPhone.organizations[0].owner.userId, a1.id, "the list names the current owner");
  const suspendedOnly = (await call("GET", "/api/admin/enterprise/organizations?status=suspended", undefined, asAdmin)).body.organizations.map((o) => o.id);
  assert.deepEqual(suspendedOnly, ["org_legacy_off"]);

  console.log("enterprise closed loop integration: ok");
} finally {
  try { await upstream.close(); } catch { /* ignore */ }
  try { await app?.close(); } catch { /* ignore */ }
  try { await closeDb?.(); } catch { try { await pool?.end(); } catch { /* ignore */ } }
  try { await control.query(`drop schema if exists ${schema} cascade`); } catch { /* ignore */ }
  await control.end();
  process.chdir(cwd);
  fs.rmSync(temp, { recursive: true, force: true });
}
