#!/usr/bin/env node
// SVG and HTML go through the same render → inspect → check loop as documents.
// Field case 2026-09-30: with no render route for an .svg the agent opened it in
// the browser tool; file: URLs are blocked there, and a bare SVG document has no
// <body>, so the tool's page snapshot and full-page screenshot hung (30 s each).
// Real render_document.py, real browser, real receipt + ledger, real check tool.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveVenvPython, getRuntimeEnvExtras } = require("../src/main/runtime-python.js");
const python = resolveVenvPython();
if (!python) {
  console.log("test-web-render: ok (SKIPPED — no bundled runtime)");
  process.exit(0);
}
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lily-web-render-")));
const ledgers = { LILY_VISION_RECEIPTS_DIR: path.join(root, "ud", "vision"), LILY_RENDER_RECEIPTS_DIR: path.join(root, "ud", "render"), LILY_RECALC_RECEIPTS_DIR: path.join(root, "ud", "recalc") };
Object.assign(process.env, ledgers);
const env = { ...process.env, ...getRuntimeEnvExtras() };
const script = path.resolve("resources/runtime-scripts/render_document.py");
const render = (file, out) => {
  const started = Date.now();
  let stdout = "";
  try { stdout = execFileSync(python, [script, file, out, "2"], { env, encoding: "utf8", timeout: 90_000 }); } catch (error) { stdout = String(error.stdout || ""); }
  return { ...JSON.parse(stdout.trim().split("\n").pop()), ms: Date.now() - started };
};
const pngSize = (file) => { const b = fs.readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

const ws = path.join(root, "ws");
fs.mkdirSync(ws, { recursive: true });
const svg = path.join(ws, "架构.svg");
fs.writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 470"><rect width="960" height="470" fill="#fff"/><text x="40" y="60" font-size="32">交付流水线</text></svg>`);
try {
  const first = render(svg, path.join(root, "out-svg"));
  if (!first.ok && /no browser could be started/.test(first.error || "")) {
    console.log(`test-web-render: ok (SKIPPED — no browser on this machine: ${first.error.slice(0, 160)})`);
    process.exit(0);
  }
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.pages, 1);
  assert.deepEqual(pngSize(first.images[0]), [1920, 940], "a viewBox-only SVG is drawn at its own size (×2 density)");
  assert(first.ms < 30_000, `no hang (${first.ms} ms)`);
  assert(fs.existsSync(path.join(root, "out-svg", ".lily-render-receipt.json")), "the same receipt as documents");

  const fixed = path.join(ws, "fixed.svg");
  fs.writeFileSync(fixed, `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120"><rect width="300" height="120" fill="#eef"/></svg>`);
  assert.deepEqual(pngSize(render(fixed, path.join(root, "out-fixed")).images[0]), [600, 240], "an SVG with its own size keeps it");

  const html = path.join(ws, "看板.html");
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><body style="margin:0"><div style="height:2000px;background:linear-gradient(#fff,#ccf)">看板</div><script>console.error("boom")</script></body>`);
  const page = render(html, path.join(root, "out-html"));
  assert.equal(page.ok, true, JSON.stringify(page));
  assert.equal(page.pages, 3, "a 2000px page is three screen-height pages");
  assert.deepEqual(pngSize(page.images[0]), [2560, 1600]);
  assert.deepEqual(pngSize(page.images[2]), [2560, 800], "the last page is only as tall as what is left");
  assert(page.notes.some((note) => /console error: boom/.test(note)), "console errors are reported, not hidden");

  assert.match(render(path.join(ws, "x.txt"), path.join(root, "out-txt")).error || "", /UNSUPPORTED/, "other types still fail loudly");

  // The same loop as documents: rendered, inspected (vision ledger), checked.
  const { allToolDefinitions } = require("../src/main/mcp/tool-broker-registry.js");
  const tool = allToolDefinitions({ sessionId: "s1", workspacePath: ws }).find((item) => item.name === "lily_delivery_check");
  const before = await tool.handler({ paths: [svg] }, { sessionId: "s1", workspacePath: ws });
  assert.equal(before.files.length, 1, `lily_delivery_check checks an SVG like a document: ${JSON.stringify(before)}`);
  assert.deepEqual(before.files[0].missing, ["visual_inspection"], JSON.stringify(before));
  fs.mkdirSync(ledgers.LILY_VISION_RECEIPTS_DIR, { recursive: true });
  const { ledgerFileName } = require("../src/main/vision-inspection-receipt.js");
  fs.appendFileSync(path.join(ledgers.LILY_VISION_RECEIPTS_DIR, ledgerFileName(Date.now())),
    JSON.stringify({ version: 1, kind: "image_inspection", ok: true, path: first.images[0], at: Date.now() }) + "\n");
  const after = await tool.handler({ paths: [svg] }, { sessionId: "s1", workspacePath: ws });
  assert.equal(after.ok, true, JSON.stringify(after));
  // Scope: the turn's final gate still requires documents only — checking an SVG is the agent's call.
  const { assessDocumentDelivery } = require("../src/main/document-delivery-gate.js");
  assert.equal(assessDocumentDelivery({ artifacts: [{ path: svg, ext: ".svg", fileName: "架构.svg", source: "tool_write" }], tools: [] }).required, false,
    "a delivered SVG does not start a check round by itself");
  console.log("test-web-render: ok (runtime-backed)");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
