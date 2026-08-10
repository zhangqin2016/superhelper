#!/usr/bin/env node

import assert from "node:assert/strict";
import { attachmentPreviewKind, attachmentPreviewPath } from "../src/renderer/modules/attachment-preview-model.js";

assert.equal(attachmentPreviewKind({ name: "photo.JPG", isImage: true }), "image");
assert.equal(attachmentPreviewKind({ name: "report.pdf" }), "pdf");
assert.equal(attachmentPreviewKind({ name: "notes.md" }), "text");
assert.equal(attachmentPreviewKind({ name: "data.JSON" }), "text");
assert.equal(attachmentPreviewKind({ name: "worker.rb" }), "text");
assert.equal(attachmentPreviewKind({ name: "quarterly.xlsx" }), "office");
assert.equal(attachmentPreviewKind({ name: "archive.zip" }), "file");
assert.equal(attachmentPreviewKind({ name: "workspace", isDirectory: true }), "folder");
assert.equal(attachmentPreviewPath({ path: "/staged/report.pdf", sourcePath: "/source/report.pdf" }), "/source/report.pdf");
assert.equal(attachmentPreviewPath({ path: "/staged/report.pdf" }), "/staged/report.pdf");

console.log("attachment-preview-model: ok");
