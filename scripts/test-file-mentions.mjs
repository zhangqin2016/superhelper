#!/usr/bin/env node
// Inline file-mention classifier: which code spans get a preview/reveal icon.
// Must catch real deliverables and NOT false-positive on versions/sizes/prose.
import assert from "node:assert/strict";
import { fileMentionInfo } from "../src/renderer/modules/file-mentions.js";

// previewable deliverables (open in OS default app)
for (const [text, ext] of [
  ["output/Anjaz_Bug_Status_Chart.svg", "svg"],
  ["report.docx", "docx"],
  ["a/b/c.pdf", "pdf"],
  ["dashboard.html", "html"],
  ["data.csv", "csv"],
]) {
  const info = fileMentionInfo(text);
  assert.ok(info && info.previewable && info.ext === ext, `${text} should be previewable (${ext})`);
  assert.equal(info.path, text, "path is the verbatim token");
}

// non-previewable deliverables (reveal in folder)
for (const text of ["bundle.zip", "db.sqlite", "tool.exe"]) {
  const info = fileMentionInfo(text);
  assert.ok(info && info.previewable === false, `${text} should reveal, not preview`);
}

// NOT file mentions — no icon
for (const text of ["3.6", "v1.2.3", "POST /api/tasks", "output/", "a.unknownext", "", "   ", "two words.pdf"]) {
  assert.equal(fileMentionInfo(text), null, `"${text}" must not be treated as a file mention`);
}

console.log("file-mentions: ok");
