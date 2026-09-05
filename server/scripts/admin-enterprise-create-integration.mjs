#!/usr/bin/env node
// Closed loop for "the platform admin creates an enterprise and hands it off":
// real Postgres, the REAL migrations (044 alters users), the real routes.
//
//   admin creates org with an issued owner
//     -> owner logs in with the one-time password
//     -> is forced to change it
//     -> old password dies, new one works
//     -> the org appears in the owner's list and the admin's list
//   and the doors that must stay shut: no admin token, unregistered owner phone
//   (rolled back, nothing leaks), five wrong passwords then even the right one.
//
// Skips cleanly without DATABASE_URL. Uses a throwaway schema so it can never
// touch real data, and drops it on the way out.

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

if (!process.env.DATABASE_URL) { console.log("admin enterprise create: skipped (DATABASE_URL not configured)"); process.exit(0); }

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = `admin_enterprise_create_${crypto.randomUUID().replaceAll("-", "")}`;
const control = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const scoped = new URL(process.env.DATABASE_URL);
scoped.searchParams.set("options", `-c search_path=${schema}`);
scoped.searchParams.set("application_name", schema);

const cwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "admin-enterprise-"));
process.chdir(temp); // never let dotenv read real operator secrets
const ADMIN_TOKEN = crypto.randomBytes(32).toString("hex");
const upstream = Fastify({ logger: false });
let upstreamCalls = 0;
upstream.post("/v1/chat/completions", async () => {
  upstreamCalls += 1;
  return { id: "enterprise-fixture", object: "chat.completion", choices: [{ message: { role: "assistant", content: "employee response" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
});
const upstreamUrl = await upstream.listen({ host: "127.0.0.1", port: 0 });
Object.assign(process.env, {
  DATABASE_URL: scoped.href,
  MODEL_GATEWAY_PROVIDERS: JSON.stringify({ "enterprise-test": { type: "openai", baseUrl: `${upstreamUrl}/v1`, apiKey: "fixture-only", model: "test-model" } }),
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

  step("apply the real migrations into the scratch schema");
  const migrate = spawnSync(process.execPath, [path.join(here, "migrate.mjs")], {
    env: { ...process.env, DATABASE_URL: scoped.href }, encoding: "utf8", cwd: path.resolve(here, ".."),
  });
  assert.equal(migrate.status, 0, `migrate failed:\n${migrate.stdout}\n${migrate.stderr}`);
  assert.match(migrate.stdout, /044_enterprise_accounts\.sql/, "migration 044 must be among those applied");

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

  const call = async (method, url, payload, headers = {}) => {
    const res = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }), headers });
    let body = null; try { body = res.json(); } catch { body = res.body; }
    return { status: res.statusCode, body };
  };
  const asAdmin = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const device = { deviceId: "device-owner-00001", platform: "darwin", appVersion: "0.0.0-test" };

  step("no admin token → refused");
  const anon = await call("POST", "/api/admin/enterprise/organizations", { name: "Nope", owner: { issue: true } });
  assert.ok([401, 403].includes(anon.status), `expected 401/403, got ${anon.status} ${JSON.stringify(anon.body)}`);

  step("owner by UNREGISTERED phone → refused by name, and nothing leaks");
  const before = Number((await pool.query("select count(*)::int as n from organizations")).rows[0].n);
  const badPhone = await call("POST", "/api/admin/enterprise/organizations", { name: "Ghost Co", owner: { phoneE164: "+8613900000000" } }, asAdmin);
  assert.equal(badPhone.status, 404, JSON.stringify(badPhone.body));
  assert.equal(badPhone.body?.code, "OWNER_NOT_REGISTERED");
  const after = Number((await pool.query("select count(*)::int as n from organizations")).rows[0].n);
  assert.equal(after, before, "a refused create must roll the organization row back too");

  step("admin creates the org and issues its owner");
  const created = await call("POST", "/api/admin/enterprise/organizations",
    { name: "Acme Corp", plan: "standard", owner: { issue: true, loginName: "acme-owner", displayName: "Acme Admin" } }, asAdmin);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const orgId = created.body.organization.id;
  let { loginName, initialPassword, userId } = created.body.owner;
  assert.equal(created.body.owner.issued, true);
  assert.equal(loginName, "acme-owner");
  assert.match(initialPassword, /^[a-zA-Z2-9]{12}$/, "a 12-char initial password without 0/O/1/l/I");
  assert.equal(created.body.organization.status, "active");

  step("the database holds a hash and an owner membership — never the password");
  const userRow = (await pool.query("select phone_e164, login_name, password_hash, password_must_change, provisioned_organization_id, status from users where id=$1", [userId])).rows[0];
  assert.equal(userRow.phone_e164, null, "an issued account has no phone");
  assert.equal(userRow.login_name, "acme-owner");
  assert.match(userRow.password_hash, /^scrypt\$/);
  assert.equal(userRow.password_must_change, true);
  assert.equal(userRow.provisioned_organization_id, orgId, "the org owns the account");
  const leaked = await pool.query("select count(*)::int as n from users where password_hash = $1 or login_name = $1 or display_name = $1", [initialPassword]);
  assert.equal(leaked.rows[0].n, 0, "the initial password must not be stored anywhere");
  const member = (await pool.query("select role, status from organization_members where organization_id=$1 and user_id=$2", [orgId, userId])).rows[0];
  assert.deepEqual(member, { role: "owner", status: "active" });
  const audit = await pool.query("select count(*)::int as n from audit_logs where action='enterprise_org_create' and target_id=$1", [orgId]);
  assert.equal(audit.rows[0].n, 1, "creation must be audited exactly once");

  step("platform can reissue only an unactivated issued owner's initial handoff");
  const adminDetail = await call("GET", `/api/admin/enterprise/organizations/${orgId}`, undefined, asAdmin);
  assert.deepEqual(adminDetail.body.organization.owners, [{ id: userId, loginName, displayName: "Acme Admin", passwordMustChange: true, issued: true }]);
  const recoveryPath = `/api/admin/enterprise/organizations/${orgId}/owner-initial-password`;
  assert.equal((await call("POST", recoveryPath, { userId })).status, 401);
  const other = await call("POST", "/api/admin/enterprise/organizations", { name: "Other Co", owner: { issue: true } }, asAdmin);
  assert.equal((await call("POST", recoveryPath, { userId: other.body.owner.userId }, asAdmin)).status, 409);
  await pool.query("update users set provisioned_organization_id=null where id=$1", [userId]);
  assert.equal((await call("POST", recoveryPath, { userId }, asAdmin)).status, 409, "personal owners are never recoverable by platform admin");
  await pool.query("update users set provisioned_organization_id=$1 where id=$2", [orgId, userId]);
  const reissued = await call("POST", recoveryPath, { userId }, asAdmin);
  assert.equal(reissued.status, 200, JSON.stringify(reissued.body));
  assert.equal(reissued.body.owner.userId, userId); assert.notEqual(reissued.body.owner.initialPassword, initialPassword);
  initialPassword = reissued.body.owner.initialPassword;
  assert.equal((await pool.query("select count(*)::int as n from audit_logs where action='enterprise_owner_initial_password_reissue' and target_id=$1", [orgId])).rows[0].n, 1);

  step("owner logs in with the one-time password → forced to change it");
  const login1 = await call("POST", "/api/auth/password/login", { ...device, loginName: "ACME-OWNER", password: initialPassword });
  assert.equal(login1.status, 200, JSON.stringify(login1.body));
  assert.equal(login1.body.user.passwordMustChange, true, "first login must demand a new password");
  assert.equal(login1.body.user.loginName, "acme-owner", "login name is case-insensitive on the way in");
  assert.equal(login1.body.user.phoneMasked, null, "no phone to mask");

  step("initial credentials cannot manage organizations or use account gateways");
  const initialAccess = { authorization: `Bearer ${login1.body.accessToken}` };
  const initialOrgs = await call("GET", "/api/enterprise/organizations", undefined, initialAccess);
  assert.equal(initialOrgs.status, 403, JSON.stringify(initialOrgs.body));
  assert.equal(initialOrgs.body.code, "PASSWORD_CHANGE_REQUIRED");

  step("weak new password → refused; strong one → accepted");
  const bearer = { authorization: `Bearer ${login1.body.accessToken}` };
  const weak = await call("POST", "/api/auth/password/change", { ...device, currentPassword: initialPassword, newPassword: "short" }, bearer);
  assert.equal(weak.status, 400); assert.equal(weak.body.code, "PASSWORD_TOO_SHORT");
  const wrongCurrent = await call("POST", "/api/auth/password/change", { ...device, currentPassword: "not-it-123", newPassword: "NewPass2026x" }, bearer);
  assert.equal(wrongCurrent.status, 401, "changing requires the CURRENT password even with a valid session");
  const changed = await call("POST", "/api/auth/password/change", { ...device, currentPassword: initialPassword, newPassword: "NewPass2026x" }, bearer);
  assert.equal(changed.status, 200, JSON.stringify(changed.body));

  step("nickname updates only the signed-in account and survives login");
  await pool.query("insert into user_profiles(user_id,lily_id,lily_id_display) values($1,$2,$2) on conflict(user_id) do nothing", [userId, "nickname-test-owner"]);
  assert.equal((await call("POST", "/api/auth/profile", { ...device, displayName: "No auth" })).status, 401);
  assert.equal((await call("POST", "/api/auth/profile", { ...device, deviceId: "wrong-device", displayName: "Wrong device" }, bearer)).status, 403);
  assert.equal((await call("POST", "/api/auth/profile", { ...device, displayName: " " }, bearer)).status, 400);
  const nickname = await call("POST", "/api/auth/profile", { ...device, displayName: " 小莉 🌸 ", userId: "someone-else" }, bearer);
  assert.equal(nickname.status, 200, JSON.stringify(nickname.body));
  assert.equal(nickname.body.displayName, "小莉 🌸");
  const existingLilyId = (await pool.query("select lily_id from user_profiles where user_id=$1", [userId])).rows[0].lily_id;
  assert.equal(existingLilyId, "nickname-test-owner", "editing preserves an existing public Lily ID");
  await pool.query("delete from user_profiles where user_id=$1", [userId]);
  assert.equal((await call("POST", "/api/auth/profile", { ...device, displayName: "小莉 🌸" }, bearer)).status, 200);
  const generatedProfile = (await pool.query("select lily_id,display_name from user_profiles where user_id=$1", [userId])).rows[0];
  assert.match(generatedProfile.lily_id, /^lily_[a-f0-9]{24}$/);
  assert.equal(generatedProfile.display_name, "小莉 🌸");
  assert.equal((await pool.query("select display_name from user_profiles where user_id=$1", [userId])).rows[0].display_name, "小莉 🌸");

  step("old password is dead, new one works and no longer forces a change");
  const oldAgain = await call("POST", "/api/auth/password/login", { ...device, loginName: "acme-owner", password: initialPassword });
  assert.equal(oldAgain.status, 401);
  const login2 = await call("POST", "/api/auth/password/login", { ...device, loginName: "acme-owner", password: "NewPass2026x" });
  assert.equal(login2.status, 200, JSON.stringify(login2.body));
  assert.equal(login2.body.user.passwordMustChange, false);
  assert.equal(login2.body.user.displayName, "小莉 🌸");

  assert.equal((await call("POST", recoveryPath, { userId }, asAdmin)).status, 409, "activated owner is outside platform credential recovery");

  step("the org is visible to its owner and to the admin");
  const mine = await call("GET", "/api/enterprise/organizations", undefined, { authorization: `Bearer ${login2.body.accessToken}` });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const row = (mine.body.organizations || []).find((o) => o.id === orgId);
  assert.ok(row, "owner must see the org in their list");
  assert.equal(row.role, "owner");
  const adminList = await call("GET", "/api/admin/enterprise/organizations", undefined, asAdmin);
  const adminRow = (adminList.body.organizations || []).find((o) => o.id === orgId);
  assert.ok(adminRow, "admin must see the org");
  assert.equal(Number(adminRow.member_count), 1);

  step("org detail carries caller role, and owner provisions employee/admin accounts");
  const ownerHeaders = { authorization: `Bearer ${login2.body.accessToken}` };
  const detail = await call("GET", `/api/enterprise/organizations/${orgId}`, undefined, ownerHeaders);
  assert.equal(detail.body.organization.role, "owner");
  const issued = await call("POST", `/api/enterprise/organizations/${orgId}/accounts`, {
    accounts: [{ loginName: "acme-employee", role: "member" }, { loginName: "acme-manager", role: "admin" }],
  }, ownerHeaders);
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const [employee, manager] = issued.body.accounts;
  const { createAccessToken } = await import("../src/services/account-auth.js");
  const gatewayAuth = await import("../src/services/model-gateway/auth.js");
  const { signModelGatewayToken } = gatewayAuth;
  const { verifyLiveModelGatewayToken } = gatewayAuth;
  const { consumeEntitlement } = await import("../src/services/wallet.js");
  for (const person of [employee, manager]) {
    await pool.query("insert into user_sessions(id,user_id,refresh_token_hash,device_id,expires_at) values($1,$2,$3,'device-owner-00001',now()+interval '1 day')", [`test-${person.userId}`, person.userId, crypto.randomUUID()]);
  }
  const { createEnterpriseMutationService } = await import("../src/services/enterprise-mutations.js");
  const mutations = createEnterpriseMutationService(dbMod.db);
  const managerScope = { organizationId: orgId, account: { userId: manager.userId, sessionId: `test-${manager.userId}` } };
  await assert.rejects(() => mutations.provisionAccounts(managerScope, { accounts: [{ loginName: "must-not-issue" }] }), { code: "PASSWORD_CHANGE_REQUIRED" });
  const employeeToken = signModelGatewayToken({ userId: employee.userId, sessionId: `test-${employee.userId}`, deviceId: "" });
  assert.equal((await verifyLiveModelGatewayToken(employeeToken)).code, "PASSWORD_CHANGE_REQUIRED");
  await pool.query("update users set password_must_change=false where id=any($1::text[])", [[employee.userId, manager.userId]]);
  const managerHeaders = { authorization: `Bearer ${createAccessToken({ userId: manager.userId, sessionId: `test-${manager.userId}` })}` };
  const forbiddenReset = await call("POST", `/api/enterprise/organizations/${orgId}/accounts/${userId}/reset-password`, {}, managerHeaders);
  assert.equal(forbiddenReset.status, 403, JSON.stringify(forbiddenReset.body));
  assert.equal(forbiddenReset.body.code, "ORG_OWNER_IMMUTABLE");
  const employeeHeaders = { authorization: `Bearer ${createAccessToken({ userId: employee.userId, sessionId: `test-${employee.userId}` })}` };
  const employeeReset = await call("POST", `/api/enterprise/organizations/${orgId}/accounts/${manager.userId}/reset-password`, {}, employeeHeaders);
  assert.equal(employeeReset.status, 403);

  step("platform grants pool; employee debit preserves personal-first and records actual consumer");
  const funded = await call("POST", `/api/admin/enterprise/organizations/${orgId}/grants`, { resourceType: "token", unitTotal: 100 }, asAdmin);
  assert.equal(funded.status, 200, JSON.stringify(funded.body));
  const orgGrant = (await pool.query("select * from wallet_grants where organization_id=$1", [orgId])).rows[0];
  assert.equal(orgGrant.user_id, userId);
  await pool.query(`insert into wallet_grants(id,user_id,source_type,source_id,grant_type,resource_type,token_total,token_remaining,unit_total,unit_remaining,starts_at,expires_at,status,metadata)
    values('employee-personal',$1,'admin_adjustment',$1,'tokens','token',10,10,10,10,now()-interval '1 second',now()+interval '1 day','active','{}')`, [employee.userId]);
  const consume = (units, key = crypto.randomUUID()) => consumeEntitlement({ userId: employee.userId, organizationId: orgId, feature: "chat", resourceType: "token", units, idempotencyKey: key });
  assert.equal((await consume(6)).ok, true);
  assert.equal(Number((await pool.query("select unit_remaining from wallet_grants where id=$1", [orgGrant.id])).rows[0].unit_remaining), 100);
  assert.equal((await consume(20)).ok, true);
  assert.equal(Number((await pool.query("select unit_remaining from wallet_grants where id='employee-personal'")).rows[0].unit_remaining), 4, "full request falls back without partially spending personal funds");
  const debit = (await pool.query("select user_id,unit_delta from wallet_ledger where grant_id=$1 and event_type='consume'", [orgGrant.id])).rows[0];
  assert.equal(debit.user_id, employee.userId); assert.equal(Number(debit.unit_delta), -20);
  // Hold the grant until both real requests are waiting on its row. This
  // deterministically exposes stale selections instead of relying on timing.
  const blocker = await pool.connect();
  let concurrent;
  try {
    await blocker.query("begin");
    await blocker.query("select id from wallet_grants where id=$1 for update", [orgGrant.id]);
    const pending = Promise.all([consume(60), consume(60)]);
    const deadline = Date.now() + 5000;
    for (;;) {
      const waiting = (await control.query("select count(*)::int as n from pg_stat_activity where application_name=$1 and wait_event_type='Lock'", [schema])).rows[0].n;
      if (waiting >= 2) break;
      assert.ok(Date.now() < deadline, "both consumption transactions must reach the locked grant");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await blocker.query("commit");
    concurrent = await pending;
  } finally { await blocker.query("rollback"); blocker.release(); }
  assert.equal(concurrent.filter((r) => r.ok).length, 1, "only one request can spend the remaining 80 units");
  assert.equal(concurrent.find((r) => !r.ok).code, "ENTITLEMENT_INSUFFICIENT");
  assert.equal(Number((await pool.query("select unit_remaining from wallet_grants where id=$1", [orgGrant.id])).rows[0].unit_remaining), 20);
  const retryKey = crypto.randomUUID();
  const duplicate = await Promise.all([consume(10, retryKey), consume(10, retryKey)]);
  assert.ok(duplicate.every((r) => r.ok)); assert.equal(duplicate.filter((r) => r.idempotent).length, 1);
  assert.equal(Number((await pool.query("select unit_remaining from wallet_grants where id=$1", [orgGrant.id])).rows[0].unit_remaining), 10);

  const foreignRetry = await consumeEntitlement({ userId: manager.userId, organizationId: orgId, feature: "chat", resourceType: "token", units: 10, idempotencyKey: retryKey });
  assert.equal(foreignRetry.ok, false, "another user cannot replay someone else's consumption receipt");
  assert.equal(foreignRetry.code, "IDEMPOTENCY_CONFLICT");

  step("cookie sessions force password change and an owner reset revokes previous sessions");
  const employeeLogin = await call("POST", "/api/auth/password/login", { ...device, loginName: employee.loginName, password: employee.initialPassword });
  assert.equal(employeeLogin.status, 200, JSON.stringify(employeeLogin.body));
  const employeeCookie = { cookie: `lily_user_session=${employeeLogin.body.webSessionToken}` };
  const reset = await call("POST", `/api/enterprise/organizations/${orgId}/accounts/${employee.userId}/reset-password`, {}, ownerHeaders);
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal((await call("GET", "/api/auth/session/current", undefined, employeeCookie)).status, 401, "reset revokes existing cookies");
  assert.equal((await verifyLiveModelGatewayToken(employeeToken)).code, "USER_LOGIN_REQUIRED", "reset revokes gateway sessions as well");
  const freshLogin = await call("POST", "/api/auth/password/login", { ...device, loginName: employee.loginName, password: reset.body.initialPassword }, { "x-lily-region": "uae" });
  assert.equal(freshLogin.status, 200, JSON.stringify(freshLogin.body));
  const freshCookie = { cookie: `lily_user_session=${freshLogin.body.webSessionToken}` };
  const initialProfile = await call("GET", "/api/auth/session/current", undefined, freshCookie);
  assert.equal(initialProfile.status, 200); assert.equal(initialProfile.body.user.passwordMustChange, true);
  assert.equal((await call("GET", "/api/enterprise/organizations", undefined, freshCookie)).body.code, "PASSWORD_CHANGE_REQUIRED");
  const cookieChanged = await call("POST", "/api/auth/password/change", { currentPassword: reset.body.initialPassword, newPassword: "EmployeeNew2026" }, freshCookie);
  assert.equal(cookieChanged.status, 200, JSON.stringify(cookieChanged.body));
  assert.equal((await call("GET", "/api/auth/session/current", undefined, freshCookie)).body.user.passwordMustChange, false);
  assert.equal((await call("GET", "/api/enterprise/organizations", undefined, freshCookie)).status, 200);
  assert.equal((await call("GET", "/api/auth/session/current", undefined, { cookie: "lily_user_session=invalid" })).status, 401);
  // Restore only the synthetic test session for independent disabled/revoked checks.
  await pool.query("update user_sessions set revoked_at=null where id=$1", [`test-${employee.userId}`]);

  step("actual gateway HTTP forwards the org header into the employee pool debit");
  const topup = await call("POST", `/api/admin/enterprise/organizations/${orgId}/grants`, { resourceType: "token", unitTotal: 1000 }, asAdmin);
  assert.equal(topup.status, 200);
  await pool.query("update wallet_grants set unit_remaining=0,token_remaining=0 where user_id=$1 and organization_id is null", [employee.userId]);
  const gatewayHeaders = { authorization: `Bearer ${employeeToken}`, "x-lily-organization-id": orgId, "x-lily-idempotency-key": crypto.randomUUID() };
  const gatewayBody = { model: "test-model", messages: [{ role: "user", content: "Hello" }], stream: false };
  const gatewayReply = await call("POST", "/llm/enterprise-test/v1/chat/completions", gatewayBody, gatewayHeaders);
  assert.equal(gatewayReply.status, 200, JSON.stringify(gatewayReply.body));
  assert.equal(gatewayReply.body.choices[0].message.content, "employee response");
  const gatewayUsage = (await pool.query("select user_id,organization_id,billable_units from usage_events where idempotency_key=$1", [gatewayHeaders["x-lily-idempotency-key"]])).rows[0];
  assert.equal(gatewayUsage.user_id, employee.userId); assert.equal(gatewayUsage.organization_id, orgId);
  assert.ok(Number(gatewayUsage.billable_units) > 0);

  step("disabled and revoked accounts lose existing enterprise and gateway sessions");
  assert.equal((await verifyLiveModelGatewayToken(employeeToken)).ok, true);
  await pool.query("update users set status='disabled' where id=$1", [employee.userId]);
  assert.equal((await call("GET", "/api/enterprise/organizations", undefined, employeeHeaders)).body.code, "USER_DISABLED");
  assert.equal((await verifyLiveModelGatewayToken(employeeToken)).code, "USER_DISABLED");
  const callsBeforeDisabled = upstreamCalls;
  const disabledGateway = await call("POST", "/llm/enterprise-test/v1/chat/completions", gatewayBody, gatewayHeaders);
  assert.equal(disabledGateway.status, 401); assert.equal(disabledGateway.body.error.message, "USER_DISABLED");
  assert.equal(upstreamCalls, callsBeforeDisabled, "disabled account never reaches the provider");
  await pool.query("update users set status='active' where id=$1", [employee.userId]);
  await pool.query("update user_sessions set revoked_at=now() where id=$1", [`test-${employee.userId}`]);
  assert.equal((await verifyLiveModelGatewayToken(employeeToken)).code, "USER_LOGIN_REQUIRED");

  step("five wrong passwords lock the account — even against the right one");
  for (let i = 0; i < 5; i += 1) await call("POST", "/api/auth/password/login", { ...device, loginName: "acme-owner", password: `wrong-${i}` });
  const locked = await call("POST", "/api/auth/password/login", { ...device, loginName: "acme-owner", password: "NewPass2026x" });
  assert.equal(locked.status, 429, JSON.stringify(locked.body));
  assert.equal(locked.body.code, "PASSWORD_LOCKED");

  step("the admin surface still has no member endpoints (the §7.1 boundary held)");
  const noMembers = await call("GET", `/api/admin/enterprise/organizations/${orgId}/members`, undefined, asAdmin);
  assert.equal(noMembers.status, 404, "there must be no admin member route");

  console.log("admin enterprise create integration: ok");
} finally {
  try { await upstream.close(); } catch { /* ignore */ }
  try { await app?.close(); } catch { /* ignore */ }
  try { await closeDb?.(); } catch { try { await pool?.end(); } catch { /* ignore */ } }
  try { await control.query(`drop schema if exists ${schema} cascade`); } catch { /* ignore */ }
  await control.end();
  process.chdir(cwd);
  fs.rmSync(temp, { recursive: true, force: true });
}
