#!/usr/bin/env node
// Pillar 3-A: the verify-edit plugin must catch broken deliverables (valid header
// but truncated/invalid body) so the model fixes them mid-turn, while never
// false-positiving on valid files (fail open).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginUrl = new URL("../resources/opencode-plugins/verify-edit.js", import.meta.url);
const { VerifyEditPlugin } = await import(pluginUrl);
const hook = (await VerifyEditPlugin())["tool.execute.after"];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-edit-test-"));
async function verify(file) {
  const out = { output: "" };
  await hook({ tool: "write", args: { filePath: file } }, out);
  return out.output;
}
function write(name, bytes) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

try {
  // OOXML: PK header but no [Content_Types].xml entry -> truncated/invalid package.
  const badDocx = write("bad.docx", Buffer.from("PK\x03\x04 not a real ooxml package", "binary"));
  assert.match(await verify(badDocx), /\[Content_Types\]\.xml/, "broken .docx must be flagged");

  // Valid-enough: PK header AND the content-types entry name present.
  const goodDocx = write("good.docx", Buffer.from("PK\x03\x04....[Content_Types].xml....body", "binary"));
  assert.equal((await verify(goodDocx)).trim(), "", "valid .docx must not be flagged");

  // PDF without %%EOF trailer -> truncated.
  const badPdf = write("bad.pdf", "%PDF-1.4 written but never finished");
  assert.match(await verify(badPdf), /%%EOF/, "truncated .pdf must be flagged");

  const goodPdf = write("good.pdf", "%PDF-1.4\n... objects ...\n%%EOF\n");
  assert.equal((await verify(goodPdf)).trim(), "", "complete .pdf must not be flagged");

  // Empty deliverable.
  const emptyDocx = write("empty.docx", Buffer.alloc(0));
  assert.match(await verify(emptyDocx), /empty/i, "empty deliverable must be flagged");

  // Lint (step 2): a project's OWN eslint reporting an error is surfaced same-turn.
  // Use a fake project-local eslint (exit 1 + message) so the wiring is tested
  // deterministically without a real eslint install.
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "verify-lint-"));
  const binDir = path.join(proj, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  const fakeEslint = path.join(binDir, "eslint");
  fs.writeFileSync(fakeEslint, "#!/bin/sh\necho \"$1: line 1, Error - 'x' is not defined (no-undef)\"\nexit 1\n");
  fs.chmodSync(fakeEslint, 0o755);
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  const codeFile = path.join(proj, "src", "code.js");
  fs.writeFileSync(codeFile, "const y = 1;\n");
  {
    const out = { output: "" };
    await hook({ tool: "write", args: { filePath: codeFile } }, out);
    assert.match(out.output, /Lint errors/, "project-local eslint errors surfaced same-turn");
  }
  fs.rmSync(proj, { recursive: true, force: true });

  // Fail open: a valid JS file with NO project linter must never be flagged.
  const plainJs = write("plain.js", "const z = 2;\n");
  assert.equal((await verify(plainJs)).trim(), "", "valid JS with no project linter is not flagged");

  console.log("verify-edit-plugin: ok");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
