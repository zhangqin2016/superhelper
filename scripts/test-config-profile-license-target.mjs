#!/usr/bin/env node
// A config rule scoped to a license matched on the license's internal id, while
// the admin form took free text and the operator typed the license KEY they
// hand to customers. The rule saved, listed, and never fired: every device kept
// the global model and nothing reported it. Delivery still compares ids only —
// what changed is that the WRITE path establishes that id, or refuses.
// [gate: config-profile-target-identity]
// Run: node scripts/test-config-profile-license-target.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/lily_target_test";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  configProfileTargetNames,
  resolveConfigProfileTarget,
  targetErrorResponse,
  TARGET_NOT_FOUND,
  TARGET_REQUIRED,
} = await import("../server/src/services/config-profile-target.js");
const { hashLicenseKey } = await import("../server/src/services/security.js");
const { closeDb } = await import("../server/src/db.js");

let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`ok - ${name}`); };

const LICENSE_ID = "lic_realinternalid";
const LICENSE_KEY = "LILY-ABCD1234-EFGH";
const deps = {
  findById: async (table, column, value) => {
    if (table === "licenses" && value === LICENSE_ID) return LICENSE_ID;
    if (table === "devices" && value === "device-1") return "device-1";
    if (table === "config_groups" && value === "group-1") return "group-1";
    return null;
  },
  findLicenseByKeyHash: async (hash) => (hash === hashLicenseKey(LICENSE_KEY) ? LICENSE_ID : null),
};

try {
  await check("the license key an operator actually holds resolves to the id delivery matches", async () => {
    const out = await resolveConfigProfileTarget({ scope: "license", targetId: LICENSE_KEY }, deps);
    assert.deepEqual(out, { ok: true, targetId: LICENSE_ID, resolvedFrom: "licenseKey" });
    // Case and padding are how a pasted key arrives.
    const pasted = await resolveConfigProfileTarget({ scope: "license", targetId: `  ${LICENSE_KEY.toLowerCase()} ` }, deps);
    assert.equal(pasted.targetId, LICENSE_ID);
  });

  await check("an internal id still works and is stored unchanged", async () => {
    const out = await resolveConfigProfileTarget({ scope: "license", targetId: LICENSE_ID }, deps);
    assert.deepEqual(out, { ok: true, targetId: LICENSE_ID, resolvedFrom: "id" });
  });

  await check("a target that matches nothing is refused instead of saved dead", async () => {
    const out = await resolveConfigProfileTarget({ scope: "license", targetId: "LILY-NOSUCH-KEY" }, deps);
    assert.equal(out.ok, false);
    assert.equal(out.code, TARGET_NOT_FOUND);
    const body = targetErrorResponse(out);
    assert.match(body.message, /never apply/, "the operator is told why it is refused");
    assert.match(body.message, /license key or its internal id/, "and which two forms are accepted");
    for (const scope of ["device", "group"]) {
      const miss = await resolveConfigProfileTarget({ scope, targetId: "nope" }, deps);
      assert.equal(miss.ok, false, `${scope} targets are verified too`);
    }
    assert.equal((await resolveConfigProfileTarget({ scope: "device", targetId: "device-1" }, deps)).targetId, "device-1");
    assert.equal((await resolveConfigProfileTarget({ scope: "group", targetId: "group-1" }, deps)).targetId, "group-1");
  });

  await check("global carries no target, and a scoped rule cannot be saved without one", async () => {
    assert.deepEqual(await resolveConfigProfileTarget({ scope: "global", targetId: "ignored" }, deps), {
      ok: true, targetId: null, resolvedFrom: "global",
    });
    const empty = await resolveConfigProfileTarget({ scope: "license", targetId: "  " }, deps);
    assert.equal(empty.code, TARGET_REQUIRED);
  });

  await check("a scope this module does not know stays saveable", async () => {
    const out = await resolveConfigProfileTarget({ scope: "future-scope", targetId: "abc" }, deps);
    assert.deepEqual(out, { ok: true, targetId: "abc", resolvedFrom: "unvalidated" });
  });

  await check("both admin write paths establish the target; neither stores raw input", async () => {
    const src = fs.readFileSync(path.join(ROOT, "server/src/routes/admin/config-profiles.js"), "utf8");
    assert.equal(src.match(/resolveConfigProfileTarget\(/g)?.length, 2, "create and update both resolve");
    assert.ok(!/target_id: input\.scope === "global" \? null : input\.targetId/.test(src), "no raw target reaches the table");
    assert.match(src, /target_id: resolvedTarget\.targetId/, "the resolved id is what is written");
  });

  await check("the rules already written with a key heal themselves, once", async () => {
    const sql = fs.readFileSync(path.join(ROOT, "server/migrations/054_config_profile_license_targets.sql"), "utf8");
    assert.match(sql, /encode\(sha256\(convert_to\(upper\(btrim\(p\.target_id\)\), 'UTF8'\)\), 'hex'\)/, "hashed the same way the server hashes a key");
    assert.match(sql, /not exists \(select 1 from licenses x where x\.id = p\.target_id\)/, "a valid id is never rewritten");
    assert.match(sql, /scope = 'license'/, "and no other scope is touched");
    // hashLicenseKey is sha256 over the UPPER-cased, trimmed key as UTF-8 text,
    // which is exactly what the SQL expression computes.
    assert.equal(hashLicenseKey(` ${LICENSE_KEY.toLowerCase()} `), hashLicenseKey(LICENSE_KEY));
  });

  await check("the rules list names each target, one lookup per scope, and falls back to ids when a lookup fails", async () => {
    const calls = [];
    const findNames = async (source, ids) => {
      calls.push([source.table, ids]);
      if (source.table === "organizations") throw new Error("db down");
      if (source.table === "licenses") return ids.map((id) => ({ id, name: id === LICENSE_ID ? "星河科技" : null }));
      return ids.map((id) => ({ id, name: `group ${id}` }));
    };
    const names = await configProfileTargetNames([
      { scope: "global", target_id: null },
      { scope: "license", target_id: LICENSE_ID },
      { scope: "license", target_id: "lic_other" },
      { scope: "group", target_id: "grp_1" },
      { scope: "group", target_id: "grp_1" },
      { scope: "organization", target_id: "org_1" },
      { scope: "device", target_id: "dev_1" },
    ], { findNames });
    assert.equal(names.get(`license:${LICENSE_ID}`), "星河科技");
    assert.equal(names.has("license:lic_other"), false, "a license without a customer name stays unnamed");
    assert.equal(names.get("group:grp_1"), "group grp_1");
    assert.equal(names.has("organization:org_1"), false, "a failed lookup leaves that scope unnamed, not an error");
    assert.deepEqual(calls.map(([table]) => table).sort(), ["config_groups", "licenses", "organizations"], "one query per named scope; devices and global are not looked up");
    assert.deepEqual(calls.find(([table]) => table === "config_groups")[1], ["grp_1"], "ids are deduplicated");
  });

  console.log(`\n${checks} checks passed (config profile target identity)`);
} finally {
  await closeDb?.();
}
