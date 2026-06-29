"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

function splitPathList(value) {
  return String(value || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function platformBundleKeys() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? ["darwin-arm64", "darwin-x64"] : ["darwin-x64", "darwin-arm64"];
  }
  if (process.platform === "win32") return ["win32-x64"];
  return ["linux-x64"];
}

function pushNodeModules(candidates, dir, reason) {
  if (!dir) return;
  const abs = path.resolve(dir);
  candidates.push({ kind: "node_modules", path: abs, reason });
}

function pushPackageDir(candidates, dir, reason) {
  if (!dir) return;
  const abs = path.resolve(dir);
  candidates.push({ kind: "package", path: abs, reason });
}

function repoRootFrom(startDir) {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "src", "main"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

function addRuntimeBundleCandidates(candidates, root, reason) {
  if (!root) return;
  for (const key of platformBundleKeys()) {
    pushNodeModules(candidates, path.join(root, "bundles", key, "runtime", "web", "node_modules"), `${reason}:${key}`);
  }
}

function addBunPlaywrightCandidates(candidates, root, reason) {
  const bunDir = path.join(root, "opencode", "node_modules", ".bun");
  if (!fs.existsSync(bunDir)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(bunDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("playwright@")) continue;
    pushPackageDir(candidates, path.join(bunDir, entry.name, "node_modules", "playwright"), reason);
  }
}

function addRepoCandidates(candidates, root, reason) {
  if (!root) return;
  pushNodeModules(candidates, path.join(root, "node_modules"), `${reason}:node_modules`);
  addRuntimeBundleCandidates(candidates, root, `${reason}:bundles`);
  addBunPlaywrightCandidates(candidates, root, `${reason}:vendored`);
}

function candidatePlaywrightLocations() {
  const candidates = [];
  for (const envKey of ["LILY_PLAYWRIGHT_NODE_MODULES", "PLAYWRIGHT_NODE_MODULES", "NODE_PATH"]) {
    for (const item of splitPathList(process.env[envKey])) pushNodeModules(candidates, item, envKey);
  }

  if (process.env.LILY_RUNTIME_ROOT) {
    pushNodeModules(candidates, path.join(process.env.LILY_RUNTIME_ROOT, "web", "node_modules"), "LILY_RUNTIME_ROOT");
  }

  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    addRuntimeBundleCandidates(candidates, process.resourcesPath, "process.resourcesPath");
  }

  addRepoCandidates(candidates, repoRootFrom(__dirname), "skill-repo");
  addRepoCandidates(candidates, repoRootFrom(process.cwd()), "cwd-repo");

  const out = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.kind}:${candidate.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function requireFromNodeModules(dir) {
  const req = createRequire(path.join(dir, "..", "lily-playwright-runtime-loader.js"));
  return req("playwright");
}

function requireFromPackageDir(dir) {
  const req = createRequire(path.join(dir, "package.json"));
  return req(dir);
}

function requirePlaywright() {
  const errors = [];
  try {
    const loaded = require("playwright");
    return { ...loaded, __lilyPlaywrightSource: "default" };
  } catch (err) {
    errors.push(`default: ${err.code || err.message}`);
  }

  for (const candidate of candidatePlaywrightLocations()) {
    const exists = candidate.kind === "package"
      ? fs.existsSync(path.join(candidate.path, "package.json"))
      : fs.existsSync(path.join(candidate.path, "playwright", "package.json"));
    if (!exists) {
      errors.push(`${candidate.reason}: missing`);
      continue;
    }
    try {
      const loaded = candidate.kind === "package"
        ? requireFromPackageDir(candidate.path)
        : requireFromNodeModules(candidate.path);
      return { ...loaded, __lilyPlaywrightSource: candidate.path };
    } catch (err) {
      errors.push(`${candidate.reason}: ${err.code || err.message}`);
    }
  }

  const error = new Error(
    "Node.js Playwright module was not found. Set LILY_PLAYWRIGHT_NODE_MODULES to the bundled web node_modules directory or install the web runtime bundle. Tried sources: " +
      errors.slice(0, 12).join("; "),
  );
  error.code = "PLAYWRIGHT_NODE_MISSING";
  error.tried = errors;
  throw error;
}

function fallbackBrowserChannels() {
  return process.platform === "win32" ? ["chrome", "msedge"] : ["chrome"];
}

async function launchChromium(chromium, options = {}) {
  try {
    return await chromium.launch(options);
  } catch (firstError) {
    if (options.channel) throw firstError;
    let lastError = firstError;
    for (const channel of fallbackBrowserChannels()) {
      try {
        return await chromium.launch({ ...options, channel });
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }
}

async function launchPersistentChromiumContext(chromium, userDataDir, options = {}) {
  try {
    return await chromium.launchPersistentContext(userDataDir, options);
  } catch (firstError) {
    if (options.channel) throw firstError;
    let lastError = firstError;
    for (const channel of fallbackBrowserChannels()) {
      try {
        return await chromium.launchPersistentContext(userDataDir, { ...options, channel });
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }
}

module.exports = {
  candidatePlaywrightLocations,
  launchChromium,
  launchPersistentChromiumContext,
  requirePlaywright,
};
