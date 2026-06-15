#!/usr/bin/env node
import assert from "node:assert/strict";
import JSZip from "jszip";
process.env.DATABASE_URL ||= "postgres://unused:unused@localhost:5432/unused";

import {
  buildWorkspaceAppCatalog,
  evaluateWorkspaceAppQuality,
  inspectWorkspaceAppArtifact,
  isValidWorkspaceAppArtifactUrl,
  isValidWorkspaceAppSha256,
  newestWorkspaceApps,
  validateWorkspaceAppArtifact,
  workspaceAppObjectKey,
} from "../server/src/services/workspace-apps.js";

assert.equal(isValidWorkspaceAppArtifactUrl("https://cdn.example.com/app.zip"), true);
assert.equal(isValidWorkspaceAppArtifactUrl("http://cdn.example.com/app.zip"), false);
assert.equal(isValidWorkspaceAppArtifactUrl("not a url"), false);

assert.equal(isValidWorkspaceAppSha256("a".repeat(64)), true);
assert.equal(isValidWorkspaceAppSha256("abc"), false);

const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const validArtifact = validateWorkspaceAppArtifact({
  buffer: zipBytes,
  fileName: "stock-dashboard.zip",
});
assert.equal(validArtifact.ok, true);
assert.equal(validArtifact.sizeBytes, zipBytes.length);
assert.equal(
  validateWorkspaceAppArtifact({ buffer: Buffer.from("plain"), fileName: "stock-dashboard.html" }).code,
  "INVALID_WORKSPACE_APP_NAME",
);
assert.equal(
  validateWorkspaceAppArtifact({ buffer: Buffer.from("plain"), fileName: "stock-dashboard.zip" }).code,
  "INVALID_WORKSPACE_APP_ZIP",
);

const validZip = new JSZip();
validZip.file("lily-workspace.json", JSON.stringify({
  kind: "lily-workspace-pack",
  schemaVersion: 1,
  name: "Stock Dashboard",
  requiredSkills: ["lily-research-synthesis"],
  requiredRuntimePacks: ["pro-pdf"],
}));
validZip.file("files/README.md", "# Stock Dashboard\n");
const validZipBuffer = await validZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
const inspected = await inspectWorkspaceAppArtifact(validZipBuffer);
assert.equal(inspected.ok, true);
assert.equal(inspected.manifest.name, "Stock Dashboard");
assert.deepEqual(inspected.manifest.requiredSkills, ["lily-research-synthesis"]);
assert.deepEqual(inspected.manifest.requiredRuntimePacks, ["pro-pdf"]);

const emptyWorkspaceZip = new JSZip();
emptyWorkspaceZip.file("lily-workspace.json", JSON.stringify({
  kind: "lily-workspace-app",
  schemaVersion: 1,
  name: "Empty App",
}));
emptyWorkspaceZip.file("source/README.md", "# This is not under files/\n");
assert.equal(
  (await inspectWorkspaceAppArtifact(await emptyWorkspaceZip.generateAsync({ type: "nodebuffer" }))).code,
  "WORKSPACE_APP_FILES_MISSING",
  "workspace app artifacts must contain at least one files/ entry so installs cannot create empty folders",
);

const plainZip = new JSZip();
plainZip.file("README.md", "plain zip");
assert.equal(
  (await inspectWorkspaceAppArtifact(await plainZip.generateAsync({ type: "nodebuffer" }))).code,
  "WORKSPACE_APP_MANIFEST_MISSING",
);

const futureZip = new JSZip();
futureZip.file("lily-workspace.json", JSON.stringify({ kind: "lily-workspace-app", schemaVersion: 99 }));
assert.equal(
  (await inspectWorkspaceAppArtifact(await futureZip.generateAsync({ type: "nodebuffer" }))).code,
  "WORKSPACE_APP_SCHEMA_TOO_NEW",
);

assert.equal(
  workspaceAppObjectKey({
    appId: "stock dashboard",
    version: "1.0.0",
    fileName: "stock dashboard.zip",
    id: "app_test",
  }),
  "workspace-apps/stock-dashboard/1.0.0/app_test-stock-dashboard.zip",
);

const rows = [
  {
    app_id: "stock-dashboard",
    name: "Stock Dashboard",
    summary: "Analyze stock fundamentals, valuation, news, and risk in one workspace app.",
    version: "1.0.0",
    artifact_url: "https://cdn.example.com/stock-dashboard-1.zip",
    sha256: "a".repeat(64),
    enabled: true,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: ["stocks"],
    required_runtime_packs: ["quant-runtime"],
    required_skill_packages: ["lily-research-synthesis"],
  },
  {
    app_id: "stock-dashboard",
    name: "Stock Dashboard",
    summary: "Analyze stock fundamentals, valuation, news, and risk in one workspace app.",
    version: "1.1.0",
    category: "finance",
    app_type: "dashboard",
    artifact_url: "https://cdn.example.com/stock-dashboard-1.1.zip",
    sha256: "b".repeat(64),
    enabled: true,
    featured: true,
    risk_level: "medium",
    created_at: "2026-01-02T00:00:00.000Z",
    tags: ["stocks", "research"],
    required_runtime_packs: ["quant-runtime"],
    required_skill_packages: ["lily-research-synthesis"],
  },
  {
    app_id: "hidden-app",
    name: "Hidden",
    summary: "Hidden disabled app should not be visible in the public catalog.",
    version: "9.0.0",
    artifact_url: "https://cdn.example.com/hidden.zip",
    sha256: "c".repeat(64),
    enabled: false,
    created_at: "2026-01-03T00:00:00.000Z",
  },
];

const newest = newestWorkspaceApps(rows);
assert.equal(newest.length, 1, "disabled apps must not enter the public catalog");
assert.equal(newest[0].version, "1.1.0", "catalog must publish newest enabled app per app id");

const catalog = buildWorkspaceAppCatalog(rows, { catalogUrl: "https://service.example.com/api/apps/catalog" });
assert.equal(catalog.schemaVersion, 1);
assert.equal(catalog.catalogUrl, "https://service.example.com/api/apps/catalog");
assert.equal(catalog.apps.length, 1);
assert.equal(catalog.apps[0].id, "stock-dashboard");
assert.equal(catalog.apps[0].sourceType, "zip");
assert.equal(catalog.apps[0].downloadUrl, "https://cdn.example.com/stock-dashboard-1.1.zip");
assert.equal(catalog.apps[0].sha256, "b".repeat(64));
assert.equal(catalog.apps[0].category, "finance");
assert.equal(catalog.apps[0].appType, "dashboard");
assert.equal(catalog.apps[0].featured, true);
assert.deepEqual(catalog.apps[0].tags, ["stocks", "research"]);

const highQualityInput = {
  appId: "stock-research-dashboard",
  name: "Stock Research Dashboard",
  summary: "输入股票代码，生成行情、财报、估值、新闻和风险摘要。",
  description: "这个应用面向普通投资者和投研人员，输入股票代码后聚合公开信息，输出基本面、估值区间、新闻风险和可解释的检查清单，不提供自动下单。",
  version: "1.0.0",
  category: "finance",
  appType: "dashboard",
  entryKind: "zip",
  sourceKind: "lily",
  artifactUrl: "https://cdn.example.com/stock-research-dashboard.zip",
  sha256: "d".repeat(64),
  riskLevel: "low",
  featured: true,
};
const highQuality = evaluateWorkspaceAppQuality(highQualityInput);
assert.equal(highQuality.ok, true, `high-quality app should pass: ${highQuality.issues.join(", ")}`);

const highRiskFeatured = evaluateWorkspaceAppQuality({
  ...highQualityInput,
  riskLevel: "high",
});
assert.equal(highRiskFeatured.ok, false);
assert.equal(
  highRiskFeatured.issues.some((issue) => issue.includes("High-risk")),
  true,
);

const externalFeatured = evaluateWorkspaceAppQuality({
  ...highQualityInput,
  sourceKind: "external",
});
assert.equal(externalFeatured.ok, false);
assert.equal(
  externalFeatured.issues.some((issue) => issue.includes("Lily-reviewed")),
  true,
);

console.log("workspace-apps: ok");
