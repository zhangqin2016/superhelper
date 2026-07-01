"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { finished } = require("node:stream/promises");
const { userDataPath } = require("./config");
const {
  bundledPackDir,
  listBundledRuntimePackDirs,
  statePath,
  packDir,
} = require("./runtime-packs");
const { PACK_CATEGORIES, PACK_SPECS } = require("./runtime-pack-specs");

const DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_RUNTIME_PACK_BYTES = 2 * 1024 * 1024 * 1024;
const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const activeInstalls = new Set();
let baseProvidedCache = null;

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

function isValidPackId(id) {
  return PACK_ID_RE.test(String(id || ""));
}

function installedRecordExists(id, rec) {
  if (!rec || typeof rec !== "object") return false;
  if (rec.source === "pip") return true;
  return fs.existsSync(packDir(id));
}

function installedRuntimePackIds() {
  const state = readState();
  const ids = new Set(
    Object.entries(state.installed || {})
      .filter(([id, rec]) => installedRecordExists(id, rec))
      .map(([id]) => id),
  );
  for (const id of listBundledRuntimePackDirs().keys()) ids.add(id);
  for (const id of baseProvidedRuntimePackMap().keys()) ids.add(id);
  return ids;
}

function detectBasePythonModules(moduleByPackId) {
  const { execFileSync } = require("node:child_process");
  const { resolveVenvPython } = require("./runtime-python");
  const python = resolveVenvPython();
  if (!python || !moduleByPackId.length) return new Map();
  const code = [
    "import importlib.util, json",
    `items = ${JSON.stringify(moduleByPackId)}`,
    "print(json.dumps({pid: importlib.util.find_spec(mod) is not None for pid, mod in items}))",
  ].join("\n");
  try {
    const raw = execFileSync(python, ["-c", code], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return new Map(Object.entries(JSON.parse(raw)).filter(([, ok]) => ok));
  } catch {
    return new Map();
  }
}

function baseProvidedRuntimePackMap() {
  if (baseProvidedCache) return baseProvidedCache;
  const provided = new Map();
  try {
    const env = require("./runtime-python").getRuntimeEnvExtras();
    const dir = env.LILY_LIBREOFFICE_PROGRAM || "";
    const exe = dir ? path.join(dir, process.platform === "win32" ? "soffice.exe" : "soffice") : "";
    if (exe && fs.existsSync(exe)) {
      provided.set("libreoffice", { source: "base", path: dir, version: null });
    }
  } catch {
    // Base runtime probing is best-effort; explicit dependency packs still work.
  }
  const modulePairs = Object.values(PACK_SPECS)
    .filter((spec) => spec.baseModule)
    .map((spec) => [spec.id, spec.baseModule]);
  for (const [id] of detectBasePythonModules(modulePairs)) {
    provided.set(id, { source: "base", path: "", version: null });
  }
  baseProvidedCache = provided;
  return provided;
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

function emitProgress(onProgress, id, phase, detail = {}) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress({ id, phase, at: new Date().toISOString(), ...detail });
  } catch {
    // Progress must never break installation.
  }
}

async function downloadToFile(url, destPath, options = {}) {
  const { id = "", onProgress } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let written = 0;
  let lastProgressAt = 0;
  try {
    const response = await fetch(safeUrl(url), { signal: controller.signal });
    if (!response.ok) throw new Error(`RUNTIME_PACK_DOWNLOAD_FAILED_${response.status}`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_RUNTIME_PACK_BYTES) throw new Error("RUNTIME_PACK_TOO_LARGE");
    emitProgress(onProgress, id, "downloading", { writtenBytes: 0, totalBytes: length || null });
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const file = fs.createWriteStream(destPath);
    try {
      for await (const chunk of response.body) {
        written += chunk.length;
        if (written > MAX_RUNTIME_PACK_BYTES) throw new Error("RUNTIME_PACK_TOO_LARGE");
        if (!file.write(chunk)) await new Promise((resolve) => file.once("drain", resolve));
        const now = Date.now();
        if (now - lastProgressAt > 250 || (length && written >= length)) {
          lastProgressAt = now;
          emitProgress(onProgress, id, "downloading", { writtenBytes: written, totalBytes: length || null });
        }
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

async function checkRuntimePackAvailability(packIds = []) {
  const ids = (Array.isArray(packIds) && packIds.length ? packIds : Object.keys(PACK_SPECS))
    .map((id) => String(id || "").trim())
    .filter(Boolean);
  const state = readState();
  const bundled = listBundledRuntimePackDirs();
  const baseProvided = baseProvidedRuntimePackMap();
  const packs = [];
  for (const id of ids) {
    if (!isValidPackId(id) || !PACK_SPECS[id]) {
      packs.push({ id, available: false, error: "INVALID_RUNTIME_PACK" });
      continue;
    }
    if (installedRecordExists(id, state.installed[id]) || bundled.has(id) || baseProvided.has(id)) {
      packs.push({ id, available: true, installed: true });
      continue;
    }
    try {
      const resolved = await resolveArtifact(id);
      packs.push({
        id,
        available: Boolean(resolved.ok),
        error: resolved.ok ? null : resolved.error || "NO_RUNTIME_PACK_ARTIFACT",
        artifact: resolved.ok
          ? {
              version: resolved.artifact?.version || null,
              sizeBytes: resolved.artifact?.sizeBytes || resolved.artifact?.size || null,
            }
          : null,
      });
    } catch (error) {
      packs.push({ id, available: null, error: error?.message || "RUNTIME_PACK_AVAILABILITY_FAILED" });
    }
  }
  return { ok: true, platform: platformKey(), packs };
}

function localizeObject(value) {
  if (!value || typeof value !== "object") return {};
  return { ...value };
}

function publicPackFromSpec(spec, rec, bundledDir = "", baseRec = null) {
  const userInstalled = installedRecordExists(spec.id, rec);
  const bundled = Boolean(bundledDir);
  const base = Boolean(baseRec);
  const installed = userInstalled || bundled || base;
  return {
    id: spec.id,
    category: spec.category || "common",
    installKind: spec.installKind || "artifact",
    recommended: Boolean(spec.recommended),
    label: localizeObject(spec.label),
    description: localizeObject(spec.description),
    sizeEstimate: spec.sizeEstimate || "",
    installed,
    bundled,
    base,
    readOnly: (bundled || base) && !userInstalled,
    missingFiles: Boolean(rec && !userInstalled && !bundled),
    version: rec?.version || baseRec?.version || null,
    installedAt: rec?.installedAt || null,
    source: userInstalled ? rec?.source || null : bundled ? "bundled" : base ? "base" : null,
    path: userInstalled ? packDir(spec.id) : bundledDir || baseRec?.path || "",
  };
}

function listRuntimePacks() {
  const state = readState();
  const baseProvided = baseProvidedRuntimePackMap();
  const seen = new Set();
  const packs = Object.values(PACK_SPECS).map((spec) => {
    seen.add(spec.id);
    return publicPackFromSpec(spec, state.installed[spec.id], bundledPackDir(spec.id), baseProvided.get(spec.id));
  });
  for (const [id, rec] of Object.entries(state.installed || {})) {
    if (seen.has(id)) continue;
    const installed = installedRecordExists(id, rec);
    packs.push({
      id,
      category: "other",
      installKind: "artifact",
      recommended: false,
      label: { en: id, "zh-CN": id, ar: id },
      description: {
        en: "Installed dependency package that is not in this app version's catalog.",
        "zh-CN": "当前应用版本目录中没有的已安装依赖包。",
        ar: "حزمة تبعية مثبتة غير موجودة في كتالوج هذا الإصدار.",
      },
      sizeEstimate: "",
      installed,
      missingFiles: Boolean(rec && !installed),
      version: rec?.version || null,
      installedAt: rec?.installedAt || null,
      source: rec?.source || null,
      path: installed ? packDir(id) : "",
    });
    seen.add(id);
  }
  for (const [id, dir] of listBundledRuntimePackDirs()) {
    if (seen.has(id)) continue;
    packs.push({
      id,
      category: "other",
      installKind: "artifact",
      recommended: false,
      label: { en: id, "zh-CN": id, ar: id },
      description: {
        en: "Dependency package shipped with this app version.",
        "zh-CN": "当前应用版本随包提供的依赖包。",
        ar: "حزمة تبعية مرفقة مع هذا الإصدار.",
      },
      sizeEstimate: "",
      installed: true,
      bundled: true,
      readOnly: true,
      missingFiles: false,
      version: null,
      installedAt: null,
      source: "bundled",
      path: dir,
    });
  }
  return {
    ok: true,
    platform: platformKey(),
    categories: PACK_CATEGORIES.map((category) => ({ ...category, label: localizeObject(category.label) })),
    packs,
  };
}

async function installRuntimePack(packId, options = {}) {
  const id = String(packId || "").trim();
  if (!id) return { ok: false, error: "INVALID_RUNTIME_PACK" };
  if (!isValidPackId(id)) return { ok: false, error: "INVALID_RUNTIME_PACK" };
  if (activeInstalls.has(id)) return { ok: false, id, error: "INSTALL_IN_PROGRESS" };

  activeInstalls.add(id);
  const onProgress = options?.onProgress;
  try {
    const existing = readState().installed[id];
    if (installedRecordExists(id, existing)) {
      emitProgress(onProgress, id, "skipped", { version: existing.version || null });
      return { ok: true, id, skipped: true, version: existing.version || null, path: packDir(id) };
    }
    const bundled = bundledPackDir(id);
    if (bundled) {
      emitProgress(onProgress, id, "skipped", { source: "bundled", path: bundled });
      return { ok: true, id, skipped: true, source: "bundled", path: bundled };
    }
    const base = baseProvidedRuntimePackMap().get(id);
    if (base) {
      emitProgress(onProgress, id, "skipped", { source: "base", path: base.path || "" });
      return { ok: true, id, skipped: true, source: "base", path: base.path || "" };
    }

    emitProgress(onProgress, id, "resolving", { platform: platformKey() });
    const resolved = await resolveArtifact(id);
    if (!resolved.ok) {
      emitProgress(onProgress, id, "failed", { error: resolved.error || "NO_RUNTIME_PACK_ARTIFACT" });
      return { ...resolved, id };
    }
    const artifact = resolved.artifact;
    const target = packDir(id);
    const cacheDir = userDataPath("runtime-packs");
    const archivePath = path.join(cacheDir, `.${id}-${Date.now()}.pack`);

    try {
      fs.rmSync(target, { recursive: true, force: true });
      await downloadToFile(artifact.url, archivePath, { id, onProgress });
      if (artifact.sha256) {
        emitProgress(onProgress, id, "verifying", { sha256: String(artifact.sha256).toLowerCase() });
        const actual = sha256File(archivePath);
        if (actual !== String(artifact.sha256).toLowerCase()) {
          fs.rmSync(target, { recursive: true, force: true });
          emitProgress(onProgress, id, "failed", { error: "CHECKSUM_MISMATCH" });
          return { ok: false, id, error: "CHECKSUM_MISMATCH" };
        }
      }
      emitProgress(onProgress, id, "extracting", { path: target });
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
      emitProgress(onProgress, id, "installed", { version: artifact.version || null, path: target });
      return { ok: true, id, version: artifact.version || null, path: target };
    } catch (error) {
      fs.rmSync(target, { recursive: true, force: true });
      const message = error?.message || String(error);
      emitProgress(onProgress, id, "failed", { error: message });
      return { ok: false, id, error: message };
    } finally {
      fs.rmSync(archivePath, { force: true });
    }
  } finally {
    activeInstalls.delete(id);
  }
}

function uninstallRuntimePack(packId) {
  const id = String(packId || "").trim();
  if (!id || !isValidPackId(id)) return { ok: false, error: "INVALID_RUNTIME_PACK" };
  const state = readState();
  const hasUserPack = installedRecordExists(id, state.installed?.[id]);
  if (!hasUserPack && bundledPackDir(id)) {
    return { ok: false, id, error: "BUNDLED_RUNTIME_PACK_READ_ONLY" };
  }
  fs.rmSync(packDir(id), { recursive: true, force: true });
  if (state.installed && Object.prototype.hasOwnProperty.call(state.installed, id)) {
    delete state.installed[id];
    writeState(state);
  }
  return { ok: true, id };
}

module.exports = {
  checkRuntimePackAvailability,
  installRuntimePack,
  installedRuntimePackIds,
  baseProvidedRuntimePackMap,
  listRuntimePacks,
  platformKey,
  uninstallRuntimePack,
};
