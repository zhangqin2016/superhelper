#!/usr/bin/env node
/**
 * path-guard: renderer-supplied paths must stay inside the project root.
 * WHY: filetree IPC writes/deletes files — a traversal or symlink escape here
 * is arbitrary write/delete with the user's OS permissions (P0, see
 * docs/project-analysis-2026-06-12.md).
 */
import module from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);
const { resolveContainedPath } = require("../src/main/path-guard.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pg-root-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pg-outside-"));
fs.mkdirSync(path.join(root, "sub"));
fs.writeFileSync(path.join(root, "sub", "a.txt"), "in");
fs.writeFileSync(path.join(outside, "secret.txt"), "out");

// contained file resolves
const ok = resolveContainedPath(root, path.join(root, "sub", "a.txt"));
assert(ok && ok.endsWith(path.join("sub", "a.txt")), "contained file resolves");

// contained but not-yet-existing file resolves (delete/restore flows)
assert(resolveContainedPath(root, path.join(root, "sub", "new.txt")), "missing file with existing parent resolves");

// absolute path outside the root is rejected
assert(resolveContainedPath(root, path.join(outside, "secret.txt")) === null, "absolute outside path rejected");

// `..` traversal is rejected
assert(resolveContainedPath(root, path.join(root, "sub", "..", "..", "etc", "passwd")) === null, "dot-dot traversal rejected");

// symlinked directory escaping the root is rejected
fs.symlinkSync(outside, path.join(root, "link"));
assert(resolveContainedPath(root, path.join(root, "link", "secret.txt")) === null, "symlink dir escape rejected");

// the root itself is not a valid file target
assert(resolveContainedPath(root, root) === null, "root itself rejected");

// degenerate inputs
assert(resolveContainedPath(null, "/x") === null, "null root rejected");
assert(resolveContainedPath(root, "") === null, "empty path rejected");
assert(resolveContainedPath(path.join(root, "missing-root"), "a") === null, "nonexistent root rejected");

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });
console.log("PASS: test-path-guard (9 tests)");
