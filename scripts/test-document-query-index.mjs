#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildDocumentQueryIndex,
  formatDocumentQueryIndexForPrompt,
} = require("../src/main/document-query-index.js");

const index = buildDocumentQueryIndex([
  {
    label: "contract.pdf",
    path: "/tmp/contract.pdf",
    text: "# Payment Terms\nThe buyer pays within 30 days.\n\n# Termination\nEither party may terminate for breach.",
  },
]);

assert.equal(index.schemaVersion, 1);
assert.equal(index.documents.length, 1);
assert.equal(index.documents[0].id, "doc1");
assert(index.chunks.length >= 2, "index should split document text into searchable chunks");
assert.equal(index.chunks[0].documentId, "doc1");
assert.equal(index.chunks[0].chunkId, "doc1-chunk1");
assert(index.chunks[0].excerpt.includes("Payment Terms"));
assert(index.chunks[0].charStart >= 0);
assert(index.chunks[0].charEnd > index.chunks[0].charStart);

const prompt = formatDocumentQueryIndexForPrompt(index);
assert(prompt.includes("[Document Query Index]"));
assert(prompt.includes("doc1-chunk1"));
assert(prompt.includes("contract.pdf"));
assert(prompt.includes("/tmp/contract.pdf"));
assert(prompt.includes("Use chunk ids, document labels, and source paths when citing uploaded document evidence."));

const emptyPrompt = formatDocumentQueryIndexForPrompt(buildDocumentQueryIndex([]));
assert.equal(emptyPrompt, "");

console.log("document-query-index: ok");
