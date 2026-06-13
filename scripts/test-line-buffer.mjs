#!/usr/bin/env node
//
// LineBuffer splits stdout chunks into complete lines, keeping a partial line
// across reads. The bug it prevents: a JSON line split across two socket reads
// being parsed twice (or as two broken halves). Pure, plain-node test.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { LineBuffer } = require(path.join(ROOT, "src/main/line-buffer.js"));

function eq(a, b, msg) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)}`);
}

// Whole lines in one chunk.
let lb = new LineBuffer();
eq(lb.push("a\nb\n"), ["a", "b"], "two complete lines");
eq(lb.push("c\n"), ["c"], "next complete line");

// Trailing partial is retained until completed by the next push.
lb = new LineBuffer();
eq(lb.push("a\nb"), ["a"], "complete line emitted, partial held");
eq(lb.push("c\n"), ["bc"], "partial completed by next chunk");

// A single line split across THREE reads must surface exactly once, intact.
lb = new LineBuffer();
eq(lb.push("hel"), [], "no complete line yet");
eq(lb.push("lo wor"), [], "still no newline");
eq(lb.push("ld\n"), ["hello world"], "reassembled across 3 chunks");

// Buffer (Buffer/■ non-string) input is coerced via toString.
lb = new LineBuffer();
eq(lb.push(Buffer.from("x\ny")), ["x"], "Buffer chunk handled");

// flush returns the trailing line (trimmed) once, then nothing.
eq(lb.flush(), "y", "flush returns trailing partial");
assert(lb.flush() === null, "flush after flush is null");

// flush ignores whitespace-only trailing content.
lb = new LineBuffer();
lb.push("   ");
assert(lb.flush() === null, "whitespace-only flush → null");

// reset discards a held partial so it can't leak into the next stream.
lb = new LineBuffer();
lb.push("partial-no-newline");
lb.reset();
eq(lb.push("fresh\n"), ["fresh"], "reset dropped the stale partial");

// null/empty chunks are harmless.
lb = new LineBuffer();
eq(lb.push(null), [], "null chunk → no lines");
eq(lb.push(""), [], "empty chunk → no lines");

console.log("line-buffer: ok");
