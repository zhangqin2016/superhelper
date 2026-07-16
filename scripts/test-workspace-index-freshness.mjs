#!/usr/bin/env node
// Guards the ③ safety core: the workspace knowledge index must never cite a chunk
// whose local source file was DELETED. queryIndex verifies each hit against the
// live filesystem, drops the stale ones, and evicts them from the store.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { partitionMatchesByFreshness } = require("../src/main/workspace-index-freshness.js");
const { openWorkspaceKnowledgeStore } = require("../src/main/workspace-knowledge-store.js");

// --- pure helper ---------------------------------------------------------
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "lily-freshness-ws-"));
fs.writeFileSync(path.join(ws, "exists.txt"), "alpha lives here");
const part = partitionMatchesByFreshness(
  [
    { sourcePath: "exists.txt", sourceType: "file" },
    { sourcePath: "deleted.txt", sourceType: "file" },
    { sourcePath: "https://example.com/x", sourceType: "url" },
    { sourcePath: path.join(ws, "exists.txt"), sourceType: "file" }, // absolute, present
  ],
  { workspacePath: ws },
);
assert.deepEqual(part.stalePaths, ["deleted.txt"], "only the definitively-missing local file is stale");
assert.equal(part.fresh.length, 3, "present file + url + absolute-present are kept (url kept fail-open)");

// --- store integration ---------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-freshness-root-"));
const store = openWorkspaceKnowledgeStore({ workspacePath: ws, rootDir: root });
store.writeIndex({
  indexId: "idx1",
  sourcePath: ws,
  chunks: [
    { chunkId: "c1", sourcePath: "exists.txt", sourceType: "file", text: "alpha content present", excerpt: "alpha present" },
    { chunkId: "c2", sourcePath: "deleted.txt", sourceType: "file", text: "alpha content gone", excerpt: "alpha gone" },
    { chunkId: "c3", sourcePath: "https://example.com/y", sourceType: "url", text: "alpha remote doc", excerpt: "alpha remote" },
  ],
});

const res = store.queryIndex({ indexId: "idx1", query: "alpha", verifyFreshness: true });
assert.equal(res.ok, true);
const paths = res.matches.map((m) => m.sourcePath);
assert.ok(paths.includes("exists.txt"), "present file cited");
assert.ok(paths.includes("https://example.com/y"), "url source kept (cannot be proven stale)");
assert.ok(!paths.includes("deleted.txt"), "DELETED file must NOT be cited");
assert.ok(res.evictedStale >= 1, "stale chunk evicted from the store");

// stale chunk is gone permanently — a later query never resurrects it
const res2 = store.queryIndex({ indexId: "idx1", query: "alpha", verifyFreshness: true });
assert.ok(!res2.matches.map((m) => m.sourcePath).includes("deleted.txt"), "evicted chunk stays gone");

// kill switch → verification off → deleted chunk would be returned (baseline)
store.writeIndex({
  indexId: "idx2",
  sourcePath: ws,
  chunks: [{ chunkId: "d1", sourcePath: "deleted.txt", sourceType: "file", text: "alpha still indexed", excerpt: "x" }],
});
process.env.LILY_WORKSPACE_INDEX_VERIFY = "0";
const off = store.queryIndex({ indexId: "idx2", query: "alpha", verifyFreshness: true });
assert.ok(off.matches.map((m) => m.sourcePath).includes("deleted.txt"), "kill switch restores unverified behavior");
delete process.env.LILY_WORKSPACE_INDEX_VERIFY;

store.close();
fs.rmSync(ws, { recursive: true, force: true });
fs.rmSync(root, { recursive: true, force: true });
console.log("workspace-index-freshness: ok");
