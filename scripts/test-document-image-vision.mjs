#!/usr/bin/env node
// OCR recovers the characters inside a document's pictures; it cannot say what
// a chart MEANS. When a vision recognizer is configured those pictures get a
// description BESIDE the OCR text — never instead of it — and the model is told
// the description came from another model. Every failure path must return the
// document exactly as OCR left it. [gate: attachment-content-grounding]
// Run: node scripts/test-document-image-vision.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { spliceDescription, prioritize } = require("../src/main/document-image-vision.js");

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lily-doc-vision-"));
let checks = 0;
const check = (name) => { checks += 1; console.log(`ok - ${name}`); };
const image = (name) => { const p = path.join(root, name); fs.writeFileSync(p, "x"); return p; };

try {
  // The description lands after that picture's OCR block, not inside another's.
  const text = [
    "paragraph before",
    "",
    "[Image 1] INVOICE 85321",
    "Contract A-2026",
    "",
    "paragraph after",
    "",
    "[Image 2: no readable text]",
    "",
    "tail",
  ].join("\n");
  const one = spliceDescription(text, 1, "A scanned invoice header.");
  const lines = one.split("\n");
  assert.equal(lines[lines.indexOf("Contract A-2026") + 1], "[Image 1 described] A scanned invoice header.");
  assert.ok(one.includes("[Image 2: no readable text]"), "other markers are untouched");
  const two = spliceDescription(one, 2, "A bar chart with no labels.");
  assert.equal(two.split("\n")[two.split("\n").indexOf("[Image 2: no readable text]") + 1], "[Image 2 described] A bar chart with no labels.");
  assert.ok(two.indexOf("INVOICE 85321") < two.indexOf("A scanned invoice") && two.indexOf("A scanned invoice") < two.indexOf("paragraph after"),
    "OCR text stays first and in place");
  check("a description is spliced after its own picture, never over another");

  assert.equal(spliceDescription(text, 9, "x"), text, "an unknown index changes nothing");
  check("an unmatched marker leaves the document untouched");

  // Pictures OCR could read least go first: that is where a description adds most.
  const ordered = prioritize([
    { index: 1, path: image("a.png"), text: "a".repeat(300) },
    { index: 2, path: image("b.png"), text: "" },
    { index: 3, path: image("c.png"), text: "short" },
    { index: 4, path: path.join(root, "missing.png"), text: "" },
  ]);
  assert.deepEqual(ordered.map((item) => item.index), [2, 3, 1], "least-readable first, missing files dropped");
  check("the picture order favours what OCR could not read");

  process.env.LILY_DOC_IMAGE_VISION_MAX = "2";
  assert.equal(prioritize([
    { index: 1, path: image("d.png"), text: "" },
    { index: 2, path: image("e.png"), text: "" },
    { index: 3, path: image("f.png"), text: "" },
  ]).length, 2, "the cap is honoured");
  delete process.env.LILY_DOC_IMAGE_VISION_MAX;
  check("the per-document cap is honoured");

  // Every refusal path returns the document exactly as OCR left it.
  const { describeDocumentImages } = require("../src/main/document-image-vision.js");
  const images = [{ index: 1, path: image("g.png"), text: "" }];
  const original = "[Image 1: no readable text]";

  process.env.LILY_DOC_IMAGE_VISION = "0";
  let out = await describeDocumentImages({ text: original, images });
  assert.equal(out.text, original); assert.equal(out.reason, "disabled");
  delete process.env.LILY_DOC_IMAGE_VISION;
  check("the kill switch returns the OCR text unchanged");

  out = await describeDocumentImages({ text: original, images: [] });
  assert.equal(out.text, original); assert.equal(out.reason, "no_images");
  check("a document without pictures is untouched");

  const vision = require("../src/main/vision-translator.js");
  const hadKey = vision.hasVisionApiKey;
  vision.hasVisionApiKey = () => false;
  out = await describeDocumentImages({ text: original, images });
  assert.equal(out.text, original); assert.equal(out.reason, "no_key");
  check("no vision key means no change, not an error");

  // A bridge outage must never cost the document its OCR text.
  vision.hasVisionApiKey = () => true;
  const runner = require("../src/main/vision-bridge-runner.js");
  const hadBridge = runner.bridgeImagesConcurrently;
  runner.bridgeImagesConcurrently = async () => { throw new Error("bridge down"); };
  out = await describeDocumentImages({ text: original, images });
  assert.equal(out.text, original); assert.equal(out.reason, "bridge_failed");
  check("a bridge outage leaves the OCR text intact");

  // A successful description is added beside the OCR text, with provenance.
  runner.bridgeImagesConcurrently = async (files) => files.map((file) => ({ ok: true, file, text: "A quarterly revenue bar chart trending up." }));
  out = await describeDocumentImages({ text: "[Image 1] REVENUE Q3", images: [{ index: 1, path: image("h.png"), text: "REVENUE Q3" }] });
  assert.match(out.text, /\[Image 1\] REVENUE Q3/, "OCR text is kept");
  assert.match(out.text, /\[Image 1 described\] A quarterly revenue bar chart/, "the description is added");
  assert.match(out.text, /separate image-recognition model/, "provenance is stated once");
  assert.equal(out.described, 1);
  check("a description is added beside the OCR text with provenance");

  // A bridge that answers nothing usable must not add an empty line or a note.
  runner.bridgeImagesConcurrently = async (files) => files.map((file) => ({ ok: true, file, text: "   " }));
  out = await describeDocumentImages({ text: original, images });
  assert.equal(out.text, original); assert.equal(out.reason, "none_described");
  check("an empty description adds nothing");

  runner.bridgeImagesConcurrently = hadBridge;
  vision.hasVisionApiKey = hadKey;
  console.log(`document-image-vision: ok (${checks} checks)`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
