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
  // The render receipt: the delivery gate's proof of this render, whatever a
  // calling script prints (2026-09-29: a wrapper printed only "pages 18").
  const receipt = JSON.parse(fs.readFileSync(path.join(out, ".lily-render-receipt.json"), "utf8"));
  assert(receipt.kind === "document_render" && receipt.source === path.join(FIXTURES, "sample.pdf"), `receipt names its source: ${JSON.stringify(receipt)}`);
  assert(JSON.stringify(receipt.images) === JSON.stringify(res.images.map((img) => path.resolve(img))), "receipt lists the page images");
  const { assessDocumentDelivery } = require("../src/main/document-delivery-gate.js");
  const delivered = assessDocumentDelivery({
    taskContract: { taskType: "document_work", semanticIntent: { operation: "create", outputMode: "artifact" }, evidencePolicy: { required: true, requiredEvidenceKinds: ["document_output"] } },
    artifacts: [{ path: path.join(FIXTURES, "sample.pdf"), ext: ".pdf" }],
    tools: res.images.map((img) => ({ name: "bash", status: "done", result: `LILY_VISION_RECEIPT ${JSON.stringify({ version: 1, kind: "image_inspection", ok: true, path: img })}` })),
  });
  assert(delivered.ok, `a real render plus vision receipts verifies the delivery: ${JSON.stringify(delivered.missing)}`);
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
  assert(res.package?.checked === true && res.package.count === 0, `a clean docx has no schema violations: ${JSON.stringify(res.package)}`);

  // A package LibreOffice renders but Word refuses (2026-09-29: DrawingML fonts
  // inside w:rPr). The render still succeeds; its receipt carries the schema
  // check, and the delivery gate's structure check fails on it, naming the part.
  // [gate: docx-run-font-schema]
  const bad = path.join(tmp, "foreign-markup.docx");
  execFileSync(python, ["-c", [
    "import sys",
    "from docx import Document",
    "from docx.oxml.ns import qn",
    "d = Document()",
    "r = d.add_paragraph().add_run('中文 text')",
    "rpr = r._r.get_or_add_rPr()",
    "rpr.append(rpr.makeelement('{http://schemas.openxmlformats.org/drawingml/2006/main}latin', {'typeface': 'Arial'}))",
    "d.save(sys.argv[1])",
  ].join("\n"), bad], { env });
  const badOut = path.join(tmp, "foreign");
  const badRes = run([bad, badOut]);
  assert(badRes.ok, "the render itself succeeds — LibreOffice tolerates the markup");
  assert(badRes.package?.checked === true && badRes.package.count === 1, `the renderer reports the foreign element: ${JSON.stringify(badRes.package)}`);
  assert(/w:rPr\/\w+:latin$/.test(badRes.package.violations[0].node), `the violation names the node: ${badRes.package.violations[0].node}`);
  const { assessDocumentDelivery, buildDocumentDeliveryRecoveryPrompt } = require("../src/main/document-delivery-gate.js");
  const verdict = (file, images) => assessDocumentDelivery({
    taskContract: { taskType: "document_work", semanticIntent: { operation: "create", outputMode: "artifact" } },
    artifacts: [{ path: file, ext: ".docx" }],
    tools: images.map((img) => ({ name: "bash", status: "done", result: `LILY_VISION_RECEIPT ${JSON.stringify({ version: 1, kind: "image_inspection", ok: true, path: img })}` })),
  });
  const refused = verdict(bad, badRes.images);
  assert(refused.missing.includes("structure") && refused.artifacts[0].checks.structure.reason === "ooxml_schema_violation",
    `a file Word refuses does not pass the structure check: ${JSON.stringify(refused.artifacts[0].checks.structure)}`);
  assert(!refused.missing.includes("render") && !refused.missing.includes("visual_inspection"), "render and vision still count");
  const prompt = buildDocumentDeliveryRecoveryPrompt(refused, "请生成报告");
  assert(prompt.includes("word/document.xml") && /latin/.test(prompt), "the follow-up names the offending part and element");
  const clean = verdict(path.join(FIXTURES, "sample.docx"), res.images);
  assert(!clean.missing.includes("structure"), `a clean docx still passes structure: ${JSON.stringify(clean.missing)}`);
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
