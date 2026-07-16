#!/usr/bin/env node
// ③ slice 2 — auto-ingest: turn file-changes keep the workspace auto-index current
// (index created/edited files, replace just that source, evict deleted), with the
// slice-1 freshness guard as backstop. Reuses the real chunkers + store.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { autoIndexChangedFiles, autoIndexId } = require("../src/main/mcp/file-intelligence-index.js");
const { openWorkspaceKnowledgeStore } = require("../src/main/workspace-knowledge-store.js");

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "lily-autoidx-ws-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-autoidx-root-"));
fs.writeFileSync(path.join(ws, "alpha.txt"), "alpha lion tiger notes");
fs.writeFileSync(path.join(ws, "beta.txt"), "beta whale dolphin notes");
const indexId = autoIndexId(ws);
const q = (query) => openQuery().queryIndex({ indexId, query, verifyFreshness: true });
function openQuery() { return openWorkspaceKnowledgeStore({ workspacePath: ws, rootDir: root }); }

// index two created/modified files
let r = autoIndexChangedFiles({
  workspacePath: ws,
  storeRoot: root,
  changes: [{ filePath: "alpha.txt", status: "modified" }, { filePath: "beta.txt", status: "created" }],
});
assert.equal(r.ok, true);
assert.equal(r.indexed, 2, "both files indexed");
{
  const store = openQuery();
  assert.ok(store.queryIndex({ indexId, query: "lion", verifyFreshness: true }).matches.some((m) => m.sourcePath === "alpha.txt"), "alpha indexed + queryable");
  assert.ok(store.queryIndex({ indexId, query: "whale", verifyFreshness: true }).matches.some((m) => m.sourcePath === "beta.txt"), "beta indexed + queryable");
  store.close();
}

// edit alpha → re-ingest ONLY alpha; beta chunks must survive (no full wipe)
fs.writeFileSync(path.join(ws, "alpha.txt"), "alpha cheetah leopard notes");
autoIndexChangedFiles({ workspacePath: ws, storeRoot: root, changes: [{ filePath: "alpha.txt", status: "modified" }] });
{
  const store = openQuery();
  assert.equal(store.queryIndex({ indexId, query: "lion", verifyFreshness: true }).matches.length, 0, "old alpha content gone after edit");
  assert.ok(store.queryIndex({ indexId, query: "cheetah", verifyFreshness: true }).matches.length > 0, "new alpha content indexed");
  assert.ok(store.queryIndex({ indexId, query: "whale", verifyFreshness: true }).matches.some((m) => m.sourcePath === "beta.txt"), "beta survived alpha re-ingest");
  store.close();
}

// delete beta on disk + report deletion → evicted
fs.rmSync(path.join(ws, "beta.txt"));
r = autoIndexChangedFiles({ workspacePath: ws, storeRoot: root, changes: [{ filePath: "beta.txt", status: "deleted" }] });
assert.ok(r.evicted >= 1, "deleted file evicted");
{
  const store = openQuery();
  assert.equal(store.queryIndex({ indexId, query: "whale", verifyFreshness: true }).matches.length, 0, "deleted file no longer cited");
  store.close();
}

// out-of-workspace path is skipped (never index outside the workspace)
r = autoIndexChangedFiles({ workspacePath: ws, storeRoot: root, changes: [{ filePath: "../../etc/hosts", status: "modified" }] });
assert.equal(r.indexed, 0, "out-of-workspace change skipped");
assert.equal(r.skipped, 1);

// no workspace → error; no changes → clean no-op
assert.equal(autoIndexChangedFiles({}).ok, false, "missing workspace → error");
assert.equal(autoIndexChangedFiles({ workspacePath: ws, storeRoot: root, changes: [] }).indexed, 0, "empty changes → no-op");

fs.rmSync(ws, { recursive: true, force: true });
fs.rmSync(root, { recursive: true, force: true });
console.log("workspace-auto-index: ok");
