#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { assert, assertEqual } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-runtime-pack-preflight-"));
process.env.LILY_USER_DATA_DIR = tmp;
process.env.LILY_BUNDLED_RUNTIME_PACK_ROOTS = path.join(tmp, "bundled-runtime-packs");

const { inferRuntimePackIds, preflightRuntimePacks } = require(
  path.join(ROOT, "src/main/runtime-pack-preflight.js"),
);

function includes(ids, id, message) {
  assert(ids.includes(id), `${message}; got ${JSON.stringify(ids)}`);
}

function excludes(ids, id, message) {
  assert(!ids.includes(id), `${message}; got ${JSON.stringify(ids)}`);
}

let ids = inferRuntimePackIds({ files: [{ name: "report.xlsx" }] });
includes(ids, "libreoffice", "Office files should require LibreOffice");

ids = inferRuntimePackIds({ text: "把这个文档导出 PDF" });
includes(ids, "libreoffice", "Office conversion text should require LibreOffice");

ids = inferRuntimePackIds({ files: [{ name: "contract.pdf" }] });
includes(ids, "large-document", "PDF files should require the large document engine");
includes(ids, "pro-pdf", "PDF files should require pro PDF extraction");

ids = inferRuntimePackIds({ text: "识别截图里的表格", files: [{ name: "screen.png", isImage: true }] });
includes(ids, "rapidocr", "Image OCR should require RapidOCR");
includes(ids, "opencv", "Image OCR should require OpenCV preprocessing");

ids = inferRuntimePackIds({ text: "学习这个 OA 系统并生成工作区技能" });
includes(ids, "web-automation", "Web system learning should require browser automation");

ids = inferRuntimePackIds({ text: "把这个视频裁剪并压缩", files: [{ name: "demo.mp4" }] });
includes(ids, "ffmpeg", "Media processing should require FFmpeg");

ids = inferRuntimePackIds({ text: "帮我生成一张 AI 工作台图片" });
excludes(ids, "rapidocr", "Remote image generation should not require local OCR");
excludes(ids, "ffmpeg", "Remote image generation should not require media processing");

ids = inferRuntimePackIds({ presetId: "office-starter" });
includes(ids, "libreoffice", "Office starter should prepare LibreOffice");
includes(ids, "large-document", "Office starter should prepare the large document engine");
includes(ids, "pro-pdf", "Office starter should prepare pro PDF extraction");
includes(ids, "rapidocr", "Office starter should prepare OCR for scanned documents");
includes(ids, "opencv", "Office starter should prepare image preprocessing for OCR");

const preflight = preflightRuntimePacks({ text: "学习这个 OA 系统" });
assert(preflight.ok, "preflight should succeed");
assertEqual(preflight.blocking, false, "runtime pack preflight must be advisory, not a send blocker");
includes(preflight.requiredPackIds, "web-automation", "preflight should report required pack ids");
includes(preflight.missingPackIds, "web-automation", "fresh user data should miss web automation");
assert(
  preflight.missingPacks.some((pack) => pack.id === "web-automation" && pack.label && pack.sizeEstimate),
  `missing packs should include install metadata, got ${JSON.stringify(preflight.missingPacks)}`,
);
assert(/runtime_pack_install|manage_runtime_pack\.py/.test(preflight.agentAdvisory), "agent advisory should include an executable dependency path");
assert(/do not invoke OpenCode native `skill <id>`/.test(preflight.agentAdvisory), "agent advisory should forbid OpenCode native skill invocation");
assert(!/Use lily-runtime-packs skill/i.test(preflight.agentAdvisory), "agent advisory should not describe Lily runtime packs as native skills");
assert(/Do not block|不要阻塞/.test(preflight.agentAdvisory), "agent advisory should explicitly forbid blocking the user turn");
assert(/web-automation/.test(preflight.agentAdvisory), "agent advisory should name the missing pack");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("runtime-pack-preflight: ok");
