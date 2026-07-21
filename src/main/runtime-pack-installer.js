"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { PROJECT_ROOT } = require("./config");
const { downloadArtifact } = require("./runtime-pack-download");
const {
  bundledPackDir,
  effectivePackEntries,
  listBundledRuntimePackDirs,
  packsRoot,
  readInstallStates,
  statePath,
  packDir,
} = require("./runtime-packs");
const { PACK_CATEGORIES, PACK_SPECS } = require("./runtime-pack-specs");

const DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_RUNTIME_PACK_BYTES = 2 * 1024 * 1024 * 1024;
const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const EXTRACT_PROGRESS_INTERVAL_MS = 1000;
const MAX_EXTRACT_ERROR_CHARS = 24_000;
const activeInstalls = new Map();
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

function installedRecordExists(id, rec, root = packsRoot()) {
  if (!rec || typeof rec !== "object") return false;
  if (rec.source === "pip") return true;
  return fs.existsSync(packDir(id, root));
}

function userInstallEntriesById() {
  const entries = new Map();
  for (const entry of effectivePackEntries()) {
    if (entry.source === "bundled") continue;
    if (!entries.has(entry.id)) entries.set(entry.id, entry);
  }
  return entries;
}

function installedRuntimePackIds() {
  const ids = new Set(userInstallEntriesById().keys());
  for (const id of listBundledRuntimePackDirs().keys()) ids.add(id);
  for (const id of baseProvidedRuntimePackMap().keys()) ids.add(id);
  return ids;
}

function installingRuntimePackIds() {
  return new Set(activeInstalls.keys());
}

function detectBasePythonModules(moduleByPackId) {
  const { execFileSync } = require("node:child_process");
  const { resolveVenvPython } = require("./runtime-python");
  const python = resolveVenvPython();
  if (!python || !moduleByPackId.length) return null;
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
    return null;
  }
}

function baseProvidedLibreOffice(provided) {
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
}

function baseModulePairs() {
  return Object.values(PACK_SPECS)
    .filter((spec) => spec.baseModule)
    .map((spec) => [spec.id, spec.baseModule]);
}

function baseProvidedRuntimePackMap() {
  if (baseProvidedCache) return baseProvidedCache;
  const provided = new Map();
  baseProvidedLibreOffice(provided);
  const detected = detectBasePythonModules(baseModulePairs());
  if (!detected) return provided;
  for (const [id] of detected) {
    provided.set(id, { source: "base", path: "", version: null });
  }
  baseProvidedCache = provided;
  return provided;
}

/** Async warm-up for the base-provided cache. The cold path spawns a Python
 *  interpreter for the module probe — execFileSync on the MAIN thread blocked
 *  the event loop for seconds (the startup watchdog's "lag 2827ms"). Callers
 *  that can await (the deferred auto-repair) warm the cache here first, so
 *  every later sync call is a cache hit. */
async function warmBaseProvidedRuntimePacks() {
  if (baseProvidedCache) return baseProvidedCache;
  const provided = new Map();
  baseProvidedLibreOffice(provided);
  const pairs = baseModulePairs();
  const { resolveVenvPython } = require("./runtime-python");
  const python = resolveVenvPython();
  if (python && pairs.length) {
    const code = [
      "import importlib.util, json",
      `items = ${JSON.stringify(pairs)}`,
      "print(json.dumps({pid: importlib.util.find_spec(mod) is not None for pid, mod in items}))",
    ].join("\n");
    try {
      const raw = await new Promise((resolve, reject) => {
        const { execFile } = require("node:child_process");
        execFile(python, ["-c", code], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 },
          (err, stdout) => (err ? reject(err) : resolve(stdout)));
      });
      for (const [id, ok] of Object.entries(JSON.parse(raw))) {
        if (ok) provided.set(id, { source: "base", path: "", version: null });
      }
    } catch {
      // Fail open without poisoning the cache; a later warm runtime can retry.
      return provided;
    }
  }
  baseProvidedCache = provided;
  return provided;
}

/** Strip com.apple.quarantine recursively so the pack's downloaded binaries can
 *  execute during the health check. Best-effort: any failure resolves quietly —
 *  the health check still runs and reports the real state. */
function dequarantineMacPack(dir) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    try {
      const child = spawn("xattr", ["-rd", "com.apple.quarantine", dir], { stdio: "ignore" });
      const timer = setTimeout(done, 20_000);
      child.on("error", () => { clearTimeout(timer); done(); });
      child.on("close", () => { clearTimeout(timer); done(); });
    } catch {
      done();
    }
  });
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

function safeProgressCall(onProgress, progress) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress(progress);
  } catch {
    // Progress must never break installation.
  }
}

function packProgressMeta(id) {
  const spec = PACK_SPECS[id] || {};
  return {
    label: spec.label ? localizeObject(spec.label) : { en: id, "zh-CN": id, ar: id },
    category: spec.category || "other",
    sizeEstimate: spec.sizeEstimate || "",
  };
}

function broadcastRuntimePackProgress(progress) {
  try {
    const { BrowserWindow } = require("electron");
    const windows = typeof BrowserWindow?.getAllWindows === "function" ? BrowserWindow.getAllWindows() : [];
    for (const win of windows) {
      if (typeof win?.isDestroyed === "function" && win.isDestroyed()) continue;
      win?.webContents?.send?.("runtime-packs:progress", progress);
    }
  } catch {
    // Runtime-pack installs also run in tests and headless contexts. Broadcast is optional.
  }
}

function publishRuntimePackProgress(progress) {
  broadcastRuntimePackProgress(progress);
}

function createInstallJob(id, options = {}) {
  const subscribers = new Set();
  const job = {
    id,
    jobId: `runtime_pack_${crypto.randomUUID()}`,
    options,
    latest: null,
    promise: null,
    subscribe(onProgress) {
      if (typeof onProgress !== "function") return () => {};
      subscribers.add(onProgress);
      if (job.latest) safeProgressCall(onProgress, job.latest);
      return () => subscribers.delete(onProgress);
    },
    publish(progress) {
      const enriched = {
        jobId: job.jobId,
        turnId: String(job.options?.turnId || ""),
        ...progress,
      };
      job.latest = enriched;
      for (const onProgress of [...subscribers]) safeProgressCall(onProgress, enriched);
      broadcastRuntimePackProgress(enriched);
    },
  };
  return job;
}

function emitProgress(onProgress, id, phase, detail = {}) {
  safeProgressCall(onProgress, { id, phase, at: new Date().toISOString(), ...detail });
}

function publishProgress(job, id, phase, detail = {}) {
  job.publish({ id, phase, at: new Date().toISOString(), ...packProgressMeta(id), ...detail });
}

function uniqueByCommand(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = candidate.js
      ? `js:${candidate.name}`
      : `${candidate.command}\0${JSON.stringify(candidate.args || [])}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractorSearchDirs() {
  const dirs = [];
  const customDirs = String(process.env.LILY_EXTRACTOR_TOOL_DIRS || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  dirs.push(...customDirs);
  const keys = [platformKey(), process.platform].filter(Boolean);
  const roots = [
    process.resourcesPath ? path.join(process.resourcesPath, "resources", "extractors") : "",
    path.join(PROJECT_ROOT, "resources", "extractors"),
  ].filter(Boolean);
  for (const root of roots) {
    for (const key of keys) dirs.push(path.join(root, key));
    dirs.push(root);
  }
  return [...new Set(dirs)];
}

function bundledExtractorTools(names) {
  const candidates = [];
  for (const dir of extractorSearchDirs()) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) candidates.push(candidate);
    }
  }
  return candidates;
}

function unpackedAsarPath(filePath) {
  const value = String(filePath || "");
  if (!value.includes(".asar")) return value;
  const unpacked = value.replace(".asar", ".asar.unpacked");
  return fs.existsSync(unpacked) ? unpacked : value;
}

function nodeSevenZipTools() {
  try {
    const sevenZipBin = require("7zip-bin");
    const tool = unpackedAsarPath(sevenZipBin?.path7za);
    return tool && fs.existsSync(tool) ? [tool] : [];
  } catch {
    return [];
  }
}

function sevenZipNames() {
  return process.platform === "win32"
    ? ["7zz.exe", "7za.exe", "7zr.exe", "7z.exe"]
    : ["7zz", "7za", "7zr", "7z"];
}

function tarToolNames() {
  return process.platform === "win32"
    ? ["bsdtar.exe", "tar.exe"]
    : ["bsdtar", "tar"];
}

function sevenZipZipCandidate(tool, archivePath, targetDir, source = "bundled") {
  return {
    name: `${source} ${path.basename(tool)}`,
    command: tool,
    args: ["x", "-y", "-aoa", "-bd", `-o${targetDir}`, archivePath],
  };
}

function tarZipCandidate(name, command, archivePath, targetDir) {
  return { name, command, args: ["-xf", archivePath, "-C", targetDir] };
}

function zipExtractorCandidates(archivePath, targetDir) {
  const candidates = [];
  for (const tool of nodeSevenZipTools()) {
    candidates.push(sevenZipZipCandidate(tool, archivePath, targetDir, "7zip-bin"));
  }
  for (const tool of bundledExtractorTools(sevenZipNames())) {
    candidates.push(sevenZipZipCandidate(tool, archivePath, targetDir));
  }
  for (const tool of bundledExtractorTools(tarToolNames())) {
    candidates.push(tarZipCandidate(`bundled ${path.basename(tool)}`, tool, archivePath, targetDir));
  }
  if (process.platform === "darwin") {
    candidates.push({ name: "macOS ditto", command: "ditto", args: ["-x", "-k", archivePath, targetDir] });
    candidates.push({ name: "system unzip", command: "unzip", args: ["-q", "-o", archivePath, "-d", targetDir] });
    candidates.push(tarZipCandidate("system bsdtar", "tar", archivePath, targetDir));
  } else if (process.platform === "win32") {
    candidates.push(tarZipCandidate("Windows bsdtar", "tar", archivePath, targetDir));
    candidates.push({
      name: "PowerShell Expand-Archive",
      command: "powershell",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
        archivePath,
        targetDir,
      ],
    });
  } else {
    candidates.push({ name: "system unzip", command: "unzip", args: ["-q", "-o", archivePath, "-d", targetDir] });
    candidates.push(tarZipCandidate("system tar", "tar", archivePath, targetDir));
  }
  candidates.push({ name: "JSZip fallback", js: true, archivePath, targetDir });
  return uniqueByCommand(candidates);
}

function tarGzExtractorCandidates(archivePath, targetDir) {
  const candidates = [];
  for (const tool of bundledExtractorTools(tarToolNames())) {
    candidates.push({ name: `bundled ${path.basename(tool)}`, command: tool, args: ["-xzf", archivePath, "-C", targetDir] });
  }
  candidates.push({ name: "system tar", command: "tar", args: ["-xzf", archivePath, "-C", targetDir] });
  return uniqueByCommand(candidates);
}

function trimProcessOutput(value) {
  const text = String(value || "");
  if (text.length <= MAX_EXTRACT_ERROR_CHARS) return text;
  return text.slice(-MAX_EXTRACT_ERROR_CHARS);
}

function publishExtractHeartbeat(onProgress, id, candidate, startedAt, detail = {}) {
  emitProgress(onProgress, id, "extracting", {
    backend: candidate.name,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    ...detail,
  });
}

function runExternalExtractor(candidate, options = {}) {
  const { id = "", onProgress } = options;
  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  publishExtractHeartbeat(onProgress, id, candidate, startedAt);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setInterval(() => {
      publishExtractHeartbeat(onProgress, id, candidate, startedAt);
    }, EXTRACT_PROGRESS_INTERVAL_MS);
    const child = spawn(candidate.command, candidate.args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (error) {
        error.extractBackend = candidate.name;
        error.extractOutput = trimProcessOutput(`${stderr}\n${stdout}`.trim());
        reject(error);
        return;
      }
      publishExtractHeartbeat(onProgress, id, candidate, startedAt, { done: true });
      resolve(candidate.name);
    };
    child.stdout?.on("data", (chunk) => {
      stdout = trimProcessOutput(stdout + chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk) => {
      stderr = trimProcessOutput(stderr + chunk.toString("utf8"));
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish(null);
        return;
      }
      const message = `${candidate.name} failed${code === null ? "" : ` with exit ${code}`}${signal ? ` signal ${signal}` : ""}`;
      finish(new Error(message));
    });
  });
}

function assertInsideDirectory(rootDir, filePath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(filePath);
  if (target === root || target.startsWith(`${root}${path.sep}`)) return;
  throw new Error("RUNTIME_PACK_ARCHIVE_PATH_TRAVERSAL");
}

async function extractZipWithJsZip(archivePath, targetDir, options = {}) {
  const { id = "", onProgress } = options;
  const candidate = { name: "JSZip fallback" };
  const startedAt = Date.now();
  const JSZip = require("jszip");
  publishExtractHeartbeat(onProgress, id, candidate, startedAt);
  const data = fs.readFileSync(archivePath);
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files || {});
  const files = entries.filter((entry) => !entry.dir);
  let processed = 0;
  let lastProgressAt = 0;
  for (const entry of entries) {
    const outputPath = path.join(targetDir, entry.name);
    assertInsideDirectory(targetDir, outputPath);
    if (entry.dir) {
      fs.mkdirSync(outputPath, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const content = await entry.async("nodebuffer");
    fs.writeFileSync(outputPath, content);
    processed += 1;
    const now = Date.now();
    if (now - lastProgressAt > 250 || processed >= files.length) {
      lastProgressAt = now;
      publishExtractHeartbeat(onProgress, id, candidate, startedAt, {
        processedEntries: processed,
        totalEntries: files.length,
        currentFile: entry.name,
      });
    }
  }
  return candidate.name;
}

async function extractWithCandidates(candidates, targetDir, options = {}) {
  const failures = [];
  for (const candidate of candidates) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });
    try {
      if (candidate.js) {
        return await extractZipWithJsZip(candidate.archivePath, candidate.targetDir, options);
      }
      return await runExternalExtractor(candidate, options);
    } catch (error) {
      failures.push(`${candidate.name}: ${error?.message || error}${error?.extractOutput ? `\n${error.extractOutput}` : ""}`);
      emitProgress(options.onProgress, options.id || "", "extracting", {
        backend: candidate.name,
        fallback: true,
        error: error?.message || String(error),
      });
    }
  }
  throw new Error(`RUNTIME_PACK_EXTRACT_FAILED\n${failures.join("\n")}`);
}

async function extractArtifact(archivePath, targetDir, artifact, options = {}) {
  const format = String(artifact?.format || "").toLowerCase();
  const url = String(artifact?.url || "").toLowerCase();
  if (format === "zip" || url.endsWith(".zip")) {
    await extractWithCandidates(zipExtractorCandidates(archivePath, targetDir), targetDir, options);
    return "zip";
  }
  await extractWithCandidates(tarGzExtractorCandidates(archivePath, targetDir), targetDir, options);
  return "tar.gz";
}

const { renameWithRetry, rmDirWithRetry, replacePackDirectory } = require("./fs-transient-retry");

function archiveExtensionForArtifact(artifact = {}) {
  const format = String(artifact?.format || "").toLowerCase();
  const url = String(artifact?.url || "").toLowerCase().split("?")[0];
  if (format === "zip" || url.endsWith(".zip")) return ".zip";
  if (format === "tgz" || url.endsWith(".tgz")) return ".tgz";
  return ".tar.gz";
}

async function resolveArtifact(packId) {
  const result = await require("./service-client").runtimePackArtifact(packId, platformKey());
  if (!result?.ok) {
    return {
      ok: false,
      error: result?.error || "SERVICE_REQUEST_FAILED",
      status: result?.status || null,
      detail: result?.detail || null,
    };
  }
  const artifact = result?.json?.artifact || result?.artifact || null;
  if (!artifact?.url) return { ok: false, error: "NO_RUNTIME_PACK_ARTIFACT" };
  return { ok: true, artifact };
}

async function checkRuntimePackAvailability(packIds = []) {
  const ids = (Array.isArray(packIds) && packIds.length ? packIds : Object.keys(PACK_SPECS))
    .map((id) => String(id || "").trim())
    .filter(Boolean);
  const installedIds = installedRuntimePackIds();
  const bundled = listBundledRuntimePackDirs();
  const baseProvided = baseProvidedRuntimePackMap();
  const packs = [];
  for (const id of ids) {
    if (!isValidPackId(id) || !PACK_SPECS[id]) {
      packs.push({ id, available: false, error: "INVALID_RUNTIME_PACK" });
      continue;
    }
    if (installedIds.has(id) || bundled.has(id) || baseProvided.has(id)) {
      packs.push({ id, available: true, installed: true });
      continue;
    }
    try {
      const resolved = await resolveArtifact(id);
      const error = resolved.ok ? null : resolved.error || "NO_RUNTIME_PACK_ARTIFACT";
      packs.push({
        id,
        available: resolved.ok ? true : error === "NO_RUNTIME_PACK_ARTIFACT" ? false : null,
        error,
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

function publicPackFromSpec(spec, userEntry = null, missingRec = null, bundledDir = "", baseRec = null) {
  const rec = userEntry?.record || missingRec || null;
  const userInstalled = Boolean(userEntry);
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
    locationKind: userInstalled ? userEntry.stateKind || "selected" : bundled ? "bundled" : base ? "base" : null,
    path: userInstalled ? userEntry.dir || "" : bundledDir || baseRec?.path || "",
  };
}

function listRuntimePacks() {
  const state = readState();
  const userEntries = userInstallEntriesById();
  const baseProvided = baseProvidedRuntimePackMap();
  const seen = new Set();
  const packs = Object.values(PACK_SPECS).map((spec) => {
    seen.add(spec.id);
    return publicPackFromSpec(spec, userEntries.get(spec.id), state.installed[spec.id], bundledPackDir(spec.id), baseProvided.get(spec.id));
  });
  for (const installState of readInstallStates()) {
    for (const [id, rec] of Object.entries(installState.state.installed || {})) {
      if (seen.has(id)) continue;
      const entry = userEntries.get(id);
      const installed = Boolean(entry);
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
        version: (entry?.record || rec)?.version || null,
        installedAt: (entry?.record || rec)?.installedAt || null,
        source: (entry?.record || rec)?.source || null,
        locationKind: installed ? entry.stateKind || installState.kind || "selected" : installState.kind || null,
        path: installed ? entry.dir || "" : "",
      });
      seen.add(id);
    }
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
      locationKind: "bundled",
      path: dir,
    });
  }
  for (const pack of packs) {
    const job = activeInstalls.get(pack.id);
    if (!job) continue;
    pack.installing = true;
    pack.progress = job.latest || null;
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
  const existingJob = activeInstalls.get(id);
  if (existingJob) {
    const unsubscribe = existingJob.subscribe(options?.onProgress);
    try {
      const result = await existingJob.promise;
      return { ...result, id, joined: true };
    } finally {
      unsubscribe();
    }
  }

  const job = createInstallJob(id, options);
  const unsubscribe = job.subscribe(options?.onProgress);
  activeInstalls.set(id, job);
  job.promise = runRuntimePackInstall(id, job);
  try {
    return await job.promise;
  } finally {
    unsubscribe();
    activeInstalls.delete(id);
  }
}

async function runRuntimePackInstall(id, job) {
  const existing = readState().installed[id];
  const force = Boolean(job?.options?.force || job?.options?.repair);
  if (!force && installedRecordExists(id, existing)) {
    publishProgress(job, id, "skipped", { version: existing.version || null });
    return { ok: true, id, skipped: true, version: existing.version || null, path: packDir(id) };
  }
  const bundled = bundledPackDir(id);
  if (bundled) {
    publishProgress(job, id, "skipped", { source: "bundled", path: bundled });
    return { ok: true, id, skipped: true, source: "bundled", path: bundled };
  }
  const base = baseProvidedRuntimePackMap().get(id);
  if (base) {
    publishProgress(job, id, "skipped", { source: "base", path: base.path || "" });
    return { ok: true, id, skipped: true, source: "base", path: base.path || "" };
  }

  publishProgress(job, id, "resolving", { platform: platformKey() });
  const resolved = await resolveArtifact(id);
  if (!resolved.ok) {
    publishProgress(job, id, "failed", { error: resolved.error || "NO_RUNTIME_PACK_ARTIFACT" });
    return { ...resolved, id };
  }
  const artifact = resolved.artifact;
  const target = packDir(id);
  const cacheDir = packsRoot();
  const installNonce = Date.now();
  const artifactKey = crypto.createHash("sha256")
    .update(`${id}\0${artifact.version || ""}\0${artifact.sha256 || artifact.url}`)
    .digest("hex")
    .slice(0, 20);
  const archivePath = path.join(cacheDir, `.${id}-${artifactKey}.pack${archiveExtensionForArtifact(artifact)}`);
  const partPath = `${archivePath}.part`;
  const stagingPath = path.join(cacheDir, `.${id}-${installNonce}.extracting`);

  try {
    fs.rmSync(stagingPath, { recursive: true, force: true });
    const downloaded = await downloadArtifact({
      url: artifact.url,
      partPath,
      expectedBytes: Number(artifact.sizeBytes || artifact.size || 0),
      maxBytes: MAX_RUNTIME_PACK_BYTES,
      requestTimeoutMs: DOWNLOAD_TIMEOUT_MS,
      onProgress: (progress) => job.publish({
        id,
        phase: "downloading",
        at: new Date().toISOString(),
        ...packProgressMeta(id),
        ...progress,
      }),
    });
    if (!downloaded.ok) {
      publishProgress(job, id, "failed", { error: downloaded.error });
      return { ...downloaded, id };
    }
    fs.rmSync(archivePath, { force: true });
    fs.renameSync(partPath, archivePath);
    if (artifact.sha256) {
      publishProgress(job, id, "verifying", { sha256: String(artifact.sha256).toLowerCase() });
      const actual = sha256File(archivePath);
      if (actual !== String(artifact.sha256).toLowerCase()) {
        fs.rmSync(archivePath, { force: true });
        fs.rmSync(partPath, { force: true });
        publishProgress(job, id, "failed", { error: "CHECKSUM_MISMATCH" });
        return { ok: false, id, error: "CHECKSUM_MISMATCH" };
      }
    }
    publishProgress(job, id, "extracting", { path: target });
    const format = await extractArtifact(archivePath, stagingPath, artifact, {
      id,
      onProgress: (progress) => job.publish({ ...packProgressMeta(id), ...progress, path: target }),
    });
    // macOS marks app-downloaded files with com.apple.quarantine; on Apple
    // Silicon a quarantined native binary is SIGKILLed by Gatekeeper, so the
    // health check (which launches soffice/python/…) fails and every pack reads
    // as "install failed". Strip quarantine before the health check runs.
    if (process.platform === "darwin") {
      await dequarantineMacPack(stagingPath);
    }
    let healthCheckedAt = null;
    if (PACK_SPECS[id]) {
      publishProgress(job, id, "health-checking", { path: stagingPath });
      const health = await require("./runtime-health").checkRuntimePackHealthAtPath(id, stagingPath);
      if (!health.ok) {
        publishProgress(job, id, "failed", { error: "RUNTIME_PACK_HEALTH_FAILED", health });
        return { ok: false, id, error: "RUNTIME_PACK_HEALTH_FAILED", health };
      }
      healthCheckedAt = new Date().toISOString();
    }
    await replacePackDirectory(stagingPath, target);
    const state = readState();
    state.installed[id] = {
      installedAt: new Date().toISOString(),
      source: "artifact",
      version: artifact.version || null,
      sha256: artifact.sha256 || null,
      sizeBytes: Number(artifact.sizeBytes || artifact.size || 0) || null,
      healthCheckedAt,
      format,
    };
    writeState(state);
    publishProgress(job, id, "installed", { version: artifact.version || null, path: target, repaired: force || undefined });
    return { ok: true, id, version: artifact.version || null, path: target, repaired: force || undefined };
  } catch (error) {
    try {
      fs.rmSync(stagingPath, { recursive: true, force: true });
    } catch {
      // Cleanup must not mask the real install error.
    }
    const message = error?.message || String(error);
    publishProgress(job, id, "failed", { error: message });
    return { ok: false, id, error: message };
  } finally {
    // Best-effort ONLY: a throw in finally REPLACES the function's return
    // value, so a locked temp file (Windows AV scanning a fresh archive)
    // would turn an already-successful install — state written, "installed"
    // published — into a bogus "install failed" for the user.
    try {
      fs.rmSync(archivePath, { force: true });
    } catch {}
    try {
      fs.rmSync(stagingPath, { recursive: true, force: true });
    } catch {}
  }
}

async function repairInstalledRuntimePacks(options = {}) {
  const state = readState();
  const ids = (Array.isArray(options.ids) && options.ids.length
    ? options.ids
    : Object.keys(state.installed || {}))
    .map((id) => String(id || "").trim())
    .filter((id) => isValidPackId(id) && installedRecordExists(id, state.installed?.[id]));
  const checkHealth = options.checkHealth || ((id) => require("./runtime-health").checkRuntimePackHealth(id));
  const results = [];
  for (const id of ids) {
    const health = await checkHealth(id);
    if (health?.ok) {
      results.push({ ok: true, id, skipped: true, reason: "healthy" });
      continue;
    }
    // One failed probe is not proof of a broken pack: on Windows the first
    // run of a large binary (LibreOffice cold start under AV scanning) can
    // time out even though the install is intact. Confirm before the
    // expensive re-download — the first probe usually warmed the caches.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const recheck = await checkHealth(id);
    if (recheck?.ok) {
      results.push({ ok: true, id, skipped: true, reason: "healthy-on-recheck" });
      continue;
    }
    const repaired = await installRuntimePack(id, { ...options, force: true, repair: true });
    results.push({ ...repaired, healthBefore: recheck });
  }
  return { ok: results.every((item) => item.ok), results };
}

function uninstallRuntimePack(packId) {
  const id = String(packId || "").trim();
  if (!id || !isValidPackId(id)) return { ok: false, error: "INVALID_RUNTIME_PACK" };
  const state = readState();
  const hasUserPack = installedRecordExists(id, state.installed?.[id]);
  if (!hasUserPack && bundledPackDir(id)) {
    return { ok: false, id, error: "BUNDLED_RUNTIME_PACK_READ_ONLY" };
  }
  // Windows: soffice.exe/python.exe linger after use and lock pack files;
  // an unprotected rmSync throws MID-DELETE, leaving a half-removed pack whose
  // state record still says "installed". Retry transient locks; on persistent
  // failure keep the state record so the UI can offer uninstall again.
  try {
    rmDirWithRetry(packDir(id));
  } catch (err) {
    return { ok: false, id, error: "RUNTIME_PACK_UNINSTALL_FAILED", detail: err?.message || String(err) };
  }
  if (state.installed && Object.prototype.hasOwnProperty.call(state.installed, id)) {
    delete state.installed[id];
    writeState(state);
  }
  return { ok: true, id };
}

module.exports = {
  archiveExtensionForArtifact,
  checkRuntimePackAvailability,
  installRuntimePack,
  repairInstalledRuntimePacks,
  installingRuntimePackIds,
  installedRuntimePackIds,
  baseProvidedRuntimePackMap,
  warmBaseProvidedRuntimePacks,
  listRuntimePacks,
  platformKey,
  publishRuntimePackProgress,
  uninstallRuntimePack,
};
