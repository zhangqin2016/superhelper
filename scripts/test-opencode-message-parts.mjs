#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildOpencodePromptBody, fileToPart } = require("../src/main/runtime/opencode-message-parts.js");

{
  const body = buildOpencodePromptBody({
    agent: "build",
    guidance: "SYSTEM GUIDE",
    text: "user request",
    model: { providerID: "anthropic", modelID: "deepseek-v4-pro[1m]" },
  });
  assert.equal(body.system, "SYSTEM GUIDE", "guidance must use OpenCode's system field");
  assert.deepEqual(body.parts, [{ type: "text", text: "user request" }], "user parts contain only user content");
  assert.deepEqual(body.model, { providerID: "anthropic", modelID: "deepseek-v4-pro[1m]" }, "model ref carried");
}

{
  const body = buildOpencodePromptBody({ guidance: "  ", text: "hello" });
  assert.equal("system" in body, false, "blank guidance is omitted");
  assert.deepEqual(body.parts, [{ type: "text", text: "hello" }], "text-only prompt remains valid");
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-opencode-parts-"));
  const small = path.join(dir, "small.txt");
  fs.writeFileSync(small, "hello");
  const part = fileToPart({ path: small, name: "small.txt" }, { maxInlineFileBytes: 16 });
  assert.equal(part?.type, "file", "small files are still inlined");
  assert.equal(part.filename, "small.txt", "filename is preserved");
  assert.match(part.url, /^data:text\/plain;base64,/, "small local file becomes a data URL");

  const png = path.join(dir, "image.png");
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const pngPart = fileToPart({ path: png, name: "image.png", type: "image/png" }, { maxInlineFileBytes: 1024 });
  assert.equal(pngPart?.type, "file", "raster images remain safe model file parts");
  assert.match(pngPart.url, /^data:image\/png;base64,/, "raster images keep their image MIME");

  const binary = path.join(dir, "payload.bin");
  fs.writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
  const binarySkipped = [];
  const binaryPart = fileToPart(
    { path: binary, name: "payload.bin" },
    { maxInlineFileBytes: 1024, onSkip: (item) => binarySkipped.push(item) },
  );
  assert.equal(binaryPart, null, "unknown binary files are path-first instead of raw model uploads");
  assert.match(binarySkipped[0]?.reason || "", /not an explicitly safe inline type/, "unknown binary skip reason is explicit");

  const zip = path.join(dir, "archive.zip");
  fs.writeFileSync(zip, Buffer.from([0x50, 0x4b, 3, 4]));
  const zipPart = fileToPart({ path: zip, name: "archive.zip" }, { maxInlineFileBytes: 1024 });
  assert.equal(zipPart, null, "archives are path-first even when small");

  const unknownTemp = path.join(dir, "clipboard-unknown");
  fs.writeFileSync(unknownTemp, Buffer.from([4, 5, 6]));
  const unknownTempPart = fileToPart(
    { path: unknownTemp, name: "clipboard-unknown", mime: "application/octet-stream" },
    { maxInlineFileBytes: 1024 },
  );
  assert.equal(unknownTempPart, null, "extensionless clipboard binaries are path-first");

  const unsafeUriSkipped = [];
  const unsafeUriPart = fileToPart(
    { uri: "data:application/octet-stream;base64,AAECAw==", mime: "application/octet-stream", name: "payload.bin" },
    { onSkip: (item) => unsafeUriSkipped.push(item) },
  );
  assert.equal(unsafeUriPart, null, "unsafe URI attachments are not forwarded as raw model file parts");
  assert.equal(unsafeUriSkipped[0]?.filename, "payload.bin", "unsafe URI skip keeps the filename");

  const svg = path.join(dir, "chart.svg");
  fs.writeFileSync(svg, "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
  const svgSkipped = [];
  const svgPart = fileToPart(
    { path: svg, name: "chart.svg" },
    { maxInlineFileBytes: 1024, onSkip: (item) => svgSkipped.push(item) },
  );
  assert.equal(svgPart, null, "SVG files are not sent as model file parts");
  assert.equal(svgSkipped[0]?.reason, "svg_text_attachment", "SVG skip reason is explicit");

  const svgBody = buildOpencodePromptBody({
    text: "analyze svg",
    files: [{ path: svg, name: "chart.svg" }],
    maxInlineFileBytes: 1024,
  });
  assert.equal(svgBody.parts.length, 1, "SVG is folded into the text prompt, not sent as a file part");
  assert.match(svgBody.parts[0].text, /\[Attached SVG: chart\.svg\]/, "SVG text attachment is labeled");
  assert.match(svgBody.parts[0].text, /<svg xmlns=/, "SVG source is included for analysis");
  assert.doesNotMatch(svgBody.parts[0].text, new RegExp("data:image/svg\\\\+xml"), "SVG is not converted to a data URL");

  const docx = path.join(dir, "sample.docx");
  fs.writeFileSync(docx, "fake-docx");
  const docxSkipped = [];
  const docxPart = fileToPart(
    { path: docx, name: "sample.docx" },
    { maxInlineFileBytes: 1024, onSkip: (item) => docxSkipped.push(item) },
  );
  assert.equal(docxPart, null, "Office documents are not uploaded as raw model file parts");
  assert.match(docxSkipped[0]?.reason || "", /document extraction\/source path/, "Office skip reason points the CLI at local document handling");

  const docxBody = buildOpencodePromptBody({
    text: "read this office document",
    files: [{ path: docx, name: "sample.docx" }],
    maxInlineFileBytes: 1024,
  });
  assert.equal(docxBody.parts.length, 1, "Office fallback keeps prompt text-only");
  assert.match(docxBody.parts[0].text, /Attachment note/, "Office fallback explains why the raw file was skipped");
  assert.match(docxBody.parts[0].text, /sample\.docx/, "Office fallback preserves filename");
  assert.match(docxBody.parts[0].text, new RegExp(docx.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "Office fallback preserves source path");

  const stagedNoExt = path.join(dir, "clipboard-staged-file");
  fs.writeFileSync(stagedNoExt, "fake-docx");
  const stagedByName = fileToPart(
    { path: stagedNoExt, name: "clipboard-report.docx", type: "docx" },
    { maxInlineFileBytes: 1024 },
  );
  assert.equal(stagedByName, null, "clipboard-staged documents are detected by original filename/type even when the temp path has no extension");

  const stagedByMime = fileToPart(
    { path: stagedNoExt, name: "clipboard-file", mime: "application/pdf" },
    { maxInlineFileBytes: 1024 },
  );
  assert.equal(stagedByMime, null, "clipboard-staged documents are detected by MIME even when the temp path has no extension");

  const large = path.join(dir, "large.pdf");
  fs.writeFileSync(large, Buffer.alloc(32, 7));
  const skipped = [];
  const skippedPart = fileToPart(
    { path: large, name: "large.pdf" },
    { maxInlineFileBytes: 16, onSkip: (item) => skipped.push(item) },
  );
  assert.equal(skippedPart, null, "large local files are not inlined");
  assert.equal(skipped.length, 1, "document skip is reported");
  assert.equal(skipped[0].filename, "large.pdf", "skip report carries filename");

  const body = buildOpencodePromptBody({
    text: "read this",
    files: [{ path: large, name: "large.pdf" }],
    maxInlineFileBytes: 16,
  });
  assert.equal(body.parts.length, 1, "skipped file does not create a file part");
  assert.match(body.parts[0].text, /Attachment note/, "skipped file is explained to the model");
  assert.match(body.parts[0].text, /large\.pdf/, "skipped file name is included in the note");
  assert.match(body.parts[0].text, new RegExp(large.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "skipped file source path is included in the note");

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("opencode-message-parts: ok");
