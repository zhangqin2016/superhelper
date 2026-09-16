#!/usr/bin/env node
/**
 * Office/PDF content indexing.
 *
 * Acceptance 2026-09-16 DEF-003: indexing a directory gave every .docx/.xlsx/
 * .pptx/.pdf a single metadata chunk and counted it as indexed. A query for text
 * that really was in the document returned no matches and said nothing about
 * why, so the answer read as "the document does not contain that". The
 * indexPolicy those files carried (paragraph-index) was a promise no code kept.
 *
 * [gate: document-content-index]
 * Run: node scripts/test-document-content-index.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { indexPath, queryIndex } = require("../src/main/mcp/file-intelligence-index.js");
const {
  createContentExtractor,
  isContentExtractable,
  parseExtractorOutput,
} = require("../src/main/mcp/file-intelligence-content.js");
const { classifyExtractionResult } = require("../src/main/document-translator.js");
const { resolveVenvPython } = require("../src/main/runtime-python.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-doc-content-index-"));
const storeRoot = path.join(tmp, "store");
const workspace = path.join(tmp, "workspace");
fs.mkdirSync(workspace, { recursive: true });

const PHRASE = "STHeiti Light 字体嵌入验收结论";

try {
  check("the sync parser and document-translator's classifier agree on every stdout shape", () => {
    const cases = [
      JSON.stringify({ ok: true, text: "hello" }),
      JSON.stringify({ ok: false, error: "BOOM" }),
      "not json at all",
      "",
    ];
    for (const stdout of cases) {
      const sync = parseExtractorOutput(stdout);
      const async_ = classifyExtractionResult(null, stdout, 0);
      assert.equal(Boolean(sync.error), Boolean(async_.error), `error agreement for ${stdout.slice(0, 20)}`);
      if (!sync.error) assert.equal(sync.text, async_.text);
    }
  });

  check("extraction is bounded on every axis and every bound fails open to a reason", () => {
    const info = { kind: "document", bytes: 10 };
    assert.equal(isContentExtractable({ kind: "image" }), false, "an image has no text to index");
    assert.equal(isContentExtractable(info), true);

    const off = createContentExtractor({ enabled: false });
    assert.equal(off.extract("/a.docx", info).reason, "content_indexing_disabled");

    const never = () => { throw new Error("must not run"); };
    assert.equal(createContentExtractor({ enabled: true, runExtractor: never }).extract("/a.png", { kind: "image" }).reason, "kind_not_extractable:image");
    assert.equal(createContentExtractor({ enabled: true, maxFileBytes: 5, runExtractor: never }).extract("/a.docx", info).reason, "file_too_large:10");
    assert.equal(createContentExtractor({ enabled: true, maxFiles: 0, runExtractor: never }).extract("/a.docx", info).reason, "run_file_budget_reached");

    let clock = 0;
    const expired = createContentExtractor({ enabled: true, runBudgetMs: 10, now: () => clock, runExtractor: never });
    clock = 50;
    assert.equal(expired.extract("/a.docx", info).reason, "run_time_budget_reached");

    const twice = createContentExtractor({ enabled: true, maxFiles: 1, runExtractor: () => ({ text: "ok" }) });
    assert.equal(twice.extract("/a.docx", info).text, "ok");
    assert.equal(twice.extract("/b.docx", info).reason, "run_file_budget_reached", "the run budget is consumed, not per-file");

    assert.equal(createContentExtractor({ enabled: true, runExtractor: () => ({ text: "   " }) }).extract("/a.docx", info).reason, "extracted_empty");
    assert.equal(createContentExtractor({ enabled: true, runExtractor: () => { throw new Error("nope"); } }).extract("/a.docx", info).reason, "EXTRACT_FAILED:nope");
    assert.equal(createContentExtractor({ enabled: true, runExtractor: () => ({ error: "EXTRACT_TIMEOUT:20000ms" }) }).extract("/a.docx", info).reason, "EXTRACT_TIMEOUT:20000ms");
  });

  const python = resolveVenvPython();
  let docx = "";
  if (python) {
    docx = path.join(workspace, "acceptance-report.docx");
    const build = path.join(tmp, "build.py");
    fs.writeFileSync(build, [
      "from docx import Document",
      "import sys",
      "doc = Document()",
      "doc.add_heading('验收报告', 0)",
      "doc.add_paragraph(sys.argv[2])",
      "doc.save(sys.argv[1])",
    ].join("\n"));
    try {
      execFileSync(python, [build, docx, PHRASE], { timeout: 60_000, stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      docx = "";
    }
  }

  if (!docx) {
    console.log("skip - no bundled python runtime; content extraction not exercised end to end");
  } else {
    check("a Word document's TEXT is searchable after indexing, not just its file name", () => {
      const indexed = indexPath({ path: workspace, workspacePath: workspace, storeRoot, extractContent: true });
      assert.equal(indexed.ok, true);
      assert.equal(indexed.filesContentIndexed, 1, `content indexed: ${JSON.stringify(indexed.metadataOnly)}`);
      assert.equal(indexed.filesMetadataOnly, 0);
      const hit = queryIndex({ indexId: indexed.indexId, query: "字体嵌入", storeRoot, workspacePath: workspace });
      assert.equal(hit.ok, true);
      assert.ok(hit.matches.length > 0, "the document's own words find it");
      assert.ok(hit.matches.some((match) => match.sourcePath === docx), "the match points at the docx");
      assert.ok(
        hit.matches.some((match) => match.rangeType !== "metadata"),
        "the hit is real content, not the File:/Type:/Size: metadata card",
      );
    });

    check("without content extraction the document is reported metadata-only, and an empty query says so", () => {
      const indexed = indexPath({ path: workspace, workspacePath: workspace, storeRoot });
      assert.equal(indexed.filesContentIndexed, 0);
      assert.equal(indexed.filesMetadataOnly, 1);
      assert.equal(indexed.metadataOnly[0].sourcePath, docx);
      assert.equal(indexed.metadataOnly[0].reason, "content_indexing_disabled");
      assert.equal(indexed.filesIndexed, 1, "the file is still indexed by metadata — baseline is unchanged");

      const miss = queryIndex({ indexId: indexed.indexId, query: "字体嵌入", storeRoot, workspacePath: workspace });
      assert.equal(miss.ok, true);
      assert.deepEqual(miss.matches, []);
      assert.ok(Array.isArray(miss.metadataOnlyDocuments) && miss.metadataOnlyDocuments.length === 1,
        "an empty result must name the documents whose text was never indexed");
      assert.equal(miss.metadataOnlyDocuments[0].sourcePath, docx);
      assert.match(miss.note, /metadata only/i);
    });

    check("the kill switch restores the exact previous behaviour", () => {
      process.env.LILY_INDEX_DOCUMENT_CONTENT = "0";
      try {
        const indexed = indexPath({ path: workspace, workspacePath: workspace, storeRoot, extractContent: true });
        assert.equal(indexed.filesContentIndexed, 0, "the switch really disables extraction");
        assert.equal(indexed.filesIndexed, 1, "metadata indexing still works");
      } finally {
        delete process.env.LILY_INDEX_DOCUMENT_CONTENT;
      }
    });
  }

  console.log(`\n${checks} checks passed (document content index)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
