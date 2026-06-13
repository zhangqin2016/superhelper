#!/usr/bin/env node
import module from "node:module";
import { assert } from "./lib/test-assert.mjs";
const require = module.createRequire(import.meta.url);
const { isFileWriteTool, extractFilePath } = require("../src/main/diff-capture.js");

try {
  assert(isFileWriteTool("Write"), "Write is a write tool");
  assert(isFileWriteTool("Edit"), "Edit is a write tool");
  assert(isFileWriteTool("MultiEdit"), "MultiEdit is a write tool");
  assert(!isFileWriteTool("Bash"), "Bash is not");
  assert(!isFileWriteTool("Read"), "Read is not");
  assert(!isFileWriteTool(""), "empty is falsy");
  assert(!isFileWriteTool(null), "null is falsy");
  assert(!isFileWriteTool(undefined), "undefined is falsy");

  assert(extractFilePath("Write", { file_path: "/a/b.js" }) === "/a/b.js", "file_path");
  assert(extractFilePath("Edit", { path: "/x/y.js" }) === "/x/y.js", "fallback path");
  assert(extractFilePath("MultiEdit", { target_file: "/z/w.js" }) === "/z/w.js", "target_file");
  assert(extractFilePath("Write", { file_path: "/a.js", path: "/x.js" }) === "/a.js", "priority");
  assert(extractFilePath("Write", {}) === null, "empty input");
  assert(extractFilePath("Write", null) === null, "null input");
  assert(extractFilePath("Write", "str") === null, "non-object");

  console.log("PASS: test-diff-capture (15 tests)");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
