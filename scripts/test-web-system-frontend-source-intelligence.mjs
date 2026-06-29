#!/usr/bin/env node
/**
 * Frontend source learning is intentionally separate from HAR->API inference:
 * static JS bundles are noisy and can be large, but they often contain SPA
 * routes and API-client paths that the read-only crawler did not click. The
 * learner must keep only bounded, reviewable structure and never persist raw
 * bundle source.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import module from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);
const {
  analyzeFrontendSourceFromHar,
} = require("../resources/skills-catalog/lily-web-system-learning/scripts/frontend_source_intelligence.cjs");

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const createScript = path.join(ROOT, "resources/skills-catalog/lily-web-system-learning/scripts/create_web_system_skill.cjs");
const finalizerScript = path.join(ROOT, "resources/skills-catalog/lily-web-system-learning/scripts/finalize_web_system_learning.cjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-frontend-source-"));

try {
  const bundle = [
    "const routes=[{path:'/dashboard'},{path:'/admin/users/:id'}];",
    "fetch('/api/users?status=active');",
    "axios.post('/api/leaves', { days: 1 });",
    "const secret='raw source must not be persisted';",
  ].join("\n");
  const har = { log: { entries: [
    {
      _resourceType: "script",
      request: { method: "GET", url: "https://erp.example.com/assets/app.123.js", headers: [] },
      response: { status: 200, content: { mimeType: "application/javascript", text: bundle } },
    },
    {
      _resourceType: "script",
      request: { method: "GET", url: "https://evil.example.net/app.js", headers: [] },
      response: { status: 200, content: { mimeType: "application/javascript", text: "fetch('/api/steal')" } },
    },
    {
      _resourceType: "image",
      request: { method: "GET", url: "https://erp.example.com/logo.png", headers: [] },
      response: { status: 200, content: { mimeType: "image/png", text: "" } },
    },
  ] } };

  const sourceMap = analyzeFrontendSourceFromHar(har, "https://erp.example.com", ["example.com"], { maxAssetBytes: 4096 });
  assert(sourceMap.ok === true, "frontend source analysis succeeds");
  assert(sourceMap.assets.length === 1, "only allowlisted JS assets are analyzed");
  assert(sourceMap.coverage.assetCount === 1, "coverage counts analyzed JS asset");
  assert(sourceMap.routeHints.some((item) => item.path === "/dashboard"), "SPA route path extracted from JS");
  assert(sourceMap.routeHints.some((item) => item.path === "/admin/users/:id"), "param route path extracted from JS");
  assert(sourceMap.apiHints.some((item) => item.path === "/api/users"), "fetch API path extracted from JS");
  assert(sourceMap.apiHints.some((item) => item.path === "/api/leaves"), "axios API path extracted from JS");
  const serialized = JSON.stringify(sourceMap);
  assert(!serialized.includes("raw source must not be persisted"), "raw JS source is not persisted");
  assert(!serialized.includes("/api/steal"), "off-allowlist JS is ignored");

  const specPath = path.join(tmp, "spec.json");
  const sourcePath = path.join(tmp, "frontend-source-map.json");
  const outDir = path.join(tmp, "out");
  fs.writeFileSync(specPath, JSON.stringify({
    id: "demo-erp-source",
    name: "Demo ERP Source",
    systemName: "Demo ERP Source",
    baseUrl: "https://erp.example.com/home",
    allowedDomains: ["example.com"],
    summary: "Demo ERP source-aware learning.",
    actions: [
      { id: "view-dashboard", name: "View dashboard", risk: "read", confirmation: "none", steps: ["Open dashboard."] },
    ],
  }, null, 2));
  fs.writeFileSync(sourcePath, `${JSON.stringify(sourceMap, null, 2)}\n`);

  const result = spawnSync(process.execPath, [
    createScript,
    "--spec", specPath,
    "--frontend-source", sourcePath,
    "--out", outDir,
  ], { cwd: ROOT, encoding: "utf8" });
  assert(result.status === 0, `generator accepts frontend-source map: ${result.stderr || result.stdout}`);

  const draftDir = path.join(outDir, "demo-erp-source");
  assert(fs.existsSync(path.join(draftDir, "frontend-source-map.json")), "frontend-source-map.json is persisted with generated skill");
  assert(fs.existsSync(path.join(draftDir, "scripts/frontend_source_intelligence.cjs")), "source intelligence script ships with generated skill");
  const health = JSON.parse(fs.readFileSync(path.join(draftDir, "health.json"), "utf8"));
  assert(health.coverage.frontendSourceAssetCount === 1, "health records source asset coverage");
  assert(health.coverage.frontendSourceRouteHintCount >= 2, "health records route hints from JS");
  assert(health.checks.frontendSourceCoverage === "partial", "health marks source coverage when JS hints exist");
  const profile = JSON.parse(fs.readFileSync(path.join(draftDir, "system-profile.json"), "utf8"));
  assert(profile.files.frontendSourceMap === "frontend-source-map.json", "system profile points to source map artifact");

  const scanPath = path.join(tmp, "scan.json");
  const finalizedOut = path.join(tmp, "finalized");
  fs.writeFileSync(scanPath, JSON.stringify({
    ok: true,
    schemaVersion: 1,
    mode: "read-only-scan",
    baseUrl: "https://erp.example.com/home",
    allowedDomains: ["example.com"],
    coverage: { pageCount: 1, apiContractCount: 0 },
    pages: [{ url: "https://erp.example.com/home", title: "Home" }],
    actionCandidates: [],
    businessObjects: [],
    apiContracts: [],
    warnings: [],
  }, null, 2));
  const finalized = spawnSync(process.execPath, [
    finalizerScript,
    "--scan", scanPath,
    "--frontend-source", sourcePath,
    "--system-id", "demo-finalized-source",
    "--name", "Demo Finalized Source",
    "--out", finalizedOut,
  ], { cwd: ROOT, encoding: "utf8" });
  assert(finalized.status === 0, `finalizer passes frontend source through: ${finalized.stderr || finalized.stdout}`);
  assert(
    fs.existsSync(path.join(finalizedOut, "demo-finalized-source", "frontend-source-map.json")),
    "finalizer-generated skill persists frontend-source-map.json",
  );

  console.log("PASS: test-web-system-frontend-source-intelligence");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
