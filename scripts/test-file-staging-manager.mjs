#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const configPath = require.resolve("../src/main/config.js");
const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-file-staging-"));

require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: {
    fileStagingDir: () => stagingDir,
  },
};

const FileStagingManager = require(path.join(root, "src/main/file-staging-manager.js"));
const manager = new FileStagingManager();

if (manager.getStagingDir() !== stagingDir) {
  throw new Error("FileStagingManager should use fileStagingDir()");
}

const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-file-source-"));
const sourcePath = path.join(sourceDir, "INC-2026-001681.pdf");
fs.writeFileSync(sourcePath, Buffer.from("%PDF-1.4\n"));

const staged = manager.stageFromPath(sourcePath);
if (path.dirname(staged.path) !== stagingDir) {
  throw new Error(`stageFromPath should copy into staging dir, got ${staged.path}`);
}
if (!fs.existsSync(staged.path)) {
  throw new Error("staged file should exist");
}
if (staged.name !== "INC-2026-001681.pdf") {
  throw new Error(`staged file should keep original name, got ${staged.name}`);
}

const duplicate = manager.stageFromPath(sourcePath);
if (duplicate.path === staged.path) {
  throw new Error("duplicate filenames should be deduplicated");
}
if (path.basename(duplicate.path) !== "INC-2026-001681-1.pdf") {
  throw new Error(`unexpected deduped filename: ${path.basename(duplicate.path)}`);
}

const pasted = manager.stageFromBuffer(Buffer.from("hello"), "notes.txt");
if (path.dirname(pasted.path) !== stagingDir) {
  throw new Error(`stageFromBuffer should write into staging dir, got ${pasted.path}`);
}
if (fs.readFileSync(pasted.path, "utf8") !== "hello") {
  throw new Error("pasted buffer content should be preserved");
}

console.log("test-file-staging-manager: ok");
