"use strict";

// File-extension classification shared by the diff pipeline and the file tree.
// Lives below both so neither layer has to reach into the other for it.

const path = require("node:path");

const TEXT_EXTS = new Set([
  ".md", ".txt", ".json", ".js", ".ts", ".py", ".html", ".htm", ".css",
  ".csv", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".env",
  ".sh", ".bat", ".ps1", ".rb", ".java", ".go", ".rs", ".c", ".cpp",
  ".h", ".hpp", ".swift", ".kt",
]);

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTS.has(ext);
}

module.exports = { TEXT_EXTS, isTextFile };
