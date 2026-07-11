"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function entryRevision(entry) {
  const { contentRevision, fetchedAt, ...content } = entry || {};
  return sha256(content);
}

function skillDirectoryFiles(skillDir) {
  const files = [];
  const visit = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if ([".DS_Store", "__pycache__", "node_modules", ".git"].includes(item.name)) continue;
      const absolute = path.join(dir, item.name);
      if (item.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!item.isFile()) continue;
      const buffer = fs.readFileSync(absolute);
      files.push({
        path: path.relative(skillDir, absolute).split(path.sep).join("/"),
        sizeBytes: buffer.length,
        sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      });
    }
  };
  visit(skillDir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function skillContentRevision(entry, { skillMarkdown = "", manifest = null, files = [] } = {}) {
  const { contentRevision, fetchedAt, ...content } = entry || {};
  return sha256({
    entry: content,
    skillMarkdown: String(skillMarkdown).replace(/\r\n/g, "\n"),
    manifest,
    files,
  });
}

function registryRevision(registry) {
  return sha256({
    schemaVersion: registry?.schemaVersion || 1,
    publisher: registry?.publisher || "",
    categories: registry?.categories || [],
    capabilities: registry?.capabilities || {},
    remoteIndexes: registry?.remoteIndexes || [],
    skills: registry?.skills || [],
  });
}

module.exports = {
  stable,
  entryRevision,
  skillDirectoryFiles,
  skillContentRevision,
  registryRevision,
};
