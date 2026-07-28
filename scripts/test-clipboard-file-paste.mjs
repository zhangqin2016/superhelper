#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  attachmentPickerProperties,
  extractClipboardFilePaths,
  stageClipboardFiles,
} = require("../src/main/ipc-files.js");

assert.deepEqual(attachmentPickerProperties("file"), ["openFile", "multiSelections"]);
assert.deepEqual(attachmentPickerProperties("directory"), ["openDirectory", "multiSelections"]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-clipboard-files-"));
const pdf = path.join(dir, "合同 文件.pdf");
const docx = path.join(dir, "report.docx");
const exe = path.join(dir, "tool.exe");
const folder = path.join(dir, "project folder");
fs.writeFileSync(pdf, "pdf");
fs.writeFileSync(docx, "docx");
fs.writeFileSync(exe, "exe");
fs.mkdirSync(folder);

try {
  const clip = {
    readBookmark: () => ({ title: "contract", url: pathToFileURL(pdf).href }),
    readText: () => folder,
    availableFormats: () => ["public.file-url", "FileNameW", "NSFilenamesPboardType", "text/plain"],
    readBuffer: (format) => {
      if (format === "public.file-url") return Buffer.from(`${pathToFileURL(docx).href}\n`);
      if (format === "FileNameW") return Buffer.from(`${exe}\u0000`, "utf16le");
      if (format === "NSFilenamesPboardType") {
        return Buffer.from(`<?xml version="1.0"?><plist><array><string>${pdf}</string></array></plist>`);
      }
      return Buffer.from("not a file");
    },
  };

  const paths = extractClipboardFilePaths(clip);
  assert.deepEqual(new Set(paths), new Set([pdf, docx, exe, folder]), "clipboard file and directory paths are parsed across platform formats");

  const staged = [];
  const result = stageClipboardFiles({
    stageFromPath(filePath) {
      if (filePath === exe) throw new Error("READ_FAILED");
      const meta = {
        path: filePath,
        name: path.basename(filePath),
        isImage: false,
        isDirectory: filePath === folder,
      };
      staged.push(meta);
      return meta;
    },
  }, clip);

  assert.equal(result.ok, true);
  assert.deepEqual(staged.map((f) => f.path), [pdf, folder, docx], "valid clipboard files and directories are staged");
  assert.equal(result.errors.length, 1, "staging errors are surfaced");
  assert.equal(result.errors[0].error, "READ_FAILED");

  console.log("clipboard file paste: ok");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
