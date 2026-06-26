#!/usr/bin/env node
/**
 * Lily side of cross-session memory injection (#1): curate a bounded set of
 * navigation blocks from a session summary and write the handoff file the
 * OpenCode compaction plugin reads. WHY it matters: after a native compaction,
 * the model must still know the durable facts (pending task, prior conclusions,
 * birth data, files) — these blocks are what survives. The budget cap exists so
 * the injection never re-bloats the very context compaction is freeing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildCompactionMemoryBlocks,
  writeCompactionMemoryFile,
  compactionMemoryFilePath,
} = require("../src/main/compaction-memory-export.js");

const summary = {
  pendingTask: "把 #1 拆成可执行设计",
  lastUserIntent: "赶超 claude cli",
  lastAssistantResult: "命主生辰=甲子年，已定结论保留",
  recentEvidenceGaps: [{ reason: "summarize 真因未活体验证" }],
  recentFiles: ["a.js", "b.js"],
};

// Curation + ordering: pending task is the most durable, comes first.
const blocks = buildCompactionMemoryBlocks(summary);
assert.ok(blocks.length >= 4, "all durable fields produce blocks");
assert.match(blocks[0], /未完成\/待办/, "pending task ordered first (highest priority)");
assert.ok(blocks.some((b) => /甲子年/.test(b)), "durable fact (birth data) is preserved verbatim");
assert.ok(blocks.some((b) => /待补证据/.test(b)), "evidence gap carried as a lead");

// Empty / junk summary -> no blocks (plugin then leaves compaction untouched).
assert.deepEqual(buildCompactionMemoryBlocks(null), [], "null summary -> []");
assert.deepEqual(buildCompactionMemoryBlocks({}), [], "empty summary -> []");

// Budget: a tight ceiling keeps only the highest-priority prefix, never overflows.
// 25 fits the ~19-char pending-task block but not a second one.
const tight = buildCompactionMemoryBlocks(summary, { maxChars: 25 });
assert.ok(tight.length >= 1 && tight.length < blocks.length, "tight budget drops lower-priority blocks");
assert.ok(tight.join("").length <= 25, "never exceeds the char budget");
assert.match(tight[0], /未完成\/待办/, "the kept block is the highest priority one");

// Writer round-trips the contract file; fail-safe on nothing-to-write / bad dir.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-compact-export-"));
const file = writeCompactionMemoryFile(dir, "ses_abc123", summary);
assert.equal(file, compactionMemoryFilePath(dir, "ses_abc123"), "writes to the keyed path");
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
assert.equal(parsed.schemaVersion, 1, "file carries schemaVersion");
assert.ok(Array.isArray(parsed.blocks) && parsed.blocks.length >= 4, "file carries the blocks");

assert.equal(writeCompactionMemoryFile(dir, "ses_x", {}), "", "empty summary -> no file written");
assert.equal(writeCompactionMemoryFile(dir, "../escape", summary), "", "unsafe session id rejected");
assert.equal(writeCompactionMemoryFile("", "ses_x", summary), "", "missing dir -> fail-safe empty");

fs.rmSync(dir, { recursive: true, force: true });
console.log("compaction-memory-export: ok");
