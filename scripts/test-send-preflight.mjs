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
  buildEnrichedUserText: (text, extracted) => `${text}\n[img:${extracted}]`,
  hasVisionInputFiles: (files) => (files || []).some((f) => f?.isImage),
  isImageOnlyUserMessage: (text, files) => !text && (files || []).some((f) => f?.isImage),
  translateImages: async () => visionMock._next,
  _next: null,
};
const documentMock = {
  buildEnrichedUserText: (text, extracted) => `${text}\n[doc:${extracted}]`,
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

// Vision success → enriched text + image pruned from outbound, ready notice.
visionMock._next = { ok: true, text: "a cat", keepOriginal: false };
notices = [];
r = await runVisionPreflight("look", [img, txtFile], { emitNotice: (n) => notices.push(n.code) });
assert(r.ok && r.text === "look\n[img:a cat]", "vision success enriches text");
assert(!r.files.some((f) => f.isImage), "image pruned from outbound files on success");
assert(notices.includes("visionReady"), "emits ready on success");

// Document success → enriched + extracted file pruned.
documentMock._next = { ok: true, text: "contract terms", extractedPaths: ["/a/report.docx"], keepOriginal: false };
r = await runDocumentPreflight("review", [docFile, txtFile], {});
assert(r.ok && r.text === "review\n[doc:contract terms]", "document success enriches text");
assert(!r.files.some((f) => f.path === "/a/report.docx"), "extracted document pruned from outbound");
assert(r.files.some((f) => f === txtFile), "non-extracted files kept");

// Document-only failure → DOCUMENT_FAILED.
documentMock._next = { ok: false, detail: "corrupt" };
r = await runDocumentPreflight("", [docFile], {});
assert(!r.ok && r.error === "DOCUMENT_FAILED" && r.detail === "corrupt", "doc-only failure → DOCUMENT_FAILED");

console.log("send-preflight: ok");
