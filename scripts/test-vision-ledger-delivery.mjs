#!/usr/bin/env node
// Pages lily-vision really inspected count, whatever pipes its output, and the
// continuation asks only for what is missing. Field case 2026-09-30: the model
// ran `vision.js page-$p.png … 2>&1 | grep -v LILY_VISION_RECEIPT | tail -4`
// for all 30 pages; the gate saw 0 inspected, started a 文档交付续检 that did
// the same, and both answers ended "自动检查未全部完成（视觉检查）". The
// continuation listed every file, so three passed .md were re-verified too.
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ledgerInspections, ledgerFileName } = require("../src/main/vision-inspection-receipt.js");
const { assessDocumentDelivery } = require("../src/main/document-delivery-gate.js");
const { buildDocumentDeliveryRecoveryPrompt } = require("../src/main/document-delivery-recovery-prompt.js");
const { evaluateAnswerEvidence } = require("../src/main/answer-evidence-finalizer.js");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lily-vision-ledger-")));
const ledger = path.join(root, "userData", "vision-receipts");
const workspace = path.join(root, "qiche");
const docx = path.join(workspace, "output", "04-中国新能源汽车市场分析报告.docx");
const md = path.join(workspace, "output", "01-市场调研证据.md");
const pagesDir = path.join(workspace, ".lily-work", "verify2", "docx");
fs.mkdirSync(pagesDir, { recursive: true });
fs.mkdirSync(path.dirname(docx), { recursive: true });
fs.writeFileSync(docx, Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.from("[Content_Types].xml word/document.xml")]));
fs.writeFileSync(md, "# 调研\n\n| 指标 | 值 |\n|---|---|\n| 占比 | 60.6% |\n");
const pages = [1, 2, 3].map((n) => path.join(pagesDir, `page-${n}.png`));
for (const page of pages) fs.writeFileSync(page, Buffer.from("iVBORw0KGgo=", "base64"));
const stat = fs.statSync(docx);
// What render_document.py leaves beside the pages it wrote.
fs.writeFileSync(path.join(pagesDir, ".lily-render-receipt.json"), JSON.stringify({
  version: 1, kind: "document_render", source: docx, sourceMtimeMs: Math.floor(stat.mtimeMs), sourceBytes: stat.size, pages: 3, images: pages,
}));

const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "无乱码，无溢出" } }] }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const env = { ...process.env, VISION_API_KEY: "test-only", DASHSCOPE_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, LILY_VISION_RECEIPTS_DIR: ledger };
// The model's own pipe: every receipt line filtered out of what the tool returns.
const filtered = (stdout) => stdout.split("\n").filter((line) => !line.startsWith("LILY_VISION_RECEIPT")).join("\n");
const inspect = async (page) => filtered((await promisify(execFile)(process.execPath, ["resources/skills/lily-vision/vision.js", page, "检查"], { env, windowsHide: true })).stdout);

try {
  const turnStart = Date.now() - 1000;
  const artifacts = [
    { path: docx, ext: ".docx", fileName: path.basename(docx), source: "tool_write" },
    { path: md, ext: ".md", fileName: path.basename(md), source: "tool_write" },
  ];
  const renderTool = { name: "bash", status: "done", startedAt: turnStart, input: { command: `python3 render_document.py "${docx}" "${pagesDir}"` }, result: JSON.stringify({ ok: true, pages: 3, images: pages }) };
  const tools = [renderTool];
  for (const page of pages) tools.push({ name: "bash", status: "done", input: { command: `node vision.js ${page} | grep -v LILY_VISION_RECEIPT` }, result: await inspect(page) });
  assert(!tools.some((tool) => String(tool.result).includes("LILY_VISION_RECEIPT")), "the tool results carry no printed receipt, as in the field");
  assert(fs.existsSync(path.join(ledger, ledgerFileName(Date.now()))), "vision.js recorded its inspections in the host ledger");

  const visionInspections = ledgerInspections({ since: turnStart, dir: ledger });
  assert.deepEqual(visionInspections.map((entry) => entry.path).sort(), [...pages].sort());
  const verdict = assessDocumentDelivery({ artifacts, tools, visionInspections });
  assert.equal(verdict.ok, true, `all inspected pages count: ${JSON.stringify(verdict.missing)}`);
  assert.equal(assessDocumentDelivery({ artifacts, tools }).ok, false, "without the ledger: the field verdict (0 inspected)");

  // Not looser: an inspection from before this turn, or a page left unseen, does not count.
  assert.equal(ledgerInspections({ since: Date.now() + 60_000, dir: ledger }).length, 0, "inspections before the turn are not this turn's");
  const twoOfThree = assessDocumentDelivery({ artifacts, tools, visionInspections: visionInspections.filter((entry) => entry.path !== pages[2]) });
  assert.deepEqual(twoOfThree.missing, ["visual_inspection"], "an unseen page still fails the gate");
  fs.appendFileSync(path.join(ledger, ledgerFileName(Date.now())), "{torn\n");
  assert.equal(ledgerInspections({ since: turnStart, dir: ledger }).length, 3, "a torn line is skipped, not fatal");

  // No note on a verified delivery — the answer is delivered as written.
  const answer = "报告已生成：04-中国新能源汽车市场分析报告.docx";
  const finalized = evaluateAnswerEvidence({ assistant: answer, artifacts, tools, visionInspections, userText: "生成报告" });
  assert.equal(finalized.assistant, answer, "no 'not fully checked' note after a real inspection");
  assert.equal(finalized.triggerDocumentVerifyRetry, false, "no continuation round");

  // The continuation lists only what failed, and asks only for the missing check.
  const prompt = buildDocumentDeliveryRecoveryPrompt(twoOfThree, "生成报告");
  assert(prompt.includes(docx) && prompt.includes("缺：视觉检查"), prompt);
  assert(!prompt.includes(md), "a file that passed is not re-verified");
  assert(!prompt.includes("lily_capability_status"), "no dependency survey when nothing failed to render");
  assert(prompt.includes("逐页查看"), "the visual step is asked for");
  const renderMissing = buildDocumentDeliveryRecoveryPrompt({ artifacts: [{ path: docx, ok: false, missing: ["render"] }] }, "生成报告");
  assert(renderMissing.includes("lily_capability_status") && renderMissing.includes("render_document.py"), "a missing render keeps the dependency route");
  const legacy = buildDocumentDeliveryRecoveryPrompt({ artifacts: [{ path: docx }] }, "生成报告");
  for (const step of ["lily_capability_status", "recalc.py", "逐页查看"]) assert(legacy.includes(step), `an item without a verdict keeps the full checklist (${step})`);
  // Wiring: the skill writes where the host reads, and the turn's gate reads it.
  const spawnEnv = fs.readFileSync("src/main/spawn-env.js", "utf8");
  assert.match(spawnEnv, /LILY_VISION_RECEIPTS_DIR: require\("\.\/vision-inspection-receipt"\)\.visionReceiptsDir\(app\.getPath\("userData"\)\)/);
  const finalizer = fs.readFileSync("src/main/turn-terminal-finalizer.js", "utf8");
  assert.match(finalizer, /\.\.\.require\("\.\/delivery-ledgers"\)\.turnDeliveryEvidence\(state\)/, "the terminal gate is given this turn's ledgers");
  const { deliveryEvidenceSince, turnDeliveryEvidence } = require("../src/main/delivery-ledgers.js");
  assert.deepEqual(turnDeliveryEvidence({}).visionInspections, [], "no turn start: nothing, never an error");
  assert.equal(deliveryEvidenceSince(turnStart, { vision: ledger }).visionInspections.length, 3, "the turn's ledger is what the gate reads");
  process.env.LILY_VISION_LEDGER = "0";
  assert.deepEqual(deliveryEvidenceSince(turnStart, { vision: ledger }).visionInspections, [], "switched off: printed receipts only");
  delete process.env.LILY_VISION_LEDGER;
  console.log("test-vision-ledger-delivery: ok");
} finally {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
