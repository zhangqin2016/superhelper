"use strict";

/**
 * Runtime packs — main-process READER only.
 *
 * Optional heavy engines (Docling, and later MinerU/Marker) are NOT bundled and
 * are NOT installed by the app. We only PROVIDE them (hosted on our CDN, the URL
 * resolved by our server) and let designated skills install OUR runtime from OUR
 * source through the agent — see
 * resources/skills-catalog/lily-runtime-packs/scripts/manage_runtime_pack.py.
 * The app does NOT intervene in or perform the install (no IPC install handler,
 * no App-side downloader): the agent is autonomous; we just provide + point to
 * our runtime.
 *
 * The agent's installer writes userData/runtime-packs.json and extracts each pack
 * to userData/runtime-packs/<id>/. This module only READS that state to put
 * installed packs on PYTHONPATH, so extract_document.py's lazy `import docling`
 * upgrades automatically. The on-disk layout (state file + pack dirs) is the
 * contract shared with the Python installer.
 */

const fs = require("node:fs");
const path = require("node:path");

const STATE_SCHEMA_VERSION = 1;

function packsRoot() {
  return require("./config").userDataPath("runtime-packs");
}

function packDir(id) {
  return path.join(packsRoot(), id);
}

function statePath() {
  return require("./config").userDataPath("runtime-packs.json");
}

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    if (raw && typeof raw === "object" && raw.installed) {
      return { schemaVersion: STATE_SCHEMA_VERSION, installed: raw.installed };
    }
  } catch {
    /* no state file yet → nothing installed */
  }
  return { schemaVersion: STATE_SCHEMA_VERSION, installed: {} };
}

/**
 * PYTHONPATH entries for installed packs, so the document extractor can import
 * the pro engine. Only dirs that actually exist on disk are returned. (A "pip"
 * source record, if ever written, installs into the venv and needs no entry.)
 * @returns {string[]}
 */
function getRuntimePackPythonPaths() {
  const state = readState();
  return Object.keys(state.installed)
    .filter((id) => state.installed[id]?.source !== "pip")
    .map((id) => packDir(id))
    .filter((dir) => fs.existsSync(dir));
}

module.exports = { getRuntimePackPythonPaths, packDir, statePath };
