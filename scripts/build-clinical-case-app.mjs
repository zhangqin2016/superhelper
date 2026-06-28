#!/usr/bin/env node
// Package the Clinical Case Assistant into an importable .lilyspace.zip.
// Mirrors the layout the installer (apps:install) expects: lily-workspace.json at
// the zip root, all workspace files under files/, conventions.md at the root.
// Deterministic output (fixed timestamps) so the same source → the same artifact.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_ID = "clinical-case-assistant";
const APP_NAME = "临床病例参考助手";
const SOURCE_DIR = path.join(ROOT, "resources", "workspace-apps", APP_ID);
const DEFAULT_OUT_DIR = path.join(ROOT, "dist", "workspace-apps");

const EXCLUDED_DIRS = new Set([".git", ".github", ".claude", "node_modules", "dist", "build", "cases", "__pycache__"]);
const EXCLUDED_FILE_RE = /(^|\/)(\.env|\.npmrc|\.netrc|id_rsa|\.git-credentials)$|\.(key|pem|p12|pfx|crt|cer)$/i;

function parseArgs(argv) {
  const args = { outDir: DEFAULT_OUT_DIR, version: "0.1.0", exportedAt: "2026-06-28T00:00:00.000Z" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out" || a === "--out-dir") args.outDir = path.resolve(argv[++i] || "");
    else if (a === "--version") args.version = argv[++i] || "";
    else if (a === "--exported-at") args.exportedAt = argv[++i] || "";
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function isExcluded(rel, isDir) {
  const segs = rel.split("/");
  if (isDir && segs.some((s) => EXCLUDED_DIRS.has(s))) return true;
  if (segs.some((s) => EXCLUDED_DIRS.has(s))) return true;
  return EXCLUDED_FILE_RE.test(rel);
}

function walkFiles(rootDir, dir = rootDir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(rootDir, full).split(path.sep).join("/");
    if (entry.isDirectory()) { if (!isExcluded(rel, true)) walkFiles(rootDir, full, files); continue; }
    if (!entry.isFile()) continue;
    if (isExcluded(rel, false)) continue;
    if (rel === "lily-workspace.json" || rel === "conventions.md") continue;
    files.push({ full, rel });
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

function conventions() {
  return [
    "# 临床病例参考助手 — 平台约定",
    "",
    "- 本应用面向执业医师,输出为辅助参考、非诊断结论。",
    "- 所有病例数据存于本工作区 `cases/`(已脱敏),不外传。",
    "- 行为规则见 `AGENTS.md`;脚本与说明见 `source/` 与 `README.md`。",
    "",
  ].join("\n");
}

function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

async function build({ outDir, version, exportedAt }) {
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(version)) throw new Error(`invalid version: ${version}`);
  if (!fs.existsSync(SOURCE_DIR)) throw new Error(`source dir not found: ${SOURCE_DIR}`);
  for (const req of ["README.md", "AGENTS.md", "lily-app.json", "source/extract_case.cjs", "source/deidentify.cjs"]) {
    if (!fs.existsSync(path.join(SOURCE_DIR, req))) throw new Error(`missing required app file: ${req}`);
  }

  const files = walkFiles(SOURCE_DIR);
  const zip = new JSZip();
  const fixedDate = new Date("2000-01-01T00:00:00.000Z");
  for (const f of files) {
    zip.file(`files/${f.rel}`, fs.readFileSync(f.full), { createFolders: false, date: fixedDate, unixPermissions: 0o644 });
  }
  zip.file("conventions.md", conventions(), { createFolders: false, date: fixedDate, unixPermissions: 0o644 });

  const manifest = {
    schemaVersion: 1,
    kind: "lily-workspace-app",
    appId: APP_ID,
    name: APP_NAME,
    folderName: APP_ID,
    description: "把住院病案整理成结构化病历,支持问病例与对相似新病人给参考建议(面向执业医师、非诊断、本地运行、数据隔离、PHI 脱敏)。当前聚焦风湿免疫专科。",
    version,
    exportedAt,
    fileCount: files.length + 2, // + lily-workspace.json + conventions.md
    hasConventions: true,
    requiredSkills: [],
    requiredRuntimePacks: [],
    appDataPaths: ["cases/"],
    entry: { type: "workspace", path: "README.md" },
    permissions: { network: true, filesystem: "workspace" },
  };
  zip.file("lily-workspace.json", `${JSON.stringify(manifest, null, 2)}\n`, { createFolders: false, date: fixedDate, unixPermissions: 0o644 });

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 }, platform: "UNIX" });
  fs.mkdirSync(outDir, { recursive: true });
  const artifactPath = path.join(outDir, `${APP_ID}-${version}.lilyspace.zip`);
  fs.writeFileSync(artifactPath, buffer);
  return { appId: APP_ID, version, artifactPath, sha256: sha256(buffer), sizeBytes: buffer.length, fileCount: manifest.fileCount, bundledFiles: files.map((f) => f.rel) };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log("Usage: node scripts/build-clinical-case-app.mjs [--version 0.1.0] [--out dist/workspace-apps]"); process.exit(0); }
const result = await build(args);
console.log(JSON.stringify(result, null, 2));
