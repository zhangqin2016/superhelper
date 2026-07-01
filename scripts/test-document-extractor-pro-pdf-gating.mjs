#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { resolveVenvPython } = require("../src/main/runtime-python.js");

const python = resolveVenvPython();
const script = path.join(ROOT, "resources", "runtime-scripts", "extract_document.py");
const samplePdf = path.join(ROOT, "fixtures", "office", "sample.pdf");

if (!python || !fs.existsSync(samplePdf)) {
  console.log("test-document-extractor-pro-pdf-gating: skipped (runtime/sample pdf unavailable)");
  process.exit(0);
}

const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-fake-docling-"));
const doclingDir = path.join(fakeRoot, "docling");
fs.mkdirSync(doclingDir, { recursive: true });
fs.writeFileSync(path.join(doclingDir, "__init__.py"), "", "utf8");
fs.writeFileSync(
  path.join(doclingDir, "document_converter.py"),
  [
    "class DocumentConverter:",
    "    def convert(self, path):",
    "        class Document:",
    "            def export_to_markdown(self):",
    "                return 'FAKE PRO PDF RESULT'",
    "        class Result:",
    "            document = Document()",
    "        return Result()",
    "",
  ].join("\n"),
  "utf8",
);

function run(extraEnv = {}) {
  const result = spawnSync(python, [script, samplePdf], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: fakeRoot,
      ...extraEnv,
    },
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert(result.status === 0, `extract_document.py failed: ${result.stderr || result.stdout}`);
  const parsed = JSON.parse(result.stdout);
  assert(parsed.ok, `extract_document.py returned not ok: ${result.stdout}`);
  return parsed.text || "";
}

const defaultText = run();
assert(!defaultText.includes("FAKE PRO PDF RESULT"), "default PDF extraction must not auto-use importable pro-pdf/Docling");
assert(defaultText.includes("Quarterly Report"), "default PDF extraction should use the fast pdfplumber path");

const proText = run({ LILY_PDF_ENGINE: "pro-pdf" });
assert(proText.includes("FAKE PRO PDF RESULT"), "LILY_PDF_ENGINE=pro-pdf should opt into Docling/pro-pdf");

console.log("test-document-extractor-pro-pdf-gating: ok");
