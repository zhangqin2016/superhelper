#!/usr/bin/env node
/**
 * A file whose bytes contradict its name says so.
 *
 * Acceptance 2026-09-17 DEF-09: fake_document.docx holding PDF bytes was
 * reported as kind "document" with no warning, and only failed much later inside
 * the extractor with an opaque message. The check is ADVISORY on purpose — kind
 * stays extension-derived because indexing, extraction routing and the binary
 * guards all depend on it, and flipping it on a heuristic would change behaviour
 * repo-wide. What changes is that the caller is told before it trusts the type.
 * [gate: file-type-honesty]
 * Run: node scripts/test-file-type-honesty.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { detectFormat, signatureAdvisory } = require("../src/main/mcp/file-signature.js");
const { inspectPath } = require("../src/main/mcp/file-intelligence-core.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-file-type-"));
const write = (name, body) => {
  const full = path.join(tmp, name);
  fs.writeFileSync(full, body);
  return full;
};

try {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0]);
  const ole2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

  check("signatures are read from the bytes, not the name", () => {
    assert.equal(detectFormat(write("a.bin", "%PDF-1.7\n")), "pdf");
    assert.equal(detectFormat(write("b.bin", zip)), "zip");
    assert.equal(detectFormat(write("c.bin", ole2)), "ole2");
    assert.equal(detectFormat(write("d.bin", Buffer.from([0x89, 0x50, 0x4e, 0x47]))), "png");
    assert.equal(detectFormat(write("e.bin", "plain text file")), "", "bytes that declare nothing say nothing");
    assert.equal(detectFormat(path.join(tmp, "missing.bin")), "", "an unreadable file is not an error here");
    assert.equal(detectFormat(write("empty.bin", "")), "");
  });

  check("the field case: a PDF wearing a .docx name is reported, and kind is left alone", () => {
    const fake = write("fake_document.docx", `%PDF-1.4\n${"x".repeat(240)}`);
    const advisory = signatureAdvisory(fake, ".docx");
    assert.equal(advisory.detectedFormat, "pdf");
    assert.equal(advisory.extensionMismatch, true);
    assert.match(advisory.warning, /does not match the file name/);

    const info = inspectPath({ path: fake });
    assert.equal(info.ok, true);
    assert.equal(info.kind, "document", "kind stays extension-derived — it is load-bearing downstream");
    assert.equal(info.extensionMismatch, true);
    assert.equal(info.detectedFormat, "pdf");
    assert.ok(info.indexPolicy, "the existing routing fields are untouched");
  });

  check("an honest file gets a confirmation and no warning", () => {
    const real = write("real.docx", zip);
    const advisory = signatureAdvisory(real, ".docx");
    assert.equal(advisory.detectedFormat, "zip");
    assert.equal(advisory.extensionMismatch, undefined);
    assert.equal(advisory.warning, undefined);
    assert.equal(inspectPath({ path: real }).extensionMismatch, undefined);
  });

  check("an extension with no signature commitment is never accused", () => {
    const plain = write("notes.txt", "hello");
    assert.deepEqual(signatureAdvisory(plain, ".txt"), {}, "text has no container signature to check");
    assert.deepEqual(signatureAdvisory(plain, ".bogus"), {});
    assert.equal(inspectPath({ path: plain }).extensionMismatch, undefined);
    // A legacy .doc really is OLE2; the modern .docx really is a zip. Neither
    // must be mistaken for the other.
    assert.equal(signatureAdvisory(write("legacy.doc", ole2), ".doc").extensionMismatch, undefined);
    assert.equal(signatureAdvisory(write("wrong.doc", zip), ".doc").extensionMismatch, true);
  });

  check("a probe that throws is silence, never a false accusation", () => {
    const broken = { readHeaderImpl: () => { throw new Error("unreadable"); } };
    assert.equal(detectFormat("whatever", broken), "");
    assert.deepEqual(signatureAdvisory("whatever", ".docx", broken), {});
  });

  console.log(`\n${checks} checks passed (file type honesty)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
