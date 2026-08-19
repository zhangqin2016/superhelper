"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");
const {
  LEGAL_KB_SCHEMA_VERSION,
  normalizeArchivePath,
  validateLegalPackManifest,
} = require("./legal-kb-contract");
const {
  legalKnowledgePackRoot,
  legalKnowledgePackStatePath,
  legalKnowledgePackVersionPath,
} = require("./legal-kb-paths");

const PACK_ID = "legal-cn-enterprise";
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 4 * 1024 * 1024 * 1024;
const ALLOWED_FILES = new Set(["manifest.json", "catalog.json", "articles.jsonl", "lineage.json"]);
const activeInstalls = new Map();

function readLegalKnowledgePackState(rootDir = "") {
  try {
    const value = JSON.parse(fs.readFileSync(legalKnowledgePackStatePath(rootDir), "utf8"));
    return value && typeof value === "object" && value.installed && typeof value.installed === "object"
      ? value
      : { schemaVersion: 1, installed: {} };
  } catch {
    return { schemaVersion: 1, installed: {} };
  }
}

function writeJsonAtomic(filePath, value) {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, filePath);
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function assertInside(rootDir, candidate) {
  const root = path.resolve(rootDir);
  const target = path.resolve(candidate);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("LEGAL_KB_PATH_TRAVERSAL");
}

async function readPackManifest(zip) {
  const entry = zip.file("manifest.json");
  if (!entry) throw new Error("LEGAL_KB_MANIFEST_MISSING");
  let manifest;
  try { manifest = JSON.parse(await entry.async("string")); } catch { throw new Error("LEGAL_KB_MANIFEST_CORRUPT"); }
  const result = validateLegalPackManifest({ ...manifest, sha256: "", sizeBytes: 0 });
  if (!result.ok) throw new Error(result.errors.join(","));
  return manifest;
}

async function extractLegalPackArchive(archivePath, targetDir) {
  const bytes = fs.statSync(archivePath).size;
  if (bytes <= 0 || bytes > MAX_ARCHIVE_BYTES) throw new Error("LEGAL_KB_ARCHIVE_TOO_LARGE");
  const zip = await JSZip.loadAsync(fs.readFileSync(archivePath));
  const entries = Object.values(zip.files);
  const files = entries.filter((entry) => !entry.dir);
  const names = new Set();
  let extractedBytes = 0;
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of files) {
    const normalized = normalizeArchivePath(entry.name);
    if (names.has(normalized)) throw new Error("LEGAL_KB_DUPLICATE_ENTRY");
    names.add(normalized);
    if (!ALLOWED_FILES.has(normalized)) throw new Error("LEGAL_KB_UNEXPECTED_ENTRY");
    const outputPath = path.join(targetDir, normalized);
    assertInside(targetDir, outputPath);
    const content = await entry.async("nodebuffer");
    extractedBytes += content.length;
    if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error("LEGAL_KB_EXTRACTED_TOO_LARGE");
    fs.writeFileSync(outputPath, content, { flag: "wx" });
  }
  const manifest = await readPackManifest(zip);
  for (const required of ALLOWED_FILES) {
    if (!fs.existsSync(path.join(targetDir, required))) throw new Error(`LEGAL_KB_FILE_MISSING:${required}`);
  }
  return manifest;
}

function validInstalledPath(record) {
  return Boolean(record?.version && fs.existsSync(record.path || ""));
}

async function runInstall(options = {}) {
  const rootDir = options.rootDir || "";
  const serviceClient = options.serviceClient || require("../service-client");
  const downloadArtifact = options.downloadArtifact || require("../runtime-pack-download").downloadArtifact;
  const resolved = await serviceClient.legalKnowledgePackArtifact("lily-cn-legal-counsel");
  if (!resolved?.ok) return { ok: false, error: resolved?.error || "LEGAL_KB_RESOLVE_FAILED" };
  const artifact = resolved.json?.artifact || resolved.artifact;
  if (!artifact || artifact.packId !== PACK_ID || artifact.characterId !== "lily-cn-legal-counsel") {
    return { ok: false, error: "LEGAL_KB_ARTIFACT_INVALID" };
  }
  const state = readLegalKnowledgePackState(rootDir);
  const installed = state.installed[PACK_ID];
  const installedPath = installed?.path || (installed?.version ? legalKnowledgePackVersionPath(installed.version, rootDir) : "");
  if (!options.force && installed?.version === artifact.version && validInstalledPath({ ...installed, path: installedPath })) {
    return { ok: true, skipped: true, version: installed.version, path: installedPath };
  }
  const root = legalKnowledgePackRoot(rootDir);
  const archivePath = path.join(root, `.${PACK_ID}-${artifact.version}.zip`);
  const partPath = `${archivePath}.part`;
  const stagingPath = path.join(root, `.${PACK_ID}-${process.pid}-${Date.now()}.installing`);
  const targetPath = legalKnowledgePackVersionPath(artifact.version, rootDir);
  fs.mkdirSync(root, { recursive: true });
  try {
    const downloaded = await downloadArtifact({
      url: artifact.url,
      partPath,
      expectedBytes: Number(artifact.sizeBytes || 0),
      maxBytes: MAX_ARCHIVE_BYTES,
      onProgress: options.onProgress,
    });
    if (!downloaded?.ok) return { ok: false, error: downloaded?.error || "LEGAL_KB_DOWNLOAD_FAILED" };
    const actual = sha256File(partPath);
    if (actual !== String(artifact.sha256 || "").toLowerCase()) {
      fs.rmSync(partPath, { force: true });
      return { ok: false, error: "CHECKSUM_MISMATCH" };
    }
    fs.rmSync(stagingPath, { recursive: true, force: true });
    const manifest = await extractLegalPackArchive(partPath, stagingPath);
    if (String(manifest.contentVersion) !== String(artifact.version)) throw new Error("LEGAL_KB_VERSION_MISMATCH");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.rmSync(targetPath, { recursive: true, force: true });
    fs.renameSync(stagingPath, targetPath);
    state.installed[PACK_ID] = {
      packId: PACK_ID,
      version: artifact.version,
      path: targetPath,
      sha256: String(artifact.sha256).toLowerCase(),
      installedAt: new Date().toISOString(),
    };
    writeJsonAtomic(legalKnowledgePackStatePath(rootDir), state);
    fs.rmSync(partPath, { force: true });
    return { ok: true, version: artifact.version, path: targetPath };
  } catch (error) {
    fs.rmSync(stagingPath, { recursive: true, force: true });
    return { ok: false, error: error?.message || String(error), previousPath: validInstalledPath({ ...installed, path: installedPath }) ? installedPath : "" };
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

async function installLegalKnowledgePack(options = {}) {
  const key = path.resolve(legalKnowledgePackRoot(options.rootDir || ""));
  const existing = activeInstalls.get(key);
  if (existing) return { ...(await existing), joined: true };
  const promise = runInstall(options);
  activeInstalls.set(key, promise);
  try { return await promise; } finally { activeInstalls.delete(key); }
}

module.exports = {
  PACK_ID,
  installLegalKnowledgePack,
  readLegalKnowledgePackState,
  extractLegalPackArchive,
};
