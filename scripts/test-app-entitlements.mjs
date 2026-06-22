#!/usr/bin/env node
/**
 * Why this matters: VIP/tier gating of workspace apps is an ACCESS-CONTROL
 * boundary. If `planAllows` mis-ranks, a free user sees (and the download gate
 * would admit) a VIP app, or a paying user is locked out of what they bought.
 * These pin the ordering (free < pro < vip), the fail-closed defaults, and that
 * the catalog actually drops apps the viewer's plan can't reach.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { planAllows, planRank, normalizePlan } = await import(
  path.join(ROOT, "server/src/services/entitlements.js")
);
const { buildWorkspaceAppCatalog } = await import(
  path.join(ROOT, "server/src/services/workspace-apps.js")
);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- ordering + fail-closed defaults ----------------------------------------
assert(planRank("vip") > planRank("pro"), "vip must outrank pro");
assert(planRank("pro") > planRank("free"), "pro must outrank free");
assert(planRank("bogus") === 0, "unknown viewer plan must rank as free (fail closed)");
assert(planRank("") === 0 && planRank(null) === 0, "missing plan must rank as free");
assert(planRank("STANDARD") === planRank("pro"), "legacy 'standard' must map to pro tier (case-insensitive)");
assert(normalizePlan("  VIP ") === "vip", "normalizePlan trims + lowercases");

assert(planAllows("free", "free"), "free reaches free");
assert(!planAllows("free", "pro"), "free must NOT reach pro");
assert(!planAllows("free", "vip"), "free must NOT reach vip");
assert(planAllows("pro", "free") && planAllows("pro", "pro"), "pro reaches free+pro");
assert(!planAllows("pro", "vip"), "pro must NOT reach vip");
assert(planAllows("vip", "vip") && planAllows("vip", "pro") && planAllows("vip", "free"), "vip reaches all");
assert(planAllows("vip", "mystery"), "unknown minPlan is treated as free → reachable by anyone");

// --- catalog filtering -------------------------------------------------------
const row = (app_id, min_plan) => ({
  app_id,
  name: app_id,
  summary: app_id,
  version: "1.0.0",
  enabled: true,
  channel: "stable",
  artifact_url: "https://example.com/a.zip",
  sha256: "0".repeat(64),
  min_plan,
  created_at: "2026-01-01T00:00:00.000Z",
});
const rows = [row("free-app", "free"), row("pro-app", "pro"), row("vip-app", "vip")];
const ids = (plan) => buildWorkspaceAppCatalog(rows, { viewerPlan: plan }).apps.map((a) => a.id).sort();

assert(JSON.stringify(ids("free")) === JSON.stringify(["free-app"]), "free viewer sees only free-app");
assert(JSON.stringify(ids("pro")) === JSON.stringify(["free-app", "pro-app"]), "pro viewer sees free+pro");
assert(
  JSON.stringify(ids("vip")) === JSON.stringify(["free-app", "pro-app", "vip-app"]),
  "vip viewer sees all three",
);
assert(JSON.stringify(ids(undefined)) === JSON.stringify(["free-app"]), "no plan defaults to free view");

// each entry exposes its minPlan so the client can filter offline + render a badge
const all = buildWorkspaceAppCatalog(rows, { viewerPlan: "vip" }).apps;
const vip = all.find((a) => a.id === "vip-app");
const free = all.find((a) => a.id === "free-app");
assert(vip.minPlan === "vip", "catalog entry must carry minPlan");
// Gated apps must NOT leak their artifact URL in the catalog — only the signed
// download endpoint hands it out. Free apps keep the inline URL.
assert(vip.gated === true && vip.downloadUrl === null, "gated app must omit downloadUrl in catalog");
assert(free.gated === false && free.downloadUrl === "https://example.com/a.zip", "free app keeps inline downloadUrl");

console.log("app-entitlements: ok");
