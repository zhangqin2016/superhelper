"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { finished } = require("node:stream/promises");
const { userDataPath } = require("./config");
const { statePath, packDir } = require("./runtime-packs");

const DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_RUNTIME_PACK_BYTES = 2 * 1024 * 1024 * 1024;

function platformKey() {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  return `${process.platform}-${arch}`;
}

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    if (raw && typeof raw === "object" && raw.installed && typeof raw.installed === "object") {
      return { schemaVersion: 1, installed: raw.installed };
    }
  } catch {
    // missing state is normal
  }
  return { schemaVersion: 1, installed: {} };
}

function writeState(state) {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function installedRuntimePackIds() {
  return new Set(Object.keys(readState().installed || {}));
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

function safeUrl(value) {
  const parsed = new URL(String(value || ""));
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error("INVALID_RUNTIME_PACK_URL");
  }
  return parsed.toString();
}

async function downloadToFile(url, destPath) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let written = 0;
  try {
    const response = await fetch(safeUrl(url), { signal: controller.signal });
    if (!response.ok) throw new Error(`RUNTIME_PACK_DOWNLOAD_FAILED_${response.status}`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_RUNTIME_PACK_BYTES) throw new Error("RUNTIME_PACK_TOO_LARGE");
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const file = fs.createWriteStream(destPath);
    try {
      for await (const chunk of response.body) {
        written += chunk.length;
        if (written > MAX_RUNTIME_PACK_BYTES) throw new Error("RUNTIME_PACK_TOO_LARGE");
        if (!file.write(chunk)) await new Promise((resolve) => file.once("drain", resolve));
      }
    } finally {
      file.end();
    }
    await finished(file);
  } finally {
    clearTimeout(timer);
  }
}

function extractZip(archivePath, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  if (process.platform === "win32") {
    const psZip = archivePath.replace(/'/g, "''");
    const psDest = targetDir.replace(/'/g, "''");
    execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${psZip}' -DestinationPath '${psDest}' -Force`,
    ], { stdio: "pipe" });
    return;
  }
  execFileSync("unzip", ["-q", "-o", archivePath, "-d", targetDir], { stdio: "pipe" });
}

function extractTarGz(archivePath, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  execFileSync("tar", ["-xzf", archivePath, "-C", targetDir], { stdio: "pipe" });
}

function extractArtifact(archivePath, targetDir, artifact) {
  const format = String(artifact?.format || "").toLowerCase();
  const url = String(artifact?.url || "").toLowerCase();
  if (format === "zip" || url.endsWith(".zip")) {
    extractZip(archivePath, targetDir);
    return "zip";
  }
  extractTarGz(archivePath, targetDir);
  return "tar.gz";
}

async function resolveArtifact(packId) {
  const result = await require("./service-client").runtimePackArtifact(packId, platformKey());
  const artifact = result?.json?.artifact || result?.artifact || null;
  if (!artifact?.url) return { ok: false, error: "NO_RUNTIME_PACK_ARTIFACT" };
  return { ok: true, artifact };
}

async function installRuntimePack(packId) {
  const id = String(packId || "").trim();
  if (!id) return { ok: false, error: "INVALID_RUNTIME_PACK" };
  const existing = readState().installed[id];
  if (existing) return { ok: true, id, skipped: true, version: existing.version || null };

  const resolved = await resolveArtifact(id);
  if (!resolved.ok) return resolved;
  const artifact = resolved.artifact;
  const target = packDir(id);
  const cacheDir = userDataPath("runtime-packs");
  const archivePath = path.join(cacheDir, `.${id}-${Date.now()}.pack`);

  try {
    fs.rmSync(target, { recursive: true, force: true });
    await downloadToFile(artifact.url, archivePath);
    if (artifact.sha256) {
      const actual = sha256File(archivePath);
      if (actual !== String(artifact.sha256).toLowerCase()) {
        fs.rmSync(target, { recursive: true, force: true });
        return { ok: false, error: "CHECKSUM_MISMATCH" };
      }
    }
    const format = extractArtifact(archivePath, target, artifact);
    const state = readState();
    state.installed[id] = {
      installedAt: new Date().toISOString(),
      source: "artifact",
      version: artifact.version || null,
      sha256: artifact.sha256 || null,
      format,
    };
    writeState(state);
    return { ok: true, id, version: artifact.version || null, path: target };
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: false, error: error?.message || String(error) };
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

module.exports = {
  installRuntimePack,
  installedRuntimePackIds,
  platformKey,
};
