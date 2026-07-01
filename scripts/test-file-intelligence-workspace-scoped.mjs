#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  indexPath,
  queryIndex,
  readIndex,
} = require("../src/main/mcp/file-intelligence-index.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-file-index-workspace-"));
const storeRoot = path.join(tmp, "store");
const wsA = path.join(tmp, "workspace-a");
const wsB = path.join(tmp, "workspace-b");
fs.mkdirSync(wsA);
fs.mkdirSync(wsB);
fs.writeFileSync(path.join(wsA, "same.md"), "alpha refund policy\nworkspace a only\n", "utf8");
fs.writeFileSync(path.join(wsB, "same.md"), "beta billing policy\nworkspace b only\n", "utf8");

try {
  const indexedA = indexPath({ path: wsA, storeRoot, chunkLineCount: 2 });
  const indexedB = indexPath({ path: wsB, storeRoot, chunkLineCount: 2 });
  assert.equal(indexedA.ok, true, "workspace A index should build");
  assert.equal(indexedB.ok, true, "workspace B index should build");
  assert(indexedA.workspaceKey && indexedB.workspaceKey, "indexPath should return workspace keys");
  assert.notEqual(indexedA.workspaceKey, indexedB.workspaceKey, "different workspaces must have different keys");
  assert(indexedA.workspaceDbPath.includes(path.join("knowledge", "workspaces", indexedA.workspaceKey)), "workspace A DB should be partitioned");
  assert(indexedB.workspaceDbPath.includes(path.join("knowledge", "workspaces", indexedB.workspaceKey)), "workspace B DB should be partitioned");

  const indexedSingleFile = indexPath({ path: path.join(wsA, "same.md"), storeRoot, chunkLineCount: 2 });
  assert.equal(indexedSingleFile.ok, true, "single file index should build");
  assert.equal(indexedSingleFile.workspaceKey, indexedA.workspaceKey, "single-file indexes should default to the parent workspace partition");

  const queryA = queryIndex({ indexId: indexedA.indexId, query: "alpha refund", storeRoot });
  assert.equal(queryA.ok, true, "query by index id should resolve through registry");
  assert.equal(queryA.matches.length, 1, "query A should find workspace A evidence");
  assert(queryA.matches[0].sourcePath.startsWith(wsA), "query A must cite workspace A path");

  const queryBWrong = queryIndex({ indexId: indexedB.indexId, query: "alpha refund", storeRoot });
  assert.equal(queryBWrong.ok, true, "query B should run");
  assert.equal(queryBWrong.matches.length, 0, "query B must not see workspace A content");

  const readA = readIndex({ indexId: indexedA.indexId, storeRoot });
  assert.equal(readA.ok, true, "readIndex should resolve workspace-scoped indexes by id");
  assert.equal(readA.workspaceKey, indexedA.workspaceKey);
  assert(readA.indexPath.includes(path.join("knowledge", "workspaces", indexedA.workspaceKey)), "readIndex should expose workspace DB path");

  console.log("file-intelligence-workspace-scoped: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
