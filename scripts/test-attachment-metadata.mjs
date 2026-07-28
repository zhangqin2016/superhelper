#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { fileMetadataFromPayload, mergeDisplayFileMetadata } = require("../src/main/ipc-utils.js");

const sourceFiles = [{
  id: "file-1",
  name: "1.jpg",
  path: "/tmp/lily-workbench/staged/1.jpg",
  sourcePath: "/Users/demo/Desktop/1.jpg",
  staged: true,
  pathOnly: false,
  readable: true,
  kind: "image",
  isDirectory: false,
  extension: ".jpg",
  type: "image/jpeg",
  size: 1234,
  isImage: true,
  dimensions: { width: 100, height: 80 },
}];

const displayFilesWithOnlyName = [{
  name: "1.jpg",
  isImage: true,
  thumbnail: "data:image/jpeg;base64,preview",
}];

const metadata = fileMetadataFromPayload(sourceFiles);
assert.equal(metadata[0].path, "/tmp/lily-workbench/staged/1.jpg");
assert.equal(metadata[0].sourcePath, "/Users/demo/Desktop/1.jpg");
assert.equal(metadata[0].staged, true);
assert.equal(metadata[0].pathOnly, false);
assert.equal(metadata[0].readable, true);
assert.equal(metadata[0].kind, "image");
assert.equal(metadata[0].isDirectory, false);
assert.equal(metadata[0].extension, ".jpg");
assert.deepEqual(metadata[0].dimensions, { width: 100, height: 80 });

const merged = mergeDisplayFileMetadata(sourceFiles, displayFilesWithOnlyName);
assert.equal(merged.length, 1);
assert.equal(merged[0].name, "1.jpg");
assert.equal(merged[0].path, "/tmp/lily-workbench/staged/1.jpg");
assert.equal(merged[0].sourcePath, "/Users/demo/Desktop/1.jpg");
assert.equal(merged[0].staged, true);
assert.equal(merged[0].pathOnly, false);
assert.equal(merged[0].readable, true);
assert.equal(merged[0].kind, "image");
assert.equal(merged[0].isDirectory, false);
assert.equal(merged[0].extension, ".jpg");
assert.equal(merged[0].type, "image/jpeg");
assert.equal(merged[0].size, 1234);
assert.equal(merged[0].isImage, true);
assert.deepEqual(merged[0].dimensions, { width: 100, height: 80 });
assert.equal(merged[0].thumbnail, "data:image/jpeg;base64,preview");

const fallback = mergeDisplayFileMetadata(sourceFiles, null);
assert.equal(fallback[0].path, "/tmp/lily-workbench/staged/1.jpg");
assert.equal(fallback[0].sourcePath, "/Users/demo/Desktop/1.jpg");

console.log("attachment metadata merge ok");
