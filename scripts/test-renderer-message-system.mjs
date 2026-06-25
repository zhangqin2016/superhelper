#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDERER_DIR = path.join(ROOT, "src/renderer");
const LEGACY_SELECTORS = [
  "msg-bubble",
  "msg-bubble-file",
  "msg-bubble-files",
  "msg-bubble-image",
  "msg-content",
  "msg-user",
  "msg-assistant",
  "msg-avatar",
  "msg-turn",
  "msg-actions",
  "msg-retry-btn",
];

function walkTextFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTextFiles(full));
    } else if (entry.isFile() && /\.(css|js|html)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const hits = [];
for (const file of walkTextFiles(RENDERER_DIR)) {
  const rel = path.relative(ROOT, file);
  const text = fs.readFileSync(file, "utf8");
  text.split("\n").forEach((line, index) => {
    for (const selector of LEGACY_SELECTORS) {
      if (line.includes(selector)) {
        hits.push(`${rel}:${index + 1}: ${selector}`);
      }
    }
  });
}

assert.deepEqual(
  hits,
  [],
  `renderer must use runtime turn articles instead of legacy message bubbles:\n${hits.join("\n")}`,
);

console.log("renderer message system guard: ok");
