#!/usr/bin/env node
//
// send-preflight orchestrates pre-send enrichment: notice sequence, outbound
// file pruning, and the failure shapes the orchestrator turns into failed turns.
// Mocks the vision/document translators so the orchestration is tested in
// isolation (plain node, no electron).

import path from "node:path";
import module from "node:module";
import { fileURLToPath } from "node:url";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- Mocks for the lazily-required translators ---
const RASTER_IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const visionMock = {
  buildEnrichedUserText: (text, extracted) => require(path.join(ROOT, "src/main/engine-message-layers.js")).appendExtractedContext(text, `[img:${extracted}]`, "Image recognition result"),
  hasVisionInputFiles: (files) => (files || []).some((f) => RASTER_IMAGE_RE.test(f?.path || f?.name || "")),
  isImageOnlyUserMessage: (text, files) => !text && (files || []).some((f) => RASTER_IMAGE_RE.test(f?.path || f?.name || "")),
  translateImages: async () => {
    visionMock._calls += 1;
    return visionMock._next;
  },
  _next: null,
  _calls: 0,
};
const documentMock = {
  buildEnrichedUserText: (text, extracted) => require(path.join(ROOT, "src/main/engine-message-layers.js")).appendExtractedContext(text, `[doc:${extracted}]`, "Document extraction result"),
  extractDocuments: async () => documentMock._next,
  hasDocumentInputFiles: (files) => (files || []).some((f) => /\.docx$/.test(f?.path || "")),
  isExtractableDocumentFile: (file) => /\.docx$/.test(file?.path || ""),
  isDocumentOnlyUserMessage: (text, files) => !text && (files || []).some((f) => /\.docx$/.test(f?.path || "")),
  _next: null,
};
function inject(rel, exports) {
  const p = require.resolve(path.join(ROOT, "src/main", rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
inject("vision-translator.js", visionMock);
inject("document-translator.js", documentMock);

const { runVisionPreflight, runDocumentPreflight, withoutVisionFiles } = require(
  path.join(ROOT, "src/main/send-preflight.js"),
);

const img = { path: "/a/pic.png", isImage: true };
const svgFile = { path: "/a/chart.svg", name: "chart.svg", isImage: true };
const txtFile = { path: "/a/notes.txt" };
const docFile = { path: "/a/report.docx" };

// withoutVisionFiles drops images, keeps the rest.
const kept = withoutVisionFiles([img, txtFile]);
assert(kept.length === 1 && kept[0] === txtFile, "withoutVisionFiles drops image files only");
const keptWithSvg = withoutVisionFiles([img, svgFile, txtFile]);
assert(
  keptWithSvg.includes(svgFile) && keptWithSvg.includes(txtFile) && !keptWithSvg.includes(img),
  "withoutVisionFiles must keep SVG/vector artifacts even when they are previewable images",
);

// No vision files → fast path, no notice emitted.
let notices = [];
let r = await runVisionPreflight("hi", [txtFile], { emitNotice: (n) => notices.push(n.code) });
assert(r.ok && r.text === "hi" && notices.length === 0, "no-image fast path emits nothing");
visionMock._calls = 0;
r = await runVisionPreflight("分析", [svgFile], { emitNotice: (n) => notices.push(n.code) });
assert(r.ok && r.text === "分析" && r.files.includes(svgFile), "SVG must pass through as a file, not as vision input");
assert(visionMock._calls === 0, "SVG must not call the raster vision bridge");

// Image-only + NO_KEY failure must still reach the engine with guarded context.
// WHY: users often send screenshots without any accompanying text; if the
// bridge is unavailable, the engine may still have native file support or tools
// that can inspect the source path. A failed preflight is strictly worse.
visionMock._next = { ok: false, reason: "NO_KEY" };
notices = [];
r = await runVisionPreflight("", [img], { emitNotice: (n) => notices.push(n.code) });
assert(r.ok && r.visionDegraded === true, "image-only NO_KEY should degrade, not fail");
assert(r.text.includes("Image recognition fallback"), "image-only NO_KEY should include fallback context");
assert(r.files.includes(img), "image-only NO_KEY should keep original image for engine/tools");
assert(r.visionEvidence?.status === "unavailable" && r.visionEvidence?.complete === false, "vision failure must not create successful source evidence");
assert(notices[0] === "visionPreparing" && notices.includes("visionSkipped"), "emits preparing then skipped on failure");

// FAIL-OPEN FIX: vision failure WITH accompanying text must not drop the image
// and answer blind. It should send explicit degraded context plus the source
// file so downstream native vision/tooling can continue.
visionMock._next = { ok: false, reason: "API_FAILED", detail: "timeout" };
r = await runVisionPreflight("分析这个布局", [img, txtFile], { emitNotice: () => {} });
assert(r.ok && r.visionDegraded === true, "text+image vision failure should degrade, not fail");
assert(r.text.includes("Image recognition fallback") && r.text.includes("timeout"), "vision failure should explain the degraded state");
assert(r.files.includes(img) && r.files.includes(txtFile), "vision failure should preserve original files");

// NO_KEY (vision not configured) WITH text follows the same guarded path.
visionMock._next = { ok: false, reason: "NO_KEY" };
r = await runVisionPreflight("分析这个布局", [img, txtFile], { emitNotice: () => {} });
assert(r.ok && r.visionDegraded === true, "NO_KEY + text should degrade with guarded context");
assert(r.text.includes("Image recognition fallback"), "NO_KEY + text should include fallback context");
assert(r.files.includes(img), "NO_KEY + text should keep the image for engine/tools");

// If the attachment metadata says image but the local file is not readable
// anymore, the bridge returns null. This must still reach the engine with the
// original metadata instead of stripping the only clue the model has.
visionMock._next = null;
r = await runVisionPreflight("变成白底照片", [img], { emitNotice: () => {} });
assert(r.ok && r.visionDegraded === true, "unreadable local image should degrade, not silently strip the attachment");
assert(r.text.includes("No readable local image file"), "unreadable image should explain the degraded state");
assert(r.files.includes(img), "unreadable image should preserve the original file metadata");

// NATIVE VISION: when the active model recognizes images itself, the Qwen
// bridge is skipped entirely and the image passes through untouched — it must
// reach the engine as a real image block, not a text description. Encodes WHY:
// a multimodal model should see the actual pixels, so we neither call Qwen nor
// strip the image.
visionMock._calls = 0;
visionMock._next = { ok: false, reason: "API_FAILED" }; // would fail the turn if Qwen were consulted
r = await runVisionPreflight("分析这张图", [img, txtFile], {
  nativeVision: true,
  emitNotice: () => { throw new Error("native vision must not emit notices"); },
});
assert(r.ok && r.text === "分析这张图", "native vision passes text through unchanged");
assert(r.files.includes(img) && r.files.includes(txtFile), "native vision keeps the image for the engine");
assert(visionMock._calls === 0, "native vision never calls the Qwen bridge");
assert(r.visionEvidence?.status === "available" && r.visionEvidence?.method === "native_model_input", "native input should be available without pretending host extraction completed");

// Vision success → enriched text + image pruned from outbound, ready notice.
visionMock._next = { ok: true, text: "a cat", keepOriginal: false };
notices = [];
r = await runVisionPreflight("look", [img, txtFile], { emitNotice: (n) => notices.push(n.code) });
assert(r.ok && r.text.includes('title="extracted_attachments"') && r.text.includes("[img:a cat]"), "vision success enriches text in extraction layer");
assert(r.text.includes('title="user_original_request"') && r.text.includes("look"), "vision success preserves original request layer");
assert(!r.files.some((f) => f.isImage), "image pruned from outbound files on success");
assert(notices.includes("visionReady"), "emits ready on success");
assert(r.visionEvidence?.status === "complete" && r.visionEvidence?.observedCount === 1, "vision bridge success should record complete source evidence");

// Document success → enriched + extracted file pruned.
documentMock._next = {
  ok: true,
  text: "contract terms",
  documentIndexText: "Document query index\n- doc-1#chunk-1 contract terms",
  extractedPaths: ["/a/report.docx"],
  keepOriginal: false,
};
r = await runDocumentPreflight("review", [docFile, txtFile], {});
assert(r.ok && r.text.includes('title="extracted_attachments"') && r.text.includes("contract terms"), "document success enriches text in extraction layer");
assert(r.text.includes("Document query index"), "document success includes compact query index when available");
assert(r.documentEvidence?.documents?.length === 0, "mock without structured index still returns a document evidence shape");
assert(r.text.includes('title="user_original_request"') && r.text.includes("review"), "document success preserves original request layer");
assert(!r.files.some((f) => f.path === "/a/report.docx"), "extracted document pruned from outbound");
assert(r.files.some((f) => f === txtFile), "non-extracted files kept");
assert(r.documentEvidence?.status === "complete" && r.documentEvidence?.observedCount === 1, "document extraction should expose source coverage evidence");

documentMock._next = {
  ok: true,
  text: "partial text\n[Content truncated, original length: 120000 characters]",
  extractedPaths: ["/a/report.docx"],
  keepOriginal: false,
};
r = await runDocumentPreflight("review", [docFile], {});
assert(r.documentEvidence?.status === "partial" && r.documentEvidence?.coverageLimited === true, "truncated extraction must disclose partial coverage");

// FAIL-SAFE: document failure must not stop the whole turn. It must also not
// silently become "answer from the user's prompt only" — the engine receives an
// explicit fallback context saying the document was not parsed and must not be
// summarized from metadata alone.
documentMock._next = { ok: false, detail: "corrupt" };
r = await runDocumentPreflight("总结这个文档", [docFile], {});
assert(r.ok, "text+doc document failure should continue with a guarded fallback");
assert(r.text.includes("Document extraction fallback"), "document fallback context missing");
assert(r.text.includes("corrupt"), "document fallback should include extraction error");
assert(r.text.includes("/a/report.docx"), "document fallback should include source path");
assert(r.text.includes("Do not summarize"), "document fallback must prevent blind answers");
assert(r.files.includes(docFile), "failed document should remain in outbound files for follow-up tooling");
assert(r.documentDegraded === true, "document failure should be marked degraded");
assert(r.documentEvidence?.status === "unavailable" && r.documentEvidence?.observedCount === 0, "failed document extraction must not count as observed content");
r = await runDocumentPreflight("", [docFile], {});
assert(r.ok && r.text.includes("Document extraction fallback"), "doc-only document failure should still reach the engine with fallback context");

console.log("send-preflight: ok");
