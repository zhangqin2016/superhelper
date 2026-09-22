#!/usr/bin/env node
// "More specific wins" used to be a habit maintained by hand-picked priority
// numbers: merge order was (priority, updated_at) with no notion of scope, so a
// global rule with a larger number silently beat the license rule written for
// one customer. And the admin preview carried its own copy of the matcher,
// which had already drifted — it knew nothing about user- or organization-
// scoped rules, so it lied about exactly the rules hardest to reason about.
// [gate: config-delivery-explainability]
// Run: node scripts/test-config-scope-precedence.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/lily_precedence_test";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  SCOPE_SPECIFICITY,
  compareProfilesForMerge,
  profileMatchesTarget,
  scopeSpecificity,
  selectProfilesForTarget,
} = await import("../server/src/services/config-profile-selection.js");

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; console.log(`ok - ${name}`); };

const rule = (id, scope, extra = {}) => ({
  id, scope, name: id, enabled: true, priority: 0, rollout_percent: 100,
  updated_at: "2026-01-01T00:00:00.000Z", target_id: null, config: {}, ...extra,
});

check("a rule aimed at one license outranks a global rule whatever the numbers say", () => {
  const profiles = [
    rule("global-loud", "global", { priority: 99999, config: { models: { providers: ["deepseek"] } } }),
    rule("license-rule", "license", { priority: -100, target_id: "lic_1", config: { models: { providers: ["daypop"] } } }),
  ];
  const { applied } = selectProfilesForTarget(profiles, { deviceId: "d1", licenseId: "lic_1" });
  assert.deepEqual(applied.map((p) => p.id), ["global-loud", "license-rule"], "the narrower rule merges last");
});

check("specificity runs global → organization → group → license → user → device", () => {
  assert.deepEqual(
    Object.entries(SCOPE_SPECIFICITY).sort((a, b) => a[1] - b[1]).map(([k]) => k),
    ["global", "organization", "group", "license", "user", "device"],
  );
  // A scope this build does not know is narrower than global and never beats a device rule.
  assert.ok(scopeSpecificity("global") < scopeSpecificity("future") && scopeSpecificity("future") < scopeSpecificity("device"));
});

check("priority still orders two rules that compete inside one scope", () => {
  const profiles = [
    rule("late", "license", { priority: 10, target_id: "lic_1" }),
    rule("early", "license", { priority: 1, target_id: "lic_1" }),
  ];
  const { applied } = selectProfilesForTarget(profiles, { licenseId: "lic_1" });
  assert.deepEqual(applied.map((p) => p.id), ["early", "late"]);
  // Same scope and priority: the older edit merges first, and ties break by id
  // so the order never depends on which row the database happened to return.
  const a = rule("aaa", "license", { target_id: "lic_1" });
  const b = rule("bbb", "license", { target_id: "lic_1" });
  assert.ok(compareProfilesForMerge(a, b) < 0 && compareProfilesForMerge(b, a) > 0);
});

check("every scope delivery knows is matched, including the two the preview used to miss", () => {
  const target = { deviceId: "d1", licenseId: "lic_1", groupId: "g1", userId: "u1", organizationIds: ["org_1", "org_2"] };
  for (const [scope, id] of [["group", "g1"], ["license", "lic_1"], ["device", "d1"], ["user", "u1"], ["organization", "org_2"]]) {
    assert.equal(profileMatchesTarget(rule("x", scope, { target_id: id }), target), true, `${scope} matches`);
    assert.equal(profileMatchesTarget(rule("x", scope, { target_id: "other" }), target), false, `${scope} does not over-match`);
  }
  assert.equal(profileMatchesTarget(rule("g", "global"), target), true);
  assert.equal(profileMatchesTarget(rule("g", "global", { target_id: "stray" }), target), false, "a global rule with a target is not global");
  // An unknown scope never falls through to "applies to everyone".
  assert.equal(profileMatchesTarget(rule("f", "future", { target_id: "d1" }), target), false);
});

check("a rule that does not apply says why, and a target it was never aimed at is not noise", () => {
  const profiles = [
    rule("off", "global", { enabled: false }),
    rule("elsewhere", "device", { target_id: "other-device" }),
    rule("held", "global"),
  ];
  const { applied, skipped } = selectProfilesForTarget(profiles, { deviceId: "d1" }, {
    rolloutAllows: (profile) => profile.id !== "held",
  });
  assert.deepEqual(applied.map((p) => p.id), []);
  assert.deepEqual(skipped, [
    { id: "off", scope: "global", reason: "disabled" },
    { id: "elsewhere", scope: "device", reason: "target_mismatch" },
    { id: "held", scope: "global", reason: "rollout_withheld" },
  ]);
});

check("delivery and the admin preview run this one selection — there is no second copy", () => {
  const delivery = fs.readFileSync(path.join(ROOT, "server/src/routes/public/client-config.js"), "utf8");
  const admin = fs.readFileSync(path.join(ROOT, "server/src/routes/admin/config-profiles.js"), "utf8");
  for (const [name, src] of [["delivery", delivery], ["preview", admin]]) {
    assert.match(src, /selectProfilesForTarget\(/, `${name} selects through the shared seam`);
    assert.ok(!/profile\.scope === "global"/.test(src), `${name} keeps no private matcher`);
    assert.ok(!/orderBy\("priority"/.test(src), `${name} no longer orders in SQL, where specificity cannot be expressed`);
  }
});

console.log(`\n${checks} checks passed (config scope precedence)`);
