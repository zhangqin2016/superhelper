"use strict";

const fs = require("node:fs");
const path = require("node:path");

function resolveSystemOfficeDir({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (platform !== "win32") return null;
  const roots = [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean);
  for (const root of new Set(roots)) {
    const dir = path.win32.join(root, "LibreOffice", "program");
    if (exists(path.win32.join(dir, "soffice.exe"))) return dir;
  }
  return null;
}

module.exports = { resolveSystemOfficeDir };
