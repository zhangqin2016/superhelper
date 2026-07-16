#!/usr/bin/env node
// ③ slice 3 — background reconcile: catch EXTERNAL file changes (not in any
// turn's fileChanges). Indexes new/changed, SKIPS unchanged via mtime+size
// stamps, evicts externally-deleted, excludes node_modules. Async + throttled.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { reconcileWorkspaceIndex, autoIndexId } = require("../src/main/mcp/file-intelligence-index.js");
const { openWorkspaceKnowledgeStore } = require("../src/main/workspace-knowledge-store.js");

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "lily-recon-ws-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-recon-root-"));
fs.writeFileSync(path.join(ws, "a.txt"), "alpha lion notes");
fs.writeFileSync(path.join(ws, "b.txt"), "beta whale notes");
fs.mkdirSync(path.join(ws, "node_modules"));
fs.writeFileSync(path.join(ws, "node_modules", "junk.txt"), "alpha vendor noise");
const indexId = autoIndexId(ws);
const store = () => openWorkspaceKnowledgeStore({ workspacePath: ws, rootDir: root });

// first scan: indexes a + b, excludes node_modules
let r = await reconcileWorkspaceIndex({ workspacePath: ws, storeRoot: root, batchSize: 1 });
assert.equal(r.ok, true);
assert.equal(r.indexed, 2, "a.txt + b.txt indexed; node_modules excluded");
{
  const s = store();
  assert.ok(s.queryIndex({ indexId, query: "lion", verifyFreshness: true }).matches.some((m) => m.sourcePath === "a.txt"));
  assert.equal(s.queryIndex({ indexId, query: "vendor", verifyFreshness: true }).matches.length, 0, "node_modules content NOT indexed");
  s.close();
}

// second scan, nothing changed → all skipped (stamps do their job)
r = await reconcileWorkspaceIndex({ workspacePath: ws, storeRoot: root });
assert.equal(r.indexed, 0, "unchanged files re-index nothing");
assert.equal(r.skipped, 2, "both skipped via mtime+size stamp");

// external EDIT of a.txt (different size) → only a re-indexed
fs.writeFileSync(path.join(ws, "a.txt"), "alpha cheetah leopard different length notes");
r = await reconcileWorkspaceIndex({ workspacePath: ws, storeRoot: root });
assert.equal(r.indexed, 1, "only the edited file re-indexed");
{
  const s = store();
  assert.equal(s.queryIndex({ indexId, query: "lion", verifyFreshness: true }).matches.length, 0, "old content gone");
  assert.ok(s.queryIndex({ indexId, query: "cheetah", verifyFreshness: true }).matches.length > 0, "new external content indexed");
  s.close();
}

// external ADD c.txt → indexed next scan
fs.writeFileSync(path.join(ws, "c.txt"), "gamma penguin notes");
r = await reconcileWorkspaceIndex({ workspacePath: ws, storeRoot: root });
assert.equal(r.indexed, 1, "newly added file indexed");

// external DELETE b.txt → evicted next scan
fs.rmSync(path.join(ws, "b.txt"));
r = await reconcileWorkspaceIndex({ workspacePath: ws, storeRoot: root });
assert.ok(r.evicted >= 1, "externally deleted file evicted");
{
  const s = store();
  assert.equal(s.queryIndex({ indexId, query: "whale", verifyFreshness: true }).matches.length, 0, "deleted file no longer cited");
  assert.deepEqual([...s.getSourceStamps(indexId).keys()].sort(), ["a.txt", "c.txt"], "stamps reflect live files only");
  s.close();
}

// no workspace → error (fail-safe)
assert.equal((await reconcileWorkspaceIndex({})).ok, false);

fs.rmSync(ws, { recursive: true, force: true });
fs.rmSync(root, { recursive: true, force: true });
console.log("workspace-reconcile: ok");
