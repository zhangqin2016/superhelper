"use strict";

/**
 * On-demand document capability packs.
 *
 * The base install stays light for ordinary laptops (digital PDF + RapidOCR,
 * no torch). Heavy, high-accuracy engines (Docling layout/table analysis, and
 * later MinerU/Marker) are NOT bundled — they are fetched on demand.
 *
 * Install path is artifact-first, designed for reach inside China:
 *   1. Ask our server for the pack's download (server returns a Qiniu CDN URL +
 *      sha256 for this pack + platform — the source is configurable server-side
 *      and never touches PyPI).
 *   2. Download → verify sha256 → extract into a writable per-pack dir under
 *      userData (the bundled venv is read-only once the app is packaged).
 *   3. The extracted dir goes on PYTHONPATH, so extract_document.py's lazy
 *      `import docling` upgrades automatically. Uninstall = delete the dir.
 *
 * A `uv pip install` fallback remains for dev/offline use (works only when the
 * app is unpackaged and the venv is writable).
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, execFileSync } = require("node:child_process");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { userDataPath } = require("./config");
const { resolveVenvPython, resolveBundledUv } = require("./runtime-python");
const { PACK_SPECS } = require("./document-pack-specs");

const STATE_SCHEMA_VERSION = 1;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000; // packs can be multi-GB

/**
 * Available packs (shared catalog data). Artifact URLs are intentionally NOT
 * hardcoded here — the server resolves them per platform, so adding packs later
 * is a server-config change, not an app release.
 */
const PACKS = PACK_SPECS;

function platformKey() {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  const os =
    process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
  return `${os}-${arch}`;
}

function packsRoot() {
  return userDataPath("document-packs");
}

function packDir(id) {
  return path.join(packsRoot(), id);
}

function statePath() {
  return userDataPath("document-packs.json");
}

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    if (!raw || typeof raw !== "object" || !raw.installed) {
      return { schemaVersion: STATE_SCHEMA_VERSION, installed: {} };
    }
    return { schemaVersion: STATE_SCHEMA_VERSION, installed: raw.installed };
  } catch {
    return { schemaVersion: STATE_SCHEMA_VERSION, installed: {} };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** Record a pack as installed (called only after its probe succeeds). */
function markPackInstalled(id, meta = {}) {
  const state = readState();
  state.installed[id] = {
    installedAt: meta.installedAt || new Date().toISOString(),
    source: meta.source || "artifact",
    version: meta.version || null,
    sha256: meta.sha256 || null,
    requirements: meta.requirements || PACKS[id]?.requirements || [],
  };
  writeState(state);
  return state.installed[id];
}

/** Drop a pack's installed record. */
function markPackRemoved(id) {
  const state = readState();
  delete state.installed[id];
  writeState(state);
}

/**
 * Packs with their recorded install status — the fast, state-file view for the
 * catalog UI. `verifyPack` does the authoritative live probe.
 */
function listPacks() {
  const state = readState();
  return Object.values(PACKS).map((pack) => ({
    id: pack.id,
    label: pack.label,
    description: pack.description,
    sizeEstimate: pack.sizeEstimate,
    requirements: pack.requirements,
    installed: Boolean(state.installed[pack.id]),
    source: state.installed[pack.id]?.source || null,
    version: state.installed[pack.id]?.version || null,
    installedAt: state.installed[pack.id]?.installedAt || null,
  }));
}

/**
 * PYTHONPATH entries for installed artifact packs, so extract_document.py can
 * import the pro engine. pip-source packs install into the venv itself and need
 * no path entry.
 * @returns {string[]}
 */
function getDocumentPackPythonPaths() {
  const state = readState();
  return Object.keys(state.installed)
    .filter((id) => state.installed[id]?.source !== "pip")
    .map((id) => packDir(id))
    .filter((dir) => fs.existsSync(dir));
}

function probeEnv(extraPath) {
  const parts = [extraPath, process.env.PYTHONPATH].filter(Boolean);
  return { ...process.env, PYTHONPATH: parts.join(path.delimiter) };
}

/**
 * Authoritative check: actually import the pack's probe in the venv with the
 * pack dir on PYTHONPATH. Truth over stored state.
 * @returns {boolean}
 */
function verifyPack(id) {
  const pack = PACKS[id];
  const python = resolveVenvPython();
  if (!pack || !python) return false;
  try {
    execFileSync(python, ["-c", pack.probe], {
      stdio: "ignore",
      timeout: 60_000,
      env: probeEnv(packDir(id)),
    });
    return true;
  } catch {
    return false;
  }
}

/** Plain http is rejected except to localhost (tests); real artifacts are https. */
function isAllowedArtifactUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function downloadArtifact(url, dest, onProgress) {
  if (!isAllowedArtifactUrl(url)) throw new Error("UNTRUSTED_ARTIFACT_URL");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`DOWNLOAD_FAILED:HTTP ${response.status}`);
    }
    const total = Number(response.headers.get("content-length")) || 0;
    let received = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        if (typeof onProgress === "function") onProgress({ received, total });
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(dest));
  } finally {
    clearTimeout(timer);
  }
}

function extractTarball(tarPath, destDir) {
  return new Promise((resolve, reject) => {
    // System tar handles multi-GB archives without buffering; -C confines output.
    execFile("tar", ["-xzf", tarPath, "-C", destDir], (err) => {
      if (err) return reject(new Error(`PACK_EXTRACT_FAILED:${err.message}`));
      resolve();
    });
  });
}

/**
 * Download a pack artifact, verify its sha256, extract it into the pack dir, and
 * probe it. Cleans up the dir on any failure so a half-install never lingers.
 */
async function installPackFromArtifact({ id, url, sha256, probe, onProgress } = {}) {
  const dir = packDir(id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const tmpTar = path.join(packsRoot(), `.${id}.download.tar.gz`);
  try {
    await downloadArtifact(url, tmpTar, onProgress);
    if (sha256) {
      const digest = await sha256File(tmpTar);
      if (digest.toLowerCase() !== String(sha256).toLowerCase()) {
        throw new Error("SHA256_MISMATCH");
      }
    }
    await extractTarball(tmpTar, dir);
    if (probe) {
      const python = resolveVenvPython();
      if (!python) throw new Error("RUNTIME_UNAVAILABLE");
      try {
        execFileSync(python, ["-c", probe], { stdio: "ignore", timeout: 60_000, env: probeEnv(dir) });
      } catch (probeErr) {
        throw new Error(`PACK_VERIFY_FAILED:${probeErr.message}`);
      }
    }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  } finally {
    fs.rmSync(tmpTar, { force: true });
  }
}

async function defaultResolveArtifact(id, plat) {
  // serviceFetch wraps the server response as { ok, json }; the artifact the
  // server returns lives under .json.artifact.
  const res = await require("./service-client").documentPackArtifact(id, plat);
  const artifact = res && res.ok ? res.json?.artifact : null;
  if (artifact && artifact.url) return artifact;
  return null;
}

/**
 * Low-level dev/offline fallback: install pip requirements into the venv via
 * `uv`, then verify. Works only when the venv is writable (unpackaged).
 * @returns {Promise<void>}
 */
function installPackRequirements({ requirements, probe, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(requirements) || requirements.length === 0) {
      return reject(new Error("NO_REQUIREMENTS"));
    }
    const uv = resolveBundledUv();
    const python = resolveVenvPython();
    if (!uv || !python) return reject(new Error("RUNTIME_UNAVAILABLE"));
    const args = ["pip", "install", "--python", python, ...requirements];
    const child = execFile(uv, args, { maxBuffer: 64 * 1024 * 1024 }, (err) => {
      if (err) return reject(new Error(`PACK_INSTALL_FAILED:${err.message}`));
      if (probe) {
        try {
          execFileSync(python, ["-c", probe], { stdio: "ignore", timeout: 60_000 });
        } catch (probeErr) {
          return reject(new Error(`PACK_VERIFY_FAILED:${probeErr.message}`));
        }
      }
      resolve();
    });
    if (typeof onProgress === "function") {
      const emit = (chunk) => onProgress(String(chunk));
      child.stdout?.on("data", emit);
      child.stderr?.on("data", emit);
    }
  });
}

/**
 * Install a named pack: artifact-first (server-resolved Qiniu download), falling
 * back to uv/PyPI only when no artifact is available (dev/offline).
 * @param {string} id
 * @param {{ onProgress?: Function, resolveArtifact?: Function }} [opts]
 * @returns {Promise<{ id: string, source: string, installedAt: string }>}
 */
async function installPack(id, { onProgress, resolveArtifact } = {}) {
  const pack = PACKS[id];
  if (!pack) throw new Error(`UNKNOWN_PACK:${id}`);

  const resolver = resolveArtifact || defaultResolveArtifact;
  let artifact = null;
  try {
    artifact = await resolver(id, platformKey());
  } catch {
    artifact = null;
  }

  if (artifact && artifact.url) {
    await installPackFromArtifact({
      id,
      url: artifact.url,
      sha256: artifact.sha256,
      probe: pack.probe,
      onProgress,
    });
    const meta = markPackInstalled(id, {
      source: "artifact",
      version: artifact.version || null,
      sha256: artifact.sha256 || null,
    });
    return { id, source: "artifact", installedAt: meta.installedAt };
  }

  await installPackRequirements({ requirements: pack.requirements, probe: pack.probe, onProgress });
  const meta = markPackInstalled(id, { source: "pip", requirements: pack.requirements });
  return { id, source: "pip", installedAt: meta.installedAt };
}

/**
 * Uninstall a named pack: delete its dir (artifact source) or uv-uninstall its
 * requirements (pip source), then drop the record.
 * @returns {Promise<void>}
 */
async function uninstallPack(id) {
  const pack = PACKS[id];
  if (!pack) throw new Error(`UNKNOWN_PACK:${id}`);
  const rec = readState().installed[id];

  if (rec?.source === "pip") {
    await new Promise((resolve, reject) => {
      const uv = resolveBundledUv();
      const python = resolveVenvPython();
      if (!uv || !python) return reject(new Error("RUNTIME_UNAVAILABLE"));
      const args = ["pip", "uninstall", "--python", python, ...pack.requirements];
      execFile(uv, args, { maxBuffer: 64 * 1024 * 1024 }, (err) => {
        markPackRemoved(id);
        if (err) return reject(new Error(`PACK_UNINSTALL_FAILED:${err.message}`));
        resolve();
      });
    });
    return;
  }

  fs.rmSync(packDir(id), { recursive: true, force: true });
  markPackRemoved(id);
}

module.exports = {
  PACKS,
  listPacks,
  verifyPack,
  installPack,
  uninstallPack,
  installPackRequirements,
  installPackFromArtifact,
  getDocumentPackPythonPaths,
  markPackInstalled,
  markPackRemoved,
};
