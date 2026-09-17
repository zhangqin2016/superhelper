"use strict";

/**
 * One pack per process, and only when that pack is the job.
 *
 * A runtime pack is not a library overlay — it is a self-contained tool that
 * happens to be written in Python, and the packs disagree with the runtime and
 * with each other. Measured on 2026-09-17:
 *
 *   rembg          numpy 2.4.6 (its numba refuses anything newer), PIL 12.2.0
 *   pro-pdf        docling + numpy 2.4.6 + PIL 12.2.0, 44 top-level names that
 *                  also exist in the venv
 *   large-document PIL 12.2.0, pymupdf, polars, duckdb; no numpy of its own
 *   venv           numpy 2.5.3, Pillow 11.3.0 — the set we declare and test
 *
 * Putting every pack on one PYTHONPATH forces a single global winner, so every
 * Python process the agent ran got a numpy and a Pillow it was never tested
 * with. That is how image-to-PDF broke with KeyError: 'JPEG' and how a
 * dependency audit read four libraries as out of range when the runtime was
 * fine. Ordering cannot fix it: packs first breaks Pillow, venv first breaks
 * rembg. Full isolation cannot either — rembg needs onnxruntime and
 * large-document needs numpy, both of which only the venv has.
 *
 * What does work, and is what this module builds: the venv interpreter plus
 * EXACTLY ONE pack. The pack's own versions win for what it ships, the venv
 * fills in the rest, and a process that is not using a pack never sees one.
 *
 * [gate: runtime-pack-isolation]
 */

const path = require("node:path");

// The PDF engines that live in the pro-pdf pack. extract_document.py reads the
// same selector; this is the JS half of the same decision.
const PRO_PDF_ENGINE_VALUES = new Set(["pro", "pro-pdf", "docling"]);

function globalPackPythonPathEnabled(env = process.env) {
  return String(env.LILY_RUNTIME_PACK_GLOBAL_PYTHONPATH || "") === "1";
}

/** Pack ids a document extraction needs, from the engine the caller selected. */
function packsForPdfEngine(env = process.env) {
  const engine = String(env.LILY_PDF_ENGINE || "").toLowerCase();
  return PRO_PDF_ENGINE_VALUES.has(engine) ? ["pro-pdf"] : [];
}

/**
 * A Python environment exposing EXACTLY the named packs and nothing else.
 *
 * @param {string[]} packIds
 * @param {object} baseEnv
 * @returns {object} env, always usable — an unknown or uninstalled pack simply
 *   contributes nothing rather than failing the call.
 */
function pythonEnvForPacks(packIds = [], baseEnv = process.env) {
  const runtimePython = require("./runtime-python");
  const runtimePacks = require("./runtime-packs");
  const env = runtimePython.getBundledPythonEnv(baseEnv);
  const dirs = [];
  for (const id of Array.isArray(packIds) ? packIds : []) {
    let dir = "";
    try {
      dir = runtimePacks.getEffectiveRuntimePackDir(String(id || ""));
    } catch {
      dir = "";
    }
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  }
  if (!dirs.length) return env;
  env.PYTHONPATH = [...dirs, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  return env;
}

/** Every python pack dir, for discovery and for the runtime-pack repair hint. */
function packPythonDirs() {
  try {
    return require("./runtime-packs").getRuntimePackPythonPaths();
  } catch {
    return [];
  }
}

module.exports = {
  PRO_PDF_ENGINE_VALUES,
  globalPackPythonPathEnabled,
  packPythonDirs,
  packsForPdfEngine,
  pythonEnvForPacks,
};
