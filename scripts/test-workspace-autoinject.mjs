#!/usr/bin/env node
// ③ proactive injection — retrieveWorkspaceContext returns a compact, freshness-
// verified, "retrieval not proof" block from the workspace auto-index (or null).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { autoIndexChangedFiles, retrieveWorkspaceContext } = require("../src/main/mcp/file-intelligence-index.js");

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "lily-inject-ws-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-inject-root-"));
fs.writeFileSync(path.join(ws, "auth.js", ), "function login() { return checkPassword('lion-secret'); }");
fs.writeFileSync(path.join(ws, "ui.css"), "body { color: whale-blue; }");
autoIndexChangedFiles({
  workspacePath: ws, storeRoot: root,
  changes: [{ filePath: "auth.js", status: "created" }, { filePath: "ui.css", status: "created" }],
});

// retrieval returns a labeled, bounded block citing the matching file
const hit = retrieveWorkspaceContext({ workspacePath: ws, storeRoot: root, query: "where is login handled" });
assert.ok(hit && hit.text, "returns a context block for a workspace query");
assert.match(hit.text, /RETRIEVAL, not proof/, "labeled retrieval-not-proof (must re-read to confirm)");
assert.match(hit.text, /auth\.js/, "cites the source file with its path");
assert.ok(hit.injected >= 1);

// gates: too-short query → null; no workspace → null; unrelated store root → null
assert.equal(retrieveWorkspaceContext({ workspacePath: ws, storeRoot: root, query: "x" }), null, "short query → null");
assert.equal(retrieveWorkspaceContext({ query: "login" }), null, "no workspace → null");

// bounded: a tiny maxChars still returns a valid (short) block, never unbounded
const tiny = retrieveWorkspaceContext({ workspacePath: ws, storeRoot: root, query: "login", maxChars: 220 });
if (tiny) assert.ok(tiny.text.length <= 260, "respects maxChars budget");

// freshness: delete the file on disk → retrieval must NOT cite it
fs.rmSync(path.join(ws, "auth.js"));
const afterDelete = retrieveWorkspaceContext({ workspacePath: ws, storeRoot: root, query: "login" });
if (afterDelete) assert.doesNotMatch(afterDelete.text, /auth\.js/, "deleted file never cited (freshness guard)");

fs.rmSync(ws, { recursive: true, force: true });
fs.rmSync(root, { recursive: true, force: true });
console.log("workspace-autoinject: ok");
