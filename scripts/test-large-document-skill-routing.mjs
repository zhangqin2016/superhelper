#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function readSkill(id) {
  return fs.readFileSync(path.join(ROOT, "resources", "skills-catalog", id, "SKILL.md"), "utf8");
}

const runtime = readSkill("lily-runtime-packs");
assert.match(runtime, /large-document/, "runtime skill must expose the large-document dependency pack");
assert.match(runtime, /FFmpeg|ffmpeg/, "runtime skill must keep media dependency routing visible");
const runtimePackManager = fs.readFileSync(
  path.join(ROOT, "resources", "skills-catalog", "lily-runtime-packs", "scripts", "manage_runtime_pack.py"),
  "utf8",
);
assert.match(runtimePackManager, /"large-document"/, "agent-facing runtime pack manager must be able to install large-document");

const office = readSkill("lily-office-intent");
assert.match(office, /inspect/i, "office router must inspect before document work");
assert.match(office, /large file|大文件/i, "office router must call out large-file routing");
assert.match(office, /background|后台/i, "large-file indexing must be non-blocking/background");
assert.match(office, /progress|observable|进度|可观测/i, "large-file work must keep progress observable");
assert.match(office, /Unsupported Document/, "office router must not treat Read PDF failure as document failure");
assert.match(office, /pdfplumber|PyMuPDF/i, "office router must point PDF reads to Lily Python extraction");

const pdf = readSkill("lily-pdf-extraction-router");
assert.match(pdf, /page-level|页级|page index/i, "PDF router must require page-level indexing for long PDFs");
assert.match(pdf, /large-document/, "PDF router must route long or large PDFs to the large-document pack");
assert.match(pdf, /generic `Read` tool/, "PDF router must explicitly avoid generic Read as PDF source of truth");
assert.match(pdf, /Unsupported Document/, "PDF router must recover from Read Unsupported Document");
assert.match(pdf, /pdfplumber|PyMuPDF/i, "PDF router must mention concrete Lily extraction engines");

const excel = readSkill("lily-excel-data-analysis");
assert.match(excel, /duckdb|polars|calamine|fastexcel/i, "Excel analysis must prefer large-data engines for large workbooks");
assert.match(excel, /Do not default to pandas|不要默认.*pandas|禁止.*pandas/i, "Excel analysis must forbid default full pandas reads for large files");

const query = readSkill("lily-document-query");
assert.match(query, /workspace|工作空间/i, "document query must describe workspace-scoped evidence");
assert.match(query, /page|sheet|row|column|页|行|列/i, "document query must preserve structured source references");
assert.match(query, /Unsupported Document/, "document query fallback must not stop at generic Read PDF failure");

const { buildAgentGuideContent } = require("../src/main/skill-manager.js");
const runtimePython = require("../src/main/runtime-python.js");
const originalRuntimeRoot = runtimePython.resolveBundledRuntimeRoot;
try {
  // This is a guide-content test, not a bundled-runtime installation check.
  runtimePython.resolveBundledRuntimeRoot = () => "";
  assert.doesNotMatch(buildAgentGuideContent([], "zh-CN"), /Unsupported Document/,
    "runtime-less development must not claim the bundled document environment exists");
  runtimePython.resolveBundledRuntimeRoot = () => path.join(ROOT, "fixture-runtime-not-executed");
  const globalGuide = buildAgentGuideContent([], "zh-CN");
  assert.match(globalGuide, /Unsupported Document/, "global guide must teach agents that Read can fail on PDFs");
  assert.match(globalGuide, /pdfplumber|PyMuPDF/i, "global guide must route PDF fallback to installed Python capabilities");
} finally {
  runtimePython.resolveBundledRuntimeRoot = originalRuntimeRoot;
}

console.log("large-document-skill-routing: ok");
