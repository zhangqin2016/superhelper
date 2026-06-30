#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { assert } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-runtime-health-"));
process.env.LILY_USER_DATA_DIR = tmp;

const bundledRoot = path.join(tmp, "bundled-runtime-packs");
process.env.LILY_BUNDLED_RUNTIME_PACK_ROOTS = bundledRoot;
const bundledWeb = path.join(bundledRoot, "web-automation");
fs.mkdirSync(path.join(bundledWeb, "node_modules", "playwright"), { recursive: true });
fs.mkdirSync(path.join(bundledWeb, "browsers"), { recursive: true });
fs.writeFileSync(path.join(bundledWeb, "node_modules", "playwright", "package.json"), "{}\n");

const packs = require(path.join(ROOT, "src/main/runtime-packs.js"));
const runtimePython = require(path.join(ROOT, "src/main/runtime-python.js"));
const health = require(path.join(ROOT, "src/main/runtime-health.js"));

function makeExecutable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    // Windows does not need chmod for .cmd.
  }
}

try {
  const web = await health.checkRuntimePackHealth("web-automation");
  assert(web.ok, `web automation health should pass with node_modules+browsers: ${JSON.stringify(web)}`);

  const pandocDir = packs.packDir("pandoc");
  const pandocExe =
    process.platform === "win32" ? path.join(pandocDir, "bin", "pandoc.cmd") : path.join(pandocDir, "bin", "pandoc");
  makeExecutable(pandocExe, process.platform === "win32" ? "@echo pandoc 3.10\r\n" : "#!/bin/sh\necho pandoc 3.10\n");

  const proPdfDir = packs.packDir("pro-pdf");
  fs.mkdirSync(path.join(proPdfDir, "docling"), { recursive: true });
  fs.writeFileSync(path.join(proPdfDir, "docling", "__init__.py"), "OK = True\n");

  fs.writeFileSync(
    packs.statePath(),
    JSON.stringify({
      schemaVersion: 1,
      installed: {
        pandoc: { source: "artifact", version: "3.10" },
        "pro-pdf": { source: "artifact", version: "2.102.1" },
      },
    }),
    "utf8",
  );

  const pandoc = await health.checkRuntimePackHealth("pandoc");
  assert(pandoc.ok, `pandoc health should execute the installed binary: ${JSON.stringify(pandoc)}`);

  if (runtimePython.resolveVenvPython()) {
    const proPdf = await health.checkRuntimePackHealth("pro-pdf");
    assert(proPdf.ok, `pro-pdf health should import from pack PYTHONPATH: ${JSON.stringify(proPdf)}`);
  }

  const all = await health.checkDependencyHealth("pandoc");
  assert(Array.isArray(all.base.checks), `base health missing checks: ${JSON.stringify(all)}`);
  assert(all.packs.length === 1 && all.packs[0].id === "pandoc", `scoped pack health mismatch: ${JSON.stringify(all)}`);

  const unknown = await health.checkRuntimePackHealth("does-not-exist");
  assert(!unknown.ok && unknown.error === "UNKNOWN_PACK", `unknown pack should fail loud: ${JSON.stringify(unknown)}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("runtime-health: ok");
