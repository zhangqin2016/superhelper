#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DEFAULT_OUT_DIR = path.join(ROOT, "dist", "skill-packs");
const BLOCKED_DIRS = new Set([".git", "node_modules", "dist", "release", ".cache", ".lily-work", "__pycache__"]);
const BLOCKED_FILES = new Set([".DS_Store", "Thumbs.db"]);
const MAX_PACK_BYTES = 50 * 1024 * 1024;

function fail(message) {
  console.error(`[build-skill-pack] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { skillDir: "", outDir: DEFAULT_OUT_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--skill" || arg === "--skill-dir") args.skillDir = argv[++i] || "";
    else if (arg === "--out" || arg === "--out-dir") args.outDir = argv[++i] || "";
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (!args.skillDir && !arg.startsWith("--")) args.skillDir = arg;
    else fail(`unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/build-skill-pack.mjs --skill resources/skills-catalog/<skill-id> [--out dist/skill-packs]",
    "",
    "Builds a .skillpack.zip and prints JSON metadata for server admin / Qiniu upload.",
  ].join(os.EOL);
}

function safeSkillId(value) {
  const id = String(value || "").trim();
  return /^[a-z0-9][a-z0-9._-]{1,120}$/i.test(id) ? id : "";
}

function readManifest(skillDir) {
  const skillMd = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillMd)) fail(`missing SKILL.md in ${skillDir}`);
  const registryPath = path.join(ROOT, "resources", "skills-registry", "registry.json");
  let registryEntry = null;
  if (fs.existsSync(registryPath)) {
    try {
      const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
      registryEntry = (registry.skills || []).find((skill) => skill.id === path.basename(skillDir)) || null;
    } catch {
      registryEntry = null;
    }
  }
  const manifestPath = path.join(skillDir, "skill.manifest.json");
  let manifest = {};
  if (!fs.existsSync(manifestPath)) {
    manifest = {};
  } else {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (error) {
      fail(`invalid skill.manifest.json: ${error.message}`);
    }
  }

  const id = manifest.id || registryEntry?.id || path.basename(skillDir);
  const permissions = manifest.permissions || {};
  const normalized = {
    schemaVersion: 1,
    id,
    name: registryEntry?.name || manifest.name || id,
    description: registryEntry?.description || manifest.description || "",
    version: manifest.version || registryEntry?.latestVersion || "1.0.0",
    minAppVersion: registryEntry?.minAppVersion || manifest.minAppVersion || "0.1.0",
    category: registryEntry?.category || manifest.category || null,
    categoryLabel: registryEntry?.categoryLabel || manifest.categoryLabel || null,
    publisher: registryEntry?.publisher || manifest.publisher || "Lily Workbench",
    capabilityLayer: registryEntry?.capabilityLayer || manifest.capabilityLayer || "tool",
    riskLevel: registryEntry?.riskLevel || manifest.riskLevel || "low",
    permissions: {
      network: Boolean(permissions.network),
      filesystem: permissions.filesystem || "none",
      subprocess: permissions.subprocess || "none",
    },
  };

  for (const key of ["name_i18n", "description_i18n", "guideMd", "guideMd_i18n", "claudeMd"]) {
    if (manifest[key]) normalized[key] = manifest[key];
  }

  return normalized;
}

function collectFiles(rootDir, dir = rootDir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (BLOCKED_FILES.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const rel = path.relative(rootDir, fullPath).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (BLOCKED_DIRS.has(entry.name)) fail(`blocked directory in skill pack: ${rel}`);
      collectFiles(rootDir, fullPath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const size = fs.statSync(fullPath).size;
    if (size > MAX_PACK_BYTES) fail(`file too large for skill pack: ${rel}`);
    files.push({ fullPath, rel, size });
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

async function buildPack({ skillDir, outDir }) {
  const absSkillDir = path.resolve(ROOT, skillDir || "");
  if (!skillDir || !fs.existsSync(absSkillDir) || !fs.statSync(absSkillDir).isDirectory()) {
    fail(`skill directory not found: ${skillDir || "(empty)"}`);
  }

  const manifest = readManifest(absSkillDir);
  const skillId = safeSkillId(manifest.id);
  if (!skillId) fail(`invalid skill id: ${manifest.id}`);
  const version = String(manifest.version || "1.0.0").trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(version)) fail(`invalid version: ${version}`);

  const files = collectFiles(absSkillDir);
  if (!files.some((file) => file.rel === "SKILL.md")) fail("skill pack must include SKILL.md");

  const zip = new JSZip();
  let hasManifest = false;
  for (const file of files) {
    if (file.rel === "skill.manifest.json") {
      hasManifest = true;
    }
    zip.file(file.rel, fs.readFileSync(file.fullPath), {
      date: new Date("2000-01-01T00:00:00.000Z"),
      unixPermissions: 0o644,
    });
  }
  zip.file("skill.manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, {
    date: new Date("2000-01-01T00:00:00.000Z"),
    unixPermissions: 0o644,
  });

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  if (buffer.length > MAX_PACK_BYTES) fail(`skill pack exceeds ${MAX_PACK_BYTES} bytes`);

  fs.mkdirSync(path.resolve(ROOT, outDir), { recursive: true });
  const fileName = `${skillId}-${version}.skillpack.zip`;
  const outPath = path.join(path.resolve(ROOT, outDir), fileName);
  fs.writeFileSync(outPath, buffer);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

  return {
    skillId,
    name: String(manifest.name || skillId),
    version,
    artifactPath: outPath,
    sha256,
    sizeBytes: buffer.length,
    fileCount: hasManifest ? files.length : files.length + 1,
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

const result = await buildPack(args);
console.log(JSON.stringify(result, null, 2));
