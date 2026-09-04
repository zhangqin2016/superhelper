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
Object.assign(process.env, {
  DATABASE_URL: scoped.href,
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
  await app.register(adminRoutes);
  await app.register(publicRoutes);

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
  const { loginName, initialPassword, userId } = created.body.owner;
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

  step("owner logs in with the one-time password → forced to change it");
  const login1 = await call("POST", "/api/auth/password/login", { ...device, loginName: "ACME-OWNER", password: initialPassword });
  assert.equal(login1.status, 200, JSON.stringify(login1.body));
  assert.equal(login1.body.user.passwordMustChange, true, "first login must demand a new password");
  assert.equal(login1.body.user.loginName, "acme-owner", "login name is case-insensitive on the way in");
  assert.equal(login1.body.user.phoneMasked, null, "no phone to mask");

  step("weak new password → refused; strong one → accepted");
  const bearer = { authorization: `Bearer ${login1.body.accessToken}` };
  const weak = await call("POST", "/api/auth/password/change", { ...device, currentPassword: initialPassword, newPassword: "short" }, bearer);
  assert.equal(weak.status, 400); assert.equal(weak.body.code, "PASSWORD_TOO_SHORT");
  const wrongCurrent = await call("POST", "/api/auth/password/change", { ...device, currentPassword: "not-it-123", newPassword: "NewPass2026x" }, bearer);
  assert.equal(wrongCurrent.status, 401, "changing requires the CURRENT password even with a valid session");
  const changed = await call("POST", "/api/auth/password/change", { ...device, currentPassword: initialPassword, newPassword: "NewPass2026x" }, bearer);
  assert.equal(changed.status, 200, JSON.stringify(changed.body));

  step("old password is dead, new one works and no longer forces a change");
  const oldAgain = await call("POST", "/api/auth/password/login", { ...device, loginName: "acme-owner", password: initialPassword });
  assert.equal(oldAgain.status, 401);
  const login2 = await call("POST", "/api/auth/password/login", { ...device, loginName: "acme-owner", password: "NewPass2026x" });
  assert.equal(login2.status, 200, JSON.stringify(login2.body));
  assert.equal(login2.body.user.passwordMustChange, false);

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
  try { await app?.close(); } catch { /* ignore */ }
  try { await closeDb?.(); } catch { try { await pool?.end(); } catch { /* ignore */ } }
  try { await control.query(`drop schema if exists ${schema} cascade`); } catch { /* ignore */ }
  await control.end();
  process.chdir(cwd);
  fs.rmSync(temp, { recursive: true, force: true });
}
