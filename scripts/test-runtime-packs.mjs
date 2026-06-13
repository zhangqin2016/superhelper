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

const packs = require(path.join(ROOT, "src/main/runtime-packs.js"));

// No state file yet → nothing installed.
assert(Array.isArray(packs.getRuntimePackPythonPaths()), "should return an array");
assert(packs.getRuntimePackPythonPaths().length === 0, "fresh userData → no pack paths");

// Simulate what the agent's installer writes: a state file + extracted pack dirs.
const proDir = packs.packDir("pro-pdf");
fs.mkdirSync(proDir, { recursive: true });
fs.writeFileSync(path.join(proDir, "marker.txt"), "x"); // dir exists on disk
// A pip-source record (installs into the venv, no PYTHONPATH entry) and a record
// whose dir was deleted (must not be returned) — both must be excluded.
fs.writeFileSync(
  packs.statePath(),
  JSON.stringify({
    schemaVersion: 1,
    installed: {
      "pro-pdf": { source: "artifact", version: "2.102.1" },
      "legacy-pip": { source: "pip", version: "1.0.0" },
      "ghost": { source: "artifact", version: "9.9.9" }, // no dir on disk
    },
  }),
  "utf8",
);

const paths = packs.getRuntimePackPythonPaths();
assert(paths.length === 1, `expected exactly one usable pack path, got ${JSON.stringify(paths)}`);
assert(paths[0] === proDir, "should return the artifact pack dir that exists on disk");
assert(!paths.some((p) => p.includes("legacy-pip")), "pip-source packs must be excluded (they install into the venv)");
assert(!paths.some((p) => p.includes("ghost")), "records without an on-disk dir must be excluded");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("runtime-packs: ok (reader contract, no electron mock)");
