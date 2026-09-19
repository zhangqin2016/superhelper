#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const { resolveVenvPython, getRuntimeEnvExtras } = require("../src/main/runtime-python.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "resources", "runtime-scripts", "render_document.py");
const FIXTURES = path.join(ROOT, "fixtures", "office");

assert(fs.existsSync(SCRIPT), "render_document.py must exist");

const python = resolveVenvPython();
if (!python) {
  console.log("test-render-document: ok (SKIPPED — no bundled runtime)");
  process.exit(0);
}

const env = { ...process.env, ...getRuntimeEnvExtras() };
const run = (args) =>
  JSON.parse(execFileSync(python, [SCRIPT, ...args], { encoding: "utf8", env }));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-render-"));

// PDF path needs no LibreOffice — rasterized directly. A page image must land on
// disk and be a non-empty PNG, because the whole point is giving the model real
// pixels to inspect, not just a success flag.
if (fs.existsSync(path.join(FIXTURES, "sample.pdf"))) {
  const out = path.join(tmp, "pdf");
  const res = run([path.join(FIXTURES, "sample.pdf"), out]);
  assert(res.ok, `pdf render failed: ${JSON.stringify(res)}`);
  assert(res.pages >= 1, "pdf render should report at least one page");
  assert(res.images.length === res.pages, "images count must match pages");
  for (const img of res.images) {
    assert(fs.existsSync(img) && fs.statSync(img).size > 0, `rendered image missing/empty: ${img}`);
  }
}

// Office path goes through LibreOffice → PDF → images. Skip only if LibreOffice
// isn't in the bundle, and say so — never pass it off as covered.
const haveLibreOffice = Boolean(env.LILY_LIBREOFFICE_PROGRAM);
if (haveLibreOffice && fs.existsSync(path.join(FIXTURES, "sample.docx"))) {
  const out = path.join(tmp, "docx");
  const res = run([path.join(FIXTURES, "sample.docx"), out]);
  assert(res.ok, `docx render failed: ${JSON.stringify(res)}`);
  assert(res.pages >= 1 && res.images.length === res.pages, "docx should render to page images");
  assert(fs.statSync(res.images[0]).size > 0, "docx page image should be non-empty");
} else {
  console.log("test-render-document: (office→image SKIPPED — LibreOffice not bundled)");
}

// Unsupported extensions must fail loudly, not produce zero images and "ok".
const txt = path.join(tmp, "note.txt");
fs.writeFileSync(txt, "hi", "utf8");
let rejected = false;
try {
  execFileSync(python, [SCRIPT, txt, path.join(tmp, "txt")], { encoding: "utf8", env });
} catch (err) {
  rejected = true;
  assert(/UNSUPPORTED/.test(err.stdout || ""), `expected UNSUPPORTED, got ${err.stdout}`);
}
assert(rejected, "unsupported extension should exit non-zero");

fs.rmSync(tmp, { recursive: true, force: true });
// Charts are written to files and never shown, but matplotlib does not know
// that: on macOS it defaults to the `macosx` backend, which links AppKit and
// creates an NSApplication, so every Python process importing pyplot takes a
// Dock icon for as long as it lives — a user generating a batch watched fifteen
// appear at once. Agg is the headless backend matplotlib already renders through
// when saving, so the output is identical and nothing is lost.
{
  const extras = getRuntimeEnvExtras();
  assert(extras.MPLBACKEND === "Agg", "the runtime env forces the headless backend");
  // On the runtime env rather than inside our own helpers, so it also covers
  // scripts the agent writes itself — which is where the batch comes from.
  const src = fs.readFileSync(new URL("../src/main/runtime-python.js", import.meta.url), "utf8");
  assert(/extras\.MPLBACKEND = process\.env\.MPLBACKEND \|\| "Agg"/.test(src), "and an explicit choice from the environment still wins");
  console.log("ok - matplotlib runs headless, so charts no longer take a Dock icon each");
}

console.log("test-render-document: ok (runtime-backed)");
