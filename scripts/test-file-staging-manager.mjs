#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

const largeSourcePath = path.join(sourceDir, "large-report.pdf");
fs.writeFileSync(largeSourcePath, Buffer.from("%PDF-1.4\n"));
fs.truncateSync(largeSourcePath, 25 * 1024 * 1024);
const largeStaged = manager.stageFromPath(largeSourcePath);
if (largeStaged.name !== "large-report.pdf") {
  throw new Error("path-backed large files should be accepted for downstream indexing");
}
if (largeStaged.path !== largeSourcePath) {
  throw new Error("path-backed large files should be referenced in place instead of copied into staging");
}
if (largeStaged.size !== 25 * 1024 * 1024) {
  throw new Error(`large staged file should keep source size, got ${largeStaged.size}`);
}

const largeImagePath = path.join(sourceDir, "large-image.png");
fs.writeFileSync(largeImagePath, Buffer.from("\x89PNG\r\n\x1a\n"));
fs.truncateSync(largeImagePath, 25 * 1024 * 1024);
const largeImage = manager.stageFromPath(largeImagePath);
if (largeImage.path !== largeImagePath) {
  throw new Error("large images should also be referenced in place");
}
if (manager.getThumbnail(largeImage.path) !== null) {
  throw new Error("large image thumbnails should not read the whole file into memory");
}

// Browser blobs and clipboard exports can have no extension. Use the browser
// display name or image signature so the vision bridge does not miss them.
const extensionlessImagePath = path.join(sourceDir, "blob");
fs.writeFileSync(extensionlessImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const extensionlessImage = manager.stageFromPath(extensionlessImagePath, "clipboard-image");
if (!extensionlessImage.isImage || extensionlessImage.pathOnly || !extensionlessImage.path.endsWith(".png")) {
  throw new Error(`extensionless image should become a raster attachment: ${JSON.stringify(extensionlessImage)}`);
}

const unknownPath = path.join(sourceDir, "customer-data.custom-binary");
fs.writeFileSync(unknownPath, Buffer.from([0, 1, 2, 3]));
const unknown = manager.stageFromPath(unknownPath);
if (unknown.path !== unknownPath || unknown.sourcePath !== unknownPath) {
  throw new Error("unknown path-backed files should remain available at their live source path");
}
if (!unknown.pathOnly || unknown.staged || unknown.kind !== "binary") {
  throw new Error(`unknown files should be path-only binary attachments: ${JSON.stringify(unknown)}`);
}

const disguisedArchivePath = path.join(sourceDir, "customer.payload");
fs.writeFileSync(disguisedArchivePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
const disguisedArchive = manager.stageFromPath(disguisedArchivePath);
if (disguisedArchive.kind !== "archive" || !disguisedArchive.pathOnly) {
  throw new Error("archive signatures should route to local archive intelligence even with an unknown extension");
}

const officeContainerPath = path.join(sourceDir, "report.docx");
fs.writeFileSync(officeContainerPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
const officeContainer = manager.stageFromPath(officeContainerPath);
if (officeContainer.kind === "archive" || officeContainer.type !== "docx") {
  throw new Error("known ZIP-based Office files must retain document attachment semantics");
}

const disguisedImageArchivePath = path.join(sourceDir, "payload.png");
fs.writeFileSync(disguisedImageArchivePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
const disguisedImageArchive = manager.stageFromPath(disguisedImageArchivePath);
if (disguisedImageArchive.kind !== "archive" || !disguisedImageArchive.pathOnly || disguisedImageArchive.isImage) {
  throw new Error("archive magic must outrank a misleading image extension");
}

const folderPath = path.join(sourceDir, "customer-folder");
fs.mkdirSync(folderPath);
fs.writeFileSync(path.join(folderPath, "notes.txt"), "folder content");
const folder = manager.stageFromPath(folderPath);
if (folder.path !== folderPath || !folder.isDirectory || !folder.pathOnly) {
  throw new Error(`directories should be first-class path-only attachments: ${JSON.stringify(folder)}`);
}
if (folder.kind !== "directory" || folder.staged || folder.size !== 0) {
  throw new Error("directories should not be copied into file staging");
}

const pasted = manager.stageFromBuffer(Buffer.from("hello"), "notes.txt");
if (path.dirname(pasted.path) !== stagingDir) {
  throw new Error(`stageFromBuffer should write into staging dir, got ${pasted.path}`);
}
if (fs.readFileSync(pasted.path, "utf8") !== "hello") {
  throw new Error("pasted buffer content should be preserved");
}

const pastedBlob = manager.stageFromBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "blob");
if (!pastedBlob.isImage || !pastedBlob.path.endsWith(".jpg")) {
  throw new Error(`extensionless pasted image should retain image semantics: ${JSON.stringify(pastedBlob)}`);
}

let largeBufferRejected = false;
try {
  manager.stageFromBuffer(Buffer.alloc(20 * 1024 * 1024 + 1), "pathless-large.txt");
} catch (err) {
  largeBufferRejected = err.message === "FILE_TOO_LARGE";
}
if (!largeBufferRejected) {
  throw new Error("pathless buffer uploads should keep the 20MB memory-safety limit");
}

let unsupportedBufferRejected = false;
try {
  manager.stageFromBuffer(Buffer.from([0, 1]), "clipboard.custom-binary");
} catch (err) {
  unsupportedBufferRejected = err.message === "UNSUPPORTED_TYPE";
}
if (!unsupportedBufferRejected) {
  throw new Error("unknown pathless buffers must retain the safe extension allow-list");
}

console.log("test-file-staging-manager: ok");
