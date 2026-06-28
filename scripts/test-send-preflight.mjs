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
const visionMock = {
  buildEnrichedUserText: (text, extracted) => require(path.join(ROOT, "src/main/engine-message-layers.js")).appendExtractedContext(text, `[img:${extracted}]`, "Image recognition result"),
  hasVisionInputFiles: (files) => (files || []).some((f) => f?.isImage),
  isImageOnlyUserMessage: (text, files) => !text && (files || []).some((f) => f?.isImage),
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
const txtFile = { path: "/a/notes.txt" };
const docFile = { path: "/a/report.docx" };

// withoutVisionFiles drops images, keeps the rest.
const kept = withoutVisionFiles([img, txtFile]);
assert(kept.length === 1 && kept[0] === txtFile, "withoutVisionFiles drops image files only");

// No vision files → fast path, no notice emitted.
let notices = [];
let r = await runVisionPreflight("hi", [txtFile], { emitNotice: (n) => notices.push(n.code) });
assert(r.ok && r.text === "hi" && notices.length === 0, "no-image fast path emits nothing");

// Image-only + NO_KEY failure → VISION_UNAVAILABLE, with preparing→skipped notices.
visionMock._next = { ok: false, reason: "NO_KEY" };
notices = [];
r = await runVisionPreflight("", [img], { emitNotice: (n) => notices.push(n.code) });
assert(!r.ok && r.error === "VISION_UNAVAILABLE", "image-only NO_KEY → VISION_UNAVAILABLE");
assert(notices[0] === "visionPreparing" && notices.includes("visionSkipped"), "emits preparing then skipped on failure");

// FAIL-LOUD FIX: vision failure WITH accompanying text must also fail (it used
// to silently drop the image and send bare text, making the engine answer blind
// — the screenshot-analyzed-the-directory bug).
visionMock._next = { ok: false, reason: "API_FAILED", detail: "timeout" };
r = await runVisionPreflight("分析这个布局", [img, txtFile], { emitNotice: () => {} });
assert(!r.ok && r.error === "VISION_FAILED" && r.detail === "timeout", "text+image vision failure must fail loud, not drop the image");

// But NO_KEY (vision not configured) WITH text still degrades to a text-only
// answer — a deployment without vision should not be blocked.
visionMock._next = { ok: false, reason: "NO_KEY" };
r = await runVisionPreflight("分析这个布局", [img, txtFile], { emitNotice: () => {} });
assert(r.ok && r.text === "分析这个布局" && !r.files.some((f) => f.isImage), "NO_KEY + text degrades to text-only (not a hard failure)");

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

// Vision success → enriched text + image pruned from outbound, ready notice.
visionMock._next = { ok: true, text: "a cat", keepOriginal: false };
notices = [];
r = await runVisionPreflight("look", [img, txtFile], { emitNotice: (n) => notices.push(n.code) });
assert(r.ok && r.text.includes('title="extracted_attachments"') && r.text.includes("[img:a cat]"), "vision success enriches text in extraction layer");
assert(r.text.includes('title="user_original_request"') && r.text.includes("look"), "vision success preserves original request layer");
assert(!r.files.some((f) => f.isImage), "image pruned from outbound files on success");
assert(notices.includes("visionReady"), "emits ready on success");

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

// Document-only failure → DOCUMENT_FAILED (text+doc keeps degrading to text).
documentMock._next = { ok: false, detail: "corrupt" };
r = await runDocumentPreflight("", [docFile], {});
assert(!r.ok && r.error === "DOCUMENT_FAILED" && r.detail === "corrupt", "doc-only failure → DOCUMENT_FAILED");

console.log("send-preflight: ok");
