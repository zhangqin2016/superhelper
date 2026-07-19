#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  extractExplicitNegativePhrases,
  inferContentTaskIntent,
} = require("../src/main/content-task-intent.js");

const image = { name: "screen.png", path: "/tmp/screen.png", isImage: true };
const pdf = { name: "report.pdf", path: "/tmp/report.pdf" };

const imageRead = inferContentTaskIntent({ text: "识别这张图片里的内容", files: [image] });
assert.equal(imageRead.operation, "extract");
assert.equal(imageRead.outputMode, "answer");
assert.equal(imageRead.routeTaskType, "content_extraction");
assert.deepEqual(imageRead.attachmentKinds, ["image"]);

const pdfSummary = inferContentTaskIntent({ text: "分析并总结这个 PDF", files: [pdf] });
assert.equal(pdfSummary.operation, "understand");
assert.equal(pdfSummary.routeTaskType, "content_extraction");
assert(pdfSummary.sourceKinds.includes("pdf"));

const attachmentOnly = inferContentTaskIntent({ text: "", files: [image] });
assert.equal(attachmentOnly.operation, "understand");
assert.equal(attachmentOnly.routeTaskType, "content_extraction");

const imageEdit = inferContentTaskIntent({ text: "把这张图片改成白底", files: [image] });
assert.equal(imageEdit.operation, "modify");
assert.equal(imageEdit.outputMode, "artifact");
assert.equal(imageEdit.routeTaskType, "media_generation");

const pdfConvert = inferContentTaskIntent({ text: "把这个 PDF 转成 Word", files: [pdf] });
assert.equal(pdfConvert.operation, "convert");
assert.equal(pdfConvert.outputMode, "artifact");
assert.equal(pdfConvert.routeTaskType, "document_work");

const engineering = inferContentTaskIntent({ text: "实现 PDF OCR 识别模块", files: [] });
assert.equal(engineering.routeTaskType, "", "engineering requests must stay with code routing");
assert(engineering.reasonCodes.includes("engineering_context_preserved"));
assert.doesNotThrow(() => inferContentTaskIntent({ text: "识别附件", files: [null, "bad-metadata"] }));

assert.deepEqual(extractExplicitNegativePhrases("识别这个 PDF 里的内容"), []);
assert.deepEqual(extractExplicitNegativePhrases("分别处理两张图片"), []);
assert.deepEqual(extractExplicitNegativePhrases("请别猜测，不要搜索"), ["不要搜索", "请别猜测"]);

console.log("content-task-intent: ok");
