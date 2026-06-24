#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { readProjectMemoryIndex } = require("../src/main/project-memory.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-project-memory-"));
fs.mkdirSync(path.join(root, "memory"), { recursive: true });
const file = path.join(root, "memory", "MEMORY.md");
fs.writeFileSync(file, [
  "# Memory Index",
  "",
  "- [Context OS](context-os.md) — keep memory budgeted",
  "- [Runtime](runtime.md) — use OpenCode native compaction",
].join("\n"));

let memory = readProjectMemoryIndex(root, { maxChars: 1_000 });
assert.equal(memory.filePath, file);
assert.match(memory.text, /Context OS/);
assert.equal(memory.truncated, false);

memory = readProjectMemoryIndex(root, { maxChars: 30 });
assert.equal(memory.truncated, true);
assert(memory.text.length <= 30);

fs.writeFileSync(file, `${"# Memory Index\n\n"}${"large memory line\n".repeat(20_000)}`);
memory = readProjectMemoryIndex(root, { maxChars: 120 });
assert.equal(memory.truncated, true);
assert(memory.text.length <= 120);
assert(memory.bytesRead < memory.bytes / 10, `large project memory should not be fully read: ${JSON.stringify(memory)}`);

assert.equal(readProjectMemoryIndex(path.join(root, "missing")), null);

fs.rmSync(root, { recursive: true, force: true });
console.log("project-memory: ok");
