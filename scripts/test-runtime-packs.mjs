#!/usr/bin/env node
//
// runtime-packs.js is a main-process READER: the agent (skill) installs packs
// and writes the state; the app only reads which packs are installed to build
// the document extractor's PYTHONPATH. This verifies that contract — and runs in
// plain node via LILY_USER_DATA_DIR (no electron mock), thanks to config being
// decoupled from electron.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { assert } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-runtime-packs-"));
process.env.LILY_USER_DATA_DIR = tmp; // config resolves userData from this (no electron)
const externalRuntimeRoot = path.join(tmp, "external-runtime-root");
process.env.LILY_RUNTIME_PACK_ROOT = externalRuntimeRoot;
const bundledRoot = path.join(tmp, "bundled-runtime-packs");
process.env.LILY_BUNDLED_RUNTIME_PACK_ROOTS = bundledRoot;

const bundledWeb = path.join(bundledRoot, "web-automation");
fs.mkdirSync(path.join(bundledWeb, "node_modules"), { recursive: true });
fs.mkdirSync(path.join(bundledWeb, "browsers"), { recursive: true });
fs.mkdirSync(path.join(bundledWeb, "bin"), { recursive: true });

const packs = require(path.join(ROOT, "src/main/runtime-packs.js"));
const runtimePython = require(path.join(ROOT, "src/main/runtime-python.js"));

// No state file yet, but read-only bundled packs should already be usable.
assert(Array.isArray(packs.getRuntimePackPythonPaths()), "should return an array");
assert(packs.getRuntimePackPythonPaths().length === 0, "fresh userData with web runtime → no Python pack paths");
assert(
  packs.getRuntimePackPathEntries().includes(path.join(bundledWeb, "bin")),
  "bundled runtime pack PATH entries should be visible without user install state",
);
assert(
  packs.getRuntimePackEnvExtras().LILY_PLAYWRIGHT_NODE_MODULES === path.join(bundledWeb, "node_modules"),
  "bundled runtime pack env entries should be visible without user install state",
);

// Simulate what the agent's installer writes: a state file + extracted pack dirs.
const proDir = packs.packDir("pro-pdf");
assert(
  proDir === path.join(externalRuntimeRoot, "runtime-packs", "pro-pdf"),
  "new installs should target the selected runtime-pack root, not userData",
);
fs.mkdirSync(proDir, { recursive: true });
fs.writeFileSync(path.join(proDir, "marker.txt"), "x"); // dir exists on disk
const opencvDir = packs.packDir("opencv");
fs.mkdirSync(path.join(opencvDir, "opencv_python.libs"), { recursive: true });
const rembgDir = packs.packDir("rembg");
fs.mkdirSync(path.join(rembgDir, "bin"), { recursive: true });
fs.mkdirSync(path.join(rembgDir, "llvmlite.libs"), { recursive: true });
const libreOfficeProgramDir =
  process.platform === "darwin"
    ? path.join(packs.packDir("libreoffice"), "LibreOffice.app", "Contents", "MacOS")
    : path.join(packs.packDir("libreoffice"), "program");
fs.mkdirSync(libreOfficeProgramDir, { recursive: true });
fs.writeFileSync(path.join(libreOfficeProgramDir, process.platform === "win32" ? "soffice.exe" : "soffice"), "x");
const libreOfficeResourcesDir =
  process.platform === "darwin" ? path.join(packs.packDir("libreoffice"), "LibreOffice.app", "Contents", "Resources") : null;
if (libreOfficeResourcesDir) fs.mkdirSync(libreOfficeResourcesDir, { recursive: true });

// Old installs must remain readable after a user chooses a new dependency-pack
// location. The selected root wins for duplicate ids, but legacy-only packs are
// still usable so older installs do not silently lose capability.
const legacyRapidOcrDir = path.join(tmp, "runtime-packs", "rapidocr");
fs.mkdirSync(legacyRapidOcrDir, { recursive: true });
const legacyProPdfDir = path.join(tmp, "runtime-packs", "pro-pdf");
fs.mkdirSync(legacyProPdfDir, { recursive: true });
fs.writeFileSync(
  path.join(tmp, "runtime-packs.json"),
  JSON.stringify({
    schemaVersion: 1,
    installed: {
      rapidocr: { source: "artifact", version: "3.3.0" },
      "pro-pdf": { source: "artifact", version: "1.0.0" },
    },
  }),
  "utf8",
);

// A pip-source record (installs into the venv, no PYTHONPATH entry) and a record
// whose dir was deleted (must not be returned) — both must be excluded.
fs.writeFileSync(
  packs.statePath(),
  JSON.stringify({
    schemaVersion: 1,
    installed: {
      opencv: { source: "artifact", version: "4.13.0.92" },
      "pro-pdf": { source: "artifact", version: "2.102.1" },
      rembg: { source: "artifact", version: "2.0.76" },
      libreoffice: { source: "artifact", version: "25.8.7" },
      "legacy-pip": { source: "pip", version: "1.0.0" },
      "ghost": { source: "artifact", version: "9.9.9" }, // no dir on disk
    },
  }),
  "utf8",
);

const paths = packs.getRuntimePackPythonPaths();
assert(paths.length === 4, `expected selected plus legacy usable pack paths, got ${JSON.stringify(paths)}`);
assert(paths.includes(proDir), "should return the artifact pack dir that exists on disk");
assert(paths.includes(legacyRapidOcrDir), "legacy userData installs should remain usable after changing runtime-pack root");
assert(!paths.includes(legacyProPdfDir), "selected runtime-pack root should win over legacy state for duplicate ids");
assert(
  paths.indexOf(rembgDir) < paths.indexOf(opencvDir),
  `rembg must precede opencv so its NumPy pin can win: ${JSON.stringify(paths)}`,
);
assert(!paths.some((p) => p.includes("legacy-pip")), "pip-source packs must be excluded (they install into the venv)");
assert(!paths.some((p) => p.includes("ghost")), "records without an on-disk dir must be excluded");

const libreOfficeDirs = packs.getRuntimePackLibreOfficeDirs();
assert(libreOfficeDirs.length === 1, `expected one LibreOffice program dir, got ${JSON.stringify(libreOfficeDirs)}`);
assert(libreOfficeDirs[0] === libreOfficeProgramDir, "should resolve installed LibreOffice program dir");
assert(
  runtimePython.getRuntimePathEntries().includes(libreOfficeProgramDir),
  "runtime PATH entries should include installed LibreOffice runtime pack",
);
const pathEntries = runtimePython.getRuntimePathEntries();
assert(pathEntries.includes(path.join(opencvDir, "opencv_python.libs")), "runtime PATH should include Python wheel .libs dirs for native Windows DLLs");
assert(pathEntries.includes(path.join(rembgDir, "bin")), "runtime PATH should include Python pack bin dirs");
assert(pathEntries.includes(path.join(rembgDir, "llvmlite.libs")), "runtime PATH should include every Python pack .libs dir");
const runtimeEnv = runtimePython.getRuntimeEnvExtras();
assert(
  runtimeEnv.LILY_LIBREOFFICE_PROGRAM,
  `runtime env should expose a LibreOffice program dir, got ${JSON.stringify(runtimeEnv)}`,
);
if (libreOfficeResourcesDir && runtimeEnv.LILY_LIBREOFFICE_PROGRAM === libreOfficeProgramDir) {
  assert(
    runtimeEnv.UNO_PATH === libreOfficeResourcesDir,
    `darwin UNO_PATH should point to LibreOffice.app Resources, got ${JSON.stringify(runtimeEnv)}`,
  );
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("runtime-packs: ok (reader contract, no electron mock)");
