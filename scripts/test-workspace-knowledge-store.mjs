#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  openWorkspaceKnowledgeStore,
  readIndexRegistry,
  workspaceKeyForPath,
} = require("../src/main/workspace-knowledge-store.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-workspace-knowledge-"));
const rootDir = path.join(tmp, "knowledge-root");
const wsA = path.join(tmp, "workspace-a");
const wsB = path.join(tmp, "workspace-b");
fs.mkdirSync(wsA);
fs.mkdirSync(wsB);

try {
  const keyA = workspaceKeyForPath(wsA);
  const keyB = workspaceKeyForPath(wsB);
  assert.notEqual(keyA, keyB, "workspace keys must isolate different real paths");

  const storeA = openWorkspaceKnowledgeStore({ workspacePath: wsA, rootDir });
  const storeB = openWorkspaceKnowledgeStore({ workspacePath: wsB, rootDir });
  try {
    assert(storeA.dbPath.includes(path.join("workspaces", keyA)), "store A db must live under its workspace key");
    assert(storeB.dbPath.includes(path.join("workspaces", keyB)), "store B db must live under its workspace key");

    storeA.writeIndex({
      indexId: "idx_workspace_a",
      sourcePath: path.join(wsA, "notes.md"),
      filesSeen: 1,
      filesIndexed: 1,
      filesSkipped: 0,
      skipped: [],
      chunks: [{
        chunkId: "a-1",
        sourcePath: path.join(wsA, "notes.md"),
        sourceType: "text",
        rangeType: "lines",
        rangeStart: 1,
        rangeEnd: 2,
        coverage: "indexed",
        confidence: "exact",
        excerpt: "alpha refund policy",
        text: "alpha refund policy",
        tokens: ["alpha", "refund", "policy"],
      }],
    });
    storeB.writeIndex({
      indexId: "idx_workspace_b",
      sourcePath: path.join(wsB, "notes.md"),
      filesSeen: 1,
      filesIndexed: 1,
      filesSkipped: 0,
      skipped: [],
      chunks: [{
        chunkId: "b-1",
        sourcePath: path.join(wsB, "notes.md"),
        sourceType: "text",
        rangeType: "lines",
        rangeStart: 1,
        rangeEnd: 2,
        coverage: "indexed",
        confidence: "exact",
        excerpt: "beta billing policy",
        text: "beta billing policy",
        tokens: ["beta", "billing", "policy"],
      }],
    });

    const alphaInA = storeA.queryIndex({ indexId: "idx_workspace_a", query: "alpha refund" });
    assert.equal(alphaInA.ok, true);
    assert.equal(alphaInA.matches.length, 1, "workspace A should find its own evidence");
    assert(alphaInA.matches[0].sourcePath.startsWith(wsA), "workspace A match should cite workspace A path");

    const alphaInB = storeB.queryIndex({ indexId: "idx_workspace_b", query: "alpha refund" });
    assert.equal(alphaInB.ok, true);
    assert.equal(alphaInB.matches.length, 0, "workspace B must not see workspace A evidence");

    const registry = readIndexRegistry(rootDir);
    assert.equal(registry.indexes.idx_workspace_a.workspaceKey, keyA, "registry should locate index A by workspace");
    assert.equal(registry.indexes.idx_workspace_b.workspaceKey, keyB, "registry should locate index B by workspace");
  } finally {
    storeA.close();
    storeB.close();
  }

  console.log("workspace-knowledge-store: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
