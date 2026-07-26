"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function readTextFile(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) return null;
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

function contentHash(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex")}`;
}

function candidateFiles(rootPath, opts = {}) {
  const maxFiles = Math.max(1, Number(opts.maxFiles || 200));
  const out = [];
  const queue = [rootPath];
  while (queue.length && out.length < maxFiles) {
    const current = queue.shift();
    let stat;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(current).sort();
      } catch {
        entries = [];
      }
      for (const name of entries) {
        if (name === "node_modules" || name === ".git" || name === "dist" || name === "release") continue;
        queue.push(path.join(current, name));
      }
    } else if (stat.isFile()) {
      out.push(current);
    }
  }
  return out;
}

module.exports = {
  candidateFiles,
  contentHash,
  readTextFile,
};
