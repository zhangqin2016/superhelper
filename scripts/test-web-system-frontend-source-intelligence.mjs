#!/usr/bin/env node
/**
 * Frontend source learning is intentionally separate from HAR->API inference:
 * static JS bundles are noisy and can be large, but they often contain SPA
 * routes and API-client paths that the read-only crawler did not click. The
 * learner must keep only bounded, reviewable structure and never persist raw
 * bundle source.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import module from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);
const {
  analyzeFrontendSourceFromHar,
  hydrateMissingJavaScriptFromHar,
} = require("../resources/skills-catalog/lily-web-system-learning/scripts/frontend_source_intelligence.cjs");

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const createScript = path.join(ROOT, "resources/skills-catalog/lily-web-system-learning/scripts/create_web_system_skill.cjs");
const finalizerScript = path.join(ROOT, "resources/skills-catalog/lily-web-system-learning/scripts/finalize_web_system_learning.cjs");
const scannerScript = path.join(ROOT, "resources/skills-catalog/lily-web-system-learning/scripts/scan_web_system.py");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-frontend-source-"));

function findPython() {
  for (const candidate of ["python3", "python"]) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }
  return null;
}

try {
  const bundle = [
    "const routes=[{path:'/dashboard'},{path:'/admin/users/:id'}];",
    "fetch('/api/users?status=active');",
    "axios.post('/api/leaves', { days: 1 });",
    "service.patch('/api/users/42/status', { status: 'active' });",
    "request({ url: '/api/reports/export', method: 'POST' });",
    "const secret='raw source must not be persisted';",
  ].join("\n");
  const entries = [
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
  ];
  for (let i = 0; i < 35; i += 1) {
    entries.push({
      _resourceType: "script",
      request: { method: "GET", url: `https://erp.example.com/assets/chunk-${i}.js`, headers: [] },
      response: { status: 200, content: { mimeType: "application/javascript", text: `fetch('/api/chunk-${i}')` } },
    });
  }
  const har = { log: { entries } };

  const sourceMap = analyzeFrontendSourceFromHar(har, "https://erp.example.com", ["example.com"], { maxAssetBytes: 4096 });
  assert(sourceMap.ok === true, "frontend source analysis succeeds");
  assert(sourceMap.assets.length > 25, "large SPA source analysis is not capped at the old 25 asset ceiling");
  assert(sourceMap.coverage.assetCount === sourceMap.assets.length, "coverage counts analyzed JS assets");
  assert(sourceMap.routeHints.some((item) => item.path === "/dashboard"), "SPA route path extracted from JS");
  assert(sourceMap.routeHints.some((item) => item.path === "/admin/users/:id"), "param route path extracted from JS");
  assert(sourceMap.apiHints.some((item) => item.path === "/api/users" && item.methods?.includes("GET")), "fetch API path and default GET method extracted from JS");
  assert(sourceMap.apiHints.some((item) => item.path === "/api/leaves" && item.methods?.includes("POST")), "axios POST API path extracted from JS");
  assert(sourceMap.apiHints.some((item) => item.path === "/api/users/42/status" && item.methods?.includes("PATCH")), "custom service method API path extracted from JS");
  assert(sourceMap.apiHints.some((item) => item.path === "/api/reports/export" && item.methods?.includes("POST")), "object-call API path and method extracted from JS");
  const serialized = JSON.stringify(sourceMap);
  assert(!serialized.includes("raw source must not be persisted"), "raw JS source is not persisted");
  assert(!serialized.includes("/api/steal"), "off-allowlist JS is ignored");

  const protectedServer = http.createServer((req, res) => {
    if (!String(req.headers.cookie || "").includes("sid=abc")) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
    res.writeHead(200, { "content-type": "application/javascript" });
    res.end("fetch('/api/from-protected-js')");
  });
  await new Promise((resolve) => protectedServer.listen(0, "127.0.0.1", resolve));
  try {
    const port = protectedServer.address().port;
    const baseUrl = `http://127.0.0.1:${port}/app`;
    const protectedUrl = `http://127.0.0.1:${port}/assets/protected.js`;
    const storagePath = path.join(tmp, "storage-state.json");
    fs.writeFileSync(storagePath, JSON.stringify({
      cookies: [{ name: "sid", value: "abc", domain: "127.0.0.1", path: "/", secure: false }],
      origins: [],
    }, null, 2));
    const missingBodyHar = { log: { entries: [{
      _resourceType: "script",
      request: { method: "GET", url: protectedUrl, headers: [] },
      response: { status: 200, content: { mimeType: "application/javascript" } },
    }] } };
    const hydrated = await hydrateMissingJavaScriptFromHar(missingBodyHar, baseUrl, ["127.0.0.1"], {
      storageState: storagePath,
      maxAssetBytes: 4096,
    });
    assert(hydrated.fetched === 1, "missing same-domain JS body is fetched with saved browser cookies");
    const protectedSourceMap = analyzeFrontendSourceFromHar(missingBodyHar, baseUrl, ["127.0.0.1"], { maxAssetBytes: 4096 });
    assert(protectedSourceMap.apiHints.some((item) => item.path === "/api/from-protected-js"), "fetched protected JS contributes API hints");
  } finally {
    await new Promise((resolve) => protectedServer.close(resolve));
  }

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

  const python = findPython();
  if (python) {
    const dryRun = spawnSync(python, [
      scannerScript,
      "--base-url", "https://erp.example.com/signin",
      "--allowed-domain", "example.com",
      "--frontend-source", sourcePath,
      "--dry-run",
    ], { cwd: ROOT, encoding: "utf8" });
    assert(dryRun.status === 0, `scanner accepts frontend-source route seeds: ${dryRun.stderr || dryRun.stdout}`);
    const scanPlan = JSON.parse(dryRun.stdout);
    assert(scanPlan.frontendSourceRouteHintCount === 2, "scanner counts all JS route hints");
    assert(scanPlan.frontendSourceSeedUrlCount === 1, "scanner seeds only concrete SPA routes");
    assert(
      scanPlan.seedUrls.includes("https://erp.example.com/dashboard"),
      "scanner queues concrete JS route hints for expanded scans",
    );
    assert(
      !scanPlan.seedUrls.includes("https://erp.example.com/admin/users/:id"),
      "scanner does not visit parameterized route templates directly",
    );
  } else {
    console.warn("frontend-source-intelligence: python not found; scanner dry-run route seed check skipped");
  }

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
  assert(health.coverage.frontendSourceAssetCount === sourceMap.assets.length, "health records source asset coverage");
  assert(health.coverage.frontendSourceRouteHintCount >= 2, "health records route hints from JS");
  assert(health.coverage.frontendSourceApiHintCount >= 4, "health records API hints from JS");
  const apiMap = JSON.parse(fs.readFileSync(path.join(draftDir, "api-map.json"), "utf8"));
  assert(
    apiMap.apiHints.some((item) => item.path === "/api/leaves" && item.methods.includes("POST") && item.executable === false),
    "frontend JS API hints are persisted but not treated as executable contracts",
  );
  assert(health.checks.frontendSourceCoverage === "partial", "health marks source coverage when JS hints exist");
  const profile = JSON.parse(fs.readFileSync(path.join(draftDir, "system-profile.json"), "utf8"));
  assert(profile.files.frontendSourceMap === "frontend-source-map.json", "system profile points to source map artifact");

  const scanPath = path.join(tmp, "scan.json");
  const harPath = path.join(tmp, "scan.har");
  const finalizedOut = path.join(tmp, "finalized");
  fs.writeFileSync(harPath, JSON.stringify(har, null, 2));
  fs.writeFileSync(scanPath, JSON.stringify({
    ok: true,
    schemaVersion: 1,
    mode: "read-only-scan",
    baseUrl: "https://erp.example.com/home",
    allowedDomains: ["example.com"],
    harPath,
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
    "--system-id", "demo-finalized-source",
    "--name", "Demo Finalized Source",
    "--out", finalizedOut,
  ], { cwd: ROOT, encoding: "utf8" });
  assert(finalized.status === 0, `finalizer passes frontend source through: ${finalized.stderr || finalized.stdout}`);
  const finalizedPayload = JSON.parse(finalized.stdout);
  assert(finalizedPayload.frontendSourceAutoGenerated === true, "finalizer auto-generates frontend source from scan.harPath when omitted");
  assert(
    fs.existsSync(path.join(finalizedOut, "demo-finalized-source", "frontend-source-map.json")),
    "finalizer-generated skill persists frontend-source-map.json",
  );

  console.log("PASS: test-web-system-frontend-source-intelligence");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
