#!/usr/bin/env node
// The usage page shows each weekly allowance as "used N%" with its reset time
// and the credits beyond it as a balance — like Claude and ChatGPT (2026-09-30).
// Every number is the server's; nothing is estimated, and a missing number is
// never drawn as a guess.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildUsageLimits, percentUsed } = require("../src/main/usage-limits.js");

// Percent: whole, clamped (the request that crosses the line still completes).
assert.equal(percentUsed(4200, 10000), 42);
assert.equal(percentUsed(12000, 10000), 100);
assert.equal(percentUsed(-5, 10000), 0);
assert.equal(percentUsed(5, 0), null, "no allowance, no percentage");

const maxPlan = { tier: "max", weeklyUnits: 22000, weekRemaining: 11000, weekResetsAt: "2026-10-02T02:00:00.000Z" };
const serverLicense = (credits, plan = "premium") => ({ source: "server", valid: true, license: { plan, rawPayload: { credits } } });

// Personal plan + licence pool + extra credits (beyond the week's allowance).
let page = buildUsageLimits({
  signedIn: true,
  entitlements: { tokenBalance: 23340, extraTokenBalance: 12340, imageGenerationsRemaining: 40, plan: maxPlan },
  licenseStatus: serverLicense({ unlimited: false, total: 56000, used: 14000, resetsAt: "2026-10-03T00:00:00.000Z" }),
});
assert.deepEqual(page.limits.map((l) => [l.kind, l.percent]), [["license", 25], ["plan", 50]]);
assert.equal(page.limits[1].resetsAt, maxPlan.weekResetsAt);
assert.equal(page.extraCredits, 12340, "the plan's weekly credits are not counted as extra");
assert.equal(page.hasPlan, true);
assert.equal(page.images, 40);

// An older server without extraTokenBalance: the balance still shows.
page = buildUsageLimits({ signedIn: true, entitlements: { tokenBalance: 2000 } });
assert.deepEqual([page.limits.length, page.extraCredits, page.hasPlan], [0, 2000, false]);

// Unlimited licence: no percentage, no bar.
page = buildUsageLimits({ licenseStatus: serverLicense({ unlimited: true, total: null, used: 900, resetsAt: "x" }, "unlimited") });
assert.deepEqual(page.limits, [{ kind: "license", tier: "unlimited", unlimited: true, percent: null, resetsAt: "x" }]);
assert.equal(page.signedIn, false);
assert.equal(page.extraCredits, null, "signed out: no balance");

// Enterprise identity: only the organization pays, so only its budget shows.
page = buildUsageLimits({ signedIn: true, entitlements: { tokenBalance: 5000, plan: maxPlan }, organizationId: "org_1",
  organizationMe: { weeklyBudget: 30000, weeklyUsed: 27000, weeklyResetsAt: "2026-10-04T00:00:00.000Z" } });
assert.deepEqual(page.limits.map((l) => [l.kind, l.percent]), [["organization", 90]]);
assert.equal(page.identity, "organization");
assert.equal(page.extraCredits, null, "the personal balance is not what this work draws on");
page = buildUsageLimits({ signedIn: true, organizationId: "org_1", organizationMe: { weeklyBudget: null, weeklyUsed: 10 } });
assert.equal(page.limits.length, 0, "no weekly budget set: no bar");

// Missing or partial numbers are never drawn.
page = buildUsageLimits({ signedIn: true, entitlements: { tokenBalance: 0, plan: { tier: "pro", weeklyUnits: 10000 } },
  licenseStatus: { source: "offline", valid: true, license: { rawPayload: { credits: { total: 1, used: 1 } } } } });
assert.equal(page.limits.length, 0, "a plan week not issued yet and an offline licence draw nothing");
page = buildUsageLimits({ licenseStatus: { ...serverLicense({ total: 100, used: 5 }), valid: false } });
assert.equal(page.limits.length, 0, "an invalid licence draws nothing");

// The old estimate paths are gone, not hidden.
for (const file of ["src/main/usage-settings.js", "src/main/usage-credits.js", "src/main/usage-cost-estimate.js", "src/renderer/modules/usage-settings.js"]) {
  assert.ok(!fs.existsSync(new URL(`../${file}`, import.meta.url)), `${file} removed`);
}
const html = fs.readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
assert.ok(!html.includes("Usage details start") && html.includes("Usage limits start"), "one usage section: weekly limits");
console.log("usage limits: ok");
