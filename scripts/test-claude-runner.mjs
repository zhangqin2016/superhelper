#!/usr/bin/env node
/**
 * Lightweight checks for stream-json text merging (no Electron / no claude CLI).
 */
import assert from "node:assert/strict";
import { appendTextSegment, sanitizeError } from "../src/main/claude-runner.js";

assert.equal(appendTextSegment("", "hello"), "hello");
assert.equal(appendTextSegment("a", "b"), "a\n\nb");
assert.equal(appendTextSegment("line\n", "next"), "line\nnext");

const friendly = sanitizeError("claude: command not found");
assert.match(friendly, /助手暂时无法连接/);

console.log("claude-runner: ok");
