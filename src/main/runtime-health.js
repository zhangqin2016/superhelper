"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { pathToFileURL } = require("node:url");
const { PACK_SPECS } = require("./runtime-pack-specs");

const pexecFile = promisify(execFile);
// Windows gets a much longer budget: first-run executables (fresh extract)
// are synchronously scanned by Defender/AV, so a 20s cap produced false
// "unhealthy" verdicts on intact installs — which the startup auto-repair
// then "fixed" with a full re-download that failed the same probe again.
const CHECK_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 20_000;
// LibreOffice is the heaviest binary (~333MB): the first cold headless launch
// (fresh profile + hundreds of dylibs + first-run Gatekeeper verification) can
// run long on a loaded Mac — the same class of one-time cold-start cost that
// timed rembg out. Give mac a comfortable ceiling instead of the tight 45s.
const LIBREOFFICE_CHECK_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 90_000;
// A heavy pack's FIRST `import` after a fresh install compiles thousands of .pyc
// and initializes native runtimes (numba/onnxruntime): rembg cold-imports in
// ~35s, far past the 20s CHECK_TIMEOUT_MS, so its health check timed out and the
// install was (intermittently, once .pyc cached) marked failed. This one-time
// install-time probe can afford a generous ceiling.
const PYTHON_PROBE_TIMEOUT_MS = process.platform === "win32" ? 180_000 : 120_000;

const REQUIRED_BASE_PYTHON_MODULES = [
  { id: "pandas", module: "pandas" },
  { id: "numpy", module: "numpy" },
  { id: "openpyxl", module: "openpyxl" },
  { id: "xlsxwriter", module: "xlsxwriter" },
  { id: "python-docx", module: "docx" },
  { id: "python-pptx", module: "pptx" },
  { id: "pdfplumber", module: "pdfplumber" },
  { id: "pypdfium2", module: "pypdfium2" },
  { id: "pypdf", module: "pypdf" },
  { id: "markitdown", module: "markitdown" },
  { id: "docxtpl", module: "docxtpl" },
  { id: "playwright-python", module: "playwright" },
];

const OPTIONAL_BASE_PYTHON_MODULES = [
  { id: "pillow", module: "PIL", required: false },
  { id: "opencv", module: "cv2", required: false },
  { id: "rapidocr", module: "rapidocr_onnxruntime", required: false },
  { id: "onnxruntime", module: "onnxruntime", required: false },
  { id: "mammoth", module: "mammoth", required: false },
];

function basePythonModulePolicy() {
  return {
    required: REQUIRED_BASE_PYTHON_MODULES.map((item) => ({ ...item, required: true })),
    optional: OPTIONAL_BASE_PYTHON_MODULES.map((item) => ({ ...item })),
  };
}

function okCheck(id, detail = {}) {
  return { id, ok: true, status: "ok", ...detail };
}

function failedCheck(id, error, detail = {}) {
  return { id, ok: false, status: "failed", error: String(error || "FAILED"), ...detail };
}

function missingCheck(id, error = "MISSING", detail = {}) {
  return { id, ok: false, status: "missing", error, ...detail };
}

/** Turn an execFile rejection into a meaningful reason. execFile's `error.message`
 *  is only "Command failed: <cmd>" — the ACTUAL cause (Python ImportError, a
 *  disallowed library load, a numpy/numba version mismatch, or a timeout) lives in
 *  `error.stderr`, which was being discarded. Surface the traceback tail (and flag
 *  timeouts) so a failed health check is self-diagnosing instead of "操作失败". */
function describeExecError(error) {
  if (!error) return "FAILED";
  if (error.killed || error.signal === "SIGTERM" || /timed?\s*out/i.test(String(error.message || ""))) {
    return "TIMED_OUT";
  }
  const stderr = String(error.stderr || "").trim();
  if (stderr) return stderr.length > 1500 ? `…${stderr.slice(-1500)}` : stderr;
  return String(error.message || error);
}

async function runExecutable(id, exe, args = [], env = process.env, opts = {}) {
  if (!exe || !fs.existsSync(exe)) return missingCheck(id, "EXECUTABLE_MISSING", { path: exe || "" });
  const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(String(exe || ""));
  try {
    const result = await pexecFile(exe, args, {
      timeout: Number(opts.timeoutMs) || CHECK_TIMEOUT_MS,
      env,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      shell: useShell,
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim().split(/\r?\n/)[0] || "";
    return okCheck(id, { path: exe, output });
  } catch (error) {
    return failedCheck(id, describeExecError(error), { path: exe });
  }
}

function executableNames(name) {
  if (process.platform !== "win32") return [name];
  const lower = String(name || "").toLowerCase();
  if (/\.(exe|cmd|bat|com)$/.test(lower)) return [name];
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, `${name}.com`, name];
}

function resolvePackPath(packDir, relPath) {
  if (!packDir || !relPath || path.isAbsolute(relPath)) return "";
  const candidate = path.join(packDir, relPath);
  return fs.existsSync(candidate) ? candidate : "";
}

function packSearchDirs(spec, packDir) {
  const dirs = [packDir];
  for (const rel of Array.isArray(spec?.pathEntries) ? spec.pathEntries : []) {
    const dir = resolvePackPath(packDir, rel);
    if (dir) dirs.push(dir);
  }
  return [...new Set(dirs)];
}

function findPackExecutable(spec, packDir, name) {
  for (const dir of packSearchDirs(spec, packDir)) {
    for (const file of executableNames(name)) {
      const candidate = path.join(dir, file);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "";
}

function uniqueExistingPaths(paths) {
  const seen = new Set();
  const result = [];
  for (const item of paths) {
    if (!item || !fs.existsSync(item)) continue;
    const key = fs.realpathSync.native?.(item) || fs.realpathSync(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function pythonPackLibraryDirs(packDir) {
  if (!packDir || !fs.existsSync(packDir)) return [];
  const direct = [path.join(packDir, "bin"), path.join(packDir, "Scripts")];
  let siblingLibs = [];
  try {
    siblingLibs = fs
      .readdirSync(packDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /\.libs$/i.test(entry.name))
      .map((entry) => path.join(packDir, entry.name));
  } catch {
    siblingLibs = [];
  }
  return uniqueExistingPaths([...direct, ...siblingLibs]);
}

function buildPythonProbeEnv(packDir = "") {
  const runtimePython = require("./runtime-python");
  const baseEnv = runtimePython.getBundledPythonEnv();
  const runtimePackPaths = require("./runtime-packs").getRuntimePackPythonPaths();
  const pythonPath = uniqueExistingPaths([packDir, ...runtimePackPaths])
    .concat(baseEnv.PYTHONPATH ? [baseEnv.PYTHONPATH] : [])
    .join(path.delimiter);
  const pathEntries = uniqueExistingPaths([...(packDir ? pythonPackLibraryDirs(packDir) : [])]);
  const numbaCacheDir = process.env.NUMBA_CACHE_DIR || path.join(os.tmpdir(), "lily-numba-cache");
  try {
    fs.mkdirSync(numbaCacheDir, { recursive: true });
  } catch {
    // If the cache directory cannot be created, the probe will surface the import error.
  }
  return {
    ...baseEnv,
    ...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
    NUMBA_CACHE_DIR: numbaCacheDir,
    PATH: [...pathEntries, baseEnv.PATH || ""].filter(Boolean).join(path.delimiter),
  };
}

function findLibreOfficeExecutable(spec, packDir) {
  const names = process.platform === "win32" ? ["soffice.com", "soffice"] : ["soffice"];
  for (const name of names) {
    const found = findPackExecutable(spec, packDir, name);
    if (found) return found;
  }
  return "";
}

async function checkLibreOfficePack(id, spec, packDir) {
  const exe = findLibreOfficeExecutable(spec, packDir);
  if (!exe || !fs.existsSync(exe)) {
    return {
      id,
      ok: false,
      status: "failed",
      path: packDir || "",
      checks: [missingCheck(`${id}:soffice`, "EXECUTABLE_MISSING", { path: exe || "" })],
    };
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lily-lo-health-"));
  const args = [
    "--headless",
    "--invisible",
    "--nologo",
    "--nodefault",
    "--nofirststartwizard",
    "--nolockcheck",
    "--norestore",
    "--terminate_after_init",
    `-env:UserInstallation=${pathToFileURL(profile).href}`,
  ];
  try {
    const check = await runExecutable(`${id}:soffice`, exe, args, {
      ...process.env,
      SAL_USE_VCLPLUGIN: process.env.SAL_USE_VCLPLUGIN || "svp",
    }, { timeoutMs: LIBREOFFICE_CHECK_TIMEOUT_MS });
    return {
      id,
      ok: check.ok,
      status: check.ok ? "ok" : "failed",
      path: packDir || "",
      checks: [check],
    };
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function checkPythonProbe(id, probe, packDir = "") {
  const runtimePython = require("./runtime-python");
  const python = runtimePython.resolveVenvPython();
  if (!python) return missingCheck(id, "PYTHON_RUNTIME_MISSING");
  if (packDir && !fs.existsSync(packDir)) return missingCheck(id, "PACK_DIR_MISSING", { path: packDir || "" });
  try {
    await pexecFile(python, ["-c", String(probe || "")], {
      timeout: PYTHON_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: buildPythonProbeEnv(packDir),
      windowsHide: true,
    });
    return okCheck(id, { path: packDir, probe });
  } catch (error) {
    return failedCheck(id, describeExecError(error), { path: packDir, probe });
  }
}

async function checkWebAutomationPack(id, spec, packDir) {
  if (!packDir || !fs.existsSync(packDir)) return missingCheck(id, "PACK_DIR_MISSING", { path: packDir || "" });
  const nodeModules = resolvePackPath(packDir, spec.envEntries?.LILY_PLAYWRIGHT_NODE_MODULES || "node_modules");
  const browsers = resolvePackPath(packDir, spec.envEntries?.PLAYWRIGHT_BROWSERS_PATH || "browsers");
  const moduleName = spec.health?.nodeModule || "playwright";
  const pkg = nodeModules ? path.join(nodeModules, moduleName, "package.json") : "";
  if (!nodeModules || !fs.existsSync(pkg)) return missingCheck(id, "NODE_MODULE_MISSING", { path: pkg || nodeModules || "" });
  if (!browsers) return missingCheck(id, "BROWSER_BINARIES_MISSING", { path: path.join(packDir, "browsers") });
  return okCheck(id, { path: packDir, nodeModules, browsers });
}

function packEntry(packId) {
  return require("./runtime-packs").effectivePackEntries().find((entry) => entry.id === packId) || null;
}

async function checkRuntimePackHealthAtPath(packId, packDir) {
  const id = String(packId || "").trim();
  const spec = PACK_SPECS[id];
  if (!spec) return { ok: false, id, status: "unknown", error: "UNKNOWN_PACK" };
  const dir = String(packDir || "").trim();
  if (spec.pythonPath && spec.probe) return checkPythonProbe(id, spec.probe, dir);
  if (spec.installKind === "node-browser-runtime") return checkWebAutomationPack(id, spec, dir);
  if (spec.health?.kind === "libreoffice") return checkLibreOfficePack(id, spec, dir);
  const executables = Array.isArray(spec.health?.executables) ? spec.health.executables : [];
  if (executables.length) {
    const checks = [];
    for (const item of executables) {
      checks.push(await runExecutable(`${id}:${item.name}`, findPackExecutable(spec, dir, item.name), item.args || []));
    }
    return {
      id,
      ok: checks.every((check) => check.ok),
      status: checks.every((check) => check.ok) ? "ok" : "failed",
      path: dir,
      checks,
    };
  }
  return okCheck(id, { path: dir, skipped: true });
}

async function checkRuntimePackHealth(packId) {
  const id = String(packId || "").trim();
  const spec = PACK_SPECS[id];
  if (!spec) return { ok: false, id, status: "unknown", error: "UNKNOWN_PACK" };
  const entry = packEntry(id);
  const base = require("./runtime-pack-installer").baseProvidedRuntimePackMap().get(id);
  if (!entry && !base) return { ok: false, id, status: "not_installed", error: "NOT_INSTALLED" };
  return checkRuntimePackHealthAtPath(id, entry?.dir || base?.path || "");
}

async function checkPythonModules(python) {
  const policy = basePythonModulePolicy();
  const modulesToCheck = [...policy.required, ...policy.optional];
  if (!python) return modulesToCheck.map((item) => missingCheck(item.id, "PYTHON_RUNTIME_MISSING", { module: item.module, required: item.required !== false }));
  const code = [
    "import importlib.util, json, sys",
    `mods = json.loads(${JSON.stringify(JSON.stringify(modulesToCheck))})`,
    "print(json.dumps([{**m, 'ok': importlib.util.find_spec(m['module']) is not None} for m in mods]))",
  ].join("\n");
  try {
    const result = await pexecFile(python, ["-c", code], {
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: require("./runtime-python").getBundledPythonEnv(),
    });
    return JSON.parse(result.stdout).map((item) =>
      item.ok
        ? okCheck(item.id, { module: item.module, required: item.required !== false })
        : missingCheck(item.id, "MODULE_MISSING", { module: item.module, required: item.required !== false }),
    );
  } catch (error) {
    return modulesToCheck.map((item) => failedCheck(item.id, error?.message || error, { module: item.module, required: item.required !== false }));
  }
}

async function checkBaseRuntimeHealth() {
  const runtimePython = require("./runtime-python");
  const root = runtimePython.resolveBundledRuntimeRoot();
  const python = runtimePython.resolveVenvPython();
  const uv = runtimePython.resolveBundledUv();
  const nodeDir = root ? runtimePython.resolveBundledNodeDir(root) : null;
  let node = nodeDir ? path.join(nodeDir, process.platform === "win32" ? "node.exe" : "node") : "";
  if (!node) {
    try {
      node = require("./runtime-node").ensureRuntimeNodeShim();
    } catch {
      node = "";
    }
  }
  const checks = [
    await runExecutable("python", python, ["--version"]),
    await runExecutable("uv", uv, ["--version"]),
    await runExecutable("node", node, ["--version"]),
  ];
  const modules = await checkPythonModules(python);
  return {
    ok: Boolean(root) && checks.every((check) => check.ok) && modules.every((check) => check.ok || check.required === false),
    root: root || "",
    checks,
    modules,
  };
}

async function checkDependencyHealth(packId = "") {
  const base = await checkBaseRuntimeHealth();
  const packIds = packId ? [packId] : Object.keys(PACK_SPECS);
  const packs = [];
  for (const id of packIds) packs.push(await checkRuntimePackHealth(id));
  return {
    ok: base.ok && packs.every((pack) => pack.ok || pack.status === "not_installed"),
    base,
    packs,
  };
}

module.exports = {
  basePythonModulePolicy,
  checkBaseRuntimeHealth,
  checkDependencyHealth,
  checkRuntimePackHealth,
  checkRuntimePackHealthAtPath,
};
