"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { pathToFileURL } = require("node:url");
const { PACK_SPECS } = require("./runtime-pack-specs");

const pexecFile = promisify(execFile);
const CHECK_TIMEOUT_MS = 20_000;

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

async function runExecutable(id, exe, args = [], env = process.env) {
  if (!exe || !fs.existsSync(exe)) return missingCheck(id, "EXECUTABLE_MISSING", { path: exe || "" });
  try {
    const result = await pexecFile(exe, args, {
      timeout: CHECK_TIMEOUT_MS,
      env,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim().split(/\r?\n/)[0] || "";
    return okCheck(id, { path: exe, output });
  } catch (error) {
    return failedCheck(id, error?.message || error, { path: exe });
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
  const runtimePackPaths = require("./runtime-packs").getRuntimePackPythonPaths();
  const pythonPath = uniqueExistingPaths([packDir, ...runtimePackPaths])
    .concat(process.env.PYTHONPATH ? [process.env.PYTHONPATH] : [])
    .join(path.delimiter);
  const pathEntries = uniqueExistingPaths([...(packDir ? pythonPackLibraryDirs(packDir) : [])]);
  return {
    ...process.env,
    ...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
    PATH: [...pathEntries, process.env.PATH || ""].filter(Boolean).join(path.delimiter),
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
    });
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
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: buildPythonProbeEnv(packDir),
      windowsHide: true,
    });
    return okCheck(id, { path: packDir, probe });
  } catch (error) {
    return failedCheck(id, error?.message || error, { path: packDir, probe });
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

async function checkRuntimePackHealth(packId) {
  const id = String(packId || "").trim();
  const spec = PACK_SPECS[id];
  if (!spec) return { ok: false, id, status: "unknown", error: "UNKNOWN_PACK" };
  const entry = packEntry(id);
  const base = require("./runtime-pack-installer").baseProvidedRuntimePackMap().get(id);
  if (!entry && !base) return { ok: false, id, status: "not_installed", error: "NOT_INSTALLED" };
  const dir = entry?.dir || "";
  if (spec.pythonPath && spec.probe) return checkPythonProbe(id, spec.probe, dir || base?.path || "");
  if (spec.installKind === "node-browser-runtime") return checkWebAutomationPack(id, spec, dir || base?.path || "");
  if (spec.health?.kind === "libreoffice") return checkLibreOfficePack(id, spec, dir || base?.path || "");
  const executables = Array.isArray(spec.health?.executables) ? spec.health.executables : [];
  if (executables.length) {
    const checks = [];
    for (const item of executables) {
      checks.push(await runExecutable(`${id}:${item.name}`, findPackExecutable(spec, dir || base?.path || "", item.name), item.args || []));
    }
    return {
      id,
      ok: checks.every((check) => check.ok),
      status: checks.every((check) => check.ok) ? "ok" : "failed",
      path: dir || base?.path || "",
      checks,
    };
  }
  return okCheck(id, { path: dir, skipped: true });
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
    const result = await pexecFile(python, ["-c", code], { timeout: CHECK_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
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
};
