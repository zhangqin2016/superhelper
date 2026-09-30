#!/usr/bin/env node
// The agent runs the delivery gate itself before it answers, as Codex and
// Claude Code run the tests: lily_delivery_check gives the SAME verdict the
// turn's final gate gives, says exactly which pages are still unseen and what
// to do, and passes once they are seen. Field case 2026-09-30: the agent
// learned the bar only after answering (it spot-checked 4 of 7 pages), and a
// second round had to run. Real receipt writer, real vision.js, real registry.
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lily-delivery-tool-")));
const dirs = { vision: path.join(root, "ud", "vision-receipts"), render: path.join(root, "ud", "render-receipts"), recalc: path.join(root, "ud", "recalc-receipts") };
Object.assign(process.env, { LILY_VISION_RECEIPTS_DIR: dirs.vision, LILY_RENDER_RECEIPTS_DIR: dirs.render, LILY_RECALC_RECEIPTS_DIR: dirs.recalc });
const { allToolDefinitions } = require("../src/main/mcp/tool-broker-registry.js");
const { assessDocumentDelivery } = require("../src/main/document-delivery-gate.js");
const { deliveryEvidenceSince } = require("../src/main/delivery-ledgers.js");

const workspace = path.join(root, "ws");
const docx = path.join(workspace, "output", "报告.docx");
fs.mkdirSync(path.dirname(docx), { recursive: true });
fs.writeFileSync(docx, Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.from("[Content_Types].xml word/document.xml")]));
const pagesDir = path.join(workspace, ".lily-work", "render");
fs.mkdirSync(pagesDir, { recursive: true });
const pages = [1, 2, 3].map((n) => { const f = path.join(pagesDir, `page-${n}.png`); fs.writeFileSync(f, `png-${n}`); return f; });
const render = () => execFileSync("python3", ["-c",
  "import sys, json; sys.path.insert(0, 'resources/runtime-scripts'); import render_document as r; r._write_receipt(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]))",
  docx, pagesDir, JSON.stringify(pages)], { env: process.env });
const server = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] })); }); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const inspect = (page) => promisify(execFile)(process.execPath, ["resources/skills/lily-vision/vision.js", page, "检查"],
  { env: { ...process.env, VISION_API_KEY: "test-only", DASHSCOPE_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` } });
const tool = allToolDefinitions({ sessionId: "s1", workspacePath: workspace }).find((item) => item.name === "lily_delivery_check");
const check = (paths) => tool.handler({ paths }, { sessionId: "s1", workspacePath: workspace });
const gate = () => assessDocumentDelivery({ artifacts: [{ path: docx, ext: ".docx", fileName: "报告.docx", source: "tool_write" }], tools: [], ...deliveryEvidenceSince(Date.now() - 3_600_000, dirs) });

try {
  assert(tool, "lily_delivery_check is a platform tool");
  assert.equal(tool.annotations.readOnlyHint, true);

  const unrendered = await check(["output/报告.docx"]);
  assert.equal(unrendered.ok, false);
  assert.deepEqual(unrendered.files[0].missing, ["render"]);
  assert.match(unrendered.files[0].next.join(" "), /render_document\.py/, "it says how to render");

  render();
  await new Promise((r) => setTimeout(r, 5));
  await inspect(pages[0]);
  const partial = await check([docx]);
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.files[0].missing, ["visual_inspection"]);
  assert.deepEqual(partial.files[0].uninspectedPages, [pages[1], pages[2]], "it names the pages still unseen");
  assert.match(partial.files[0].next.join(" "), /lily-vision/);
  assert.equal(gate().ok, partial.ok, "the same verdict as the final gate");

  await inspect(pages[1]);
  await inspect(pages[2]);
  const passed = await check([docx]);
  assert.equal(passed.ok, true, JSON.stringify(passed));
  assert.equal(gate().ok, true, "the final gate agrees");

  // Re-rendering overwrites the pages: what was seen before is not seen now.
  await new Promise((r) => setTimeout(r, 5));
  render();
  const rerendered = await check([docx]);
  assert.equal(rerendered.ok, false, "inspections before the current render do not count");
  assert.equal(rerendered.files[0].uninspectedPages.length, 3);

  const outside = await check([path.join(root, "elsewhere.docx")]);
  assert.equal(outside.ok, false);
  assert.equal(outside.outsideWorkspace.length, 1, "files outside the workspace are not checked");
  const notDoc = await check(["output/data.json"]);
  assert.deepEqual(notDoc.notChecked, [path.join(workspace, "output", "data.json")]);
  console.log("test-delivery-check-tool: ok");
} finally {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
