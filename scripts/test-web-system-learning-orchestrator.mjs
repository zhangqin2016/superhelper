import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const skillDir = path.join(ROOT, "resources/skills-catalog/lily-web-system-learning");
const orchestrator = path.join(skillDir, "scripts/learn_web_system.cjs");

if (!fs.existsSync(orchestrator)) {
  throw new Error("learn_web_system.cjs missing");
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-web-orchestrator-"));
const sessionPath = path.join(tmp, "session.json");
const workDir = path.join(tmp, "work");
const outDir = path.join(tmp, "draft");

const result = spawnSync(
  process.execPath,
  [
    orchestrator,
    "--base-url", "https://oa.example.com/app",
    "--allow-domain", "oa.example.com",
    "--storage-state", sessionPath,
    "--system-id", "demo-oa",
    "--name", "Demo OA",
    "--work-dir", workDir,
    "--out", outDir,
    "--max-pages", "80",
    "--plan-only",
  ],
  { encoding: "utf8" },
);

if (result.status !== 0) {
  throw new Error(result.stderr || result.stdout || "learn_web_system.cjs --plan-only failed");
}

const plan = JSON.parse(result.stdout);
if (plan.kind !== "web-system-learning-plan") throw new Error("orchestrator returned the wrong plan kind");
if (plan.workDir !== workDir) throw new Error("orchestrator did not preserve the requested work dir");
if (!plan.guarantees.includes("single-default-learning-entrypoint")) {
  throw new Error("orchestrator plan must declare a single default learning entrypoint");
}
if (!plan.guarantees.includes("coverage-closure-until-stable")) {
  throw new Error("orchestrator plan must declare a coverage-closure guard");
}
if (
  plan.coverageClosure?.enabled !== true ||
  plan.coverageClosure?.maxPasses !== 3 ||
  plan.coverageClosure?.stablePasses !== 2 ||
  !String(plan.coverageClosure?.manifest || "").endsWith("coverage-closure.json")
) {
  throw new Error(`orchestrator must plan bounded multi-pass coverage closure: ${JSON.stringify(plan.coverageClosure)}`);
}

const phases = new Map(plan.phases.map((phase) => [phase.id, phase]));
for (const id of [
  "authPrecondition",
  "contractDiscovery",
  "bootstrapScan",
  "frontendSource",
  "expandedScan",
  "harContractsBootstrap",
  "harContractsExpanded",
  "coverageClosure",
  "authRecipe",
  "finalize",
]) {
  if (!phases.has(id)) throw new Error(`orchestrator missing phase: ${id}`);
}

function commandText(id) {
  return phases.get(id).command.join(" ");
}

if (!commandText("contractDiscovery").includes("discover_contracts.cjs")) {
  throw new Error("contract discovery must be the first real evidence phase");
}
if (!commandText("bootstrapScan").includes("scan_web_system.py") || !commandText("bootstrapScan").includes("--har-path")) {
  throw new Error("bootstrap scan must capture a HAR");
}
if (!commandText("frontendSource").includes("frontend_source_intelligence.cjs") || !commandText("frontendSource").includes("--storage-state")) {
  throw new Error("frontend source learning must use the saved storage state");
}
if (!commandText("expandedScan").includes("--frontend-source") || !commandText("expandedScan").includes("frontend-source-map.json")) {
  throw new Error("expanded scan must be seeded from frontend source hints");
}
if (!commandText("harContractsBootstrap").includes("har_to_contracts.cjs") || !commandText("harContractsExpanded").includes("har_to_contracts.cjs")) {
  throw new Error("orchestrator must merge observed HAR traffic into contracts");
}
if (!commandText("authRecipe").includes("learn_auth_recipe.cjs") || !commandText("authRecipe").includes("--har")) {
  throw new Error("orchestrator must learn an auth recipe from captured traffic");
}
if (!commandText("finalize").includes("finalize_web_system_learning.cjs")) {
  throw new Error("orchestrator must finish with the deterministic finalizer");
}

const skillMarkdown = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
if (!skillMarkdown.includes("scripts/learn_web_system.cjs")) {
  throw new Error("SKILL.md must make learn_web_system.cjs the default professional entrypoint");
}
if (!skillMarkdown.includes("Do not use ad-hoc here-docs")) {
  throw new Error("SKILL.md must forbid ad-hoc browser probes as the normal learning path");
}

console.log("web-system-learning-orchestrator: ok");
