"use strict";

const path = require("node:path");

// electron-builder places extraResources outside app.asar, even when the same
// resources directory also appears in build.files. Keep source-mode fallback.
function load() {
  const relative = "resources/opencode-plugins/lib/job-observation.cjs";
  const candidates = [
    ...(typeof process.resourcesPath === "string" ? [path.join(process.resourcesPath, relative)] : []),
    path.resolve(__dirname, "../..", relative),
  ];
  for (const file of candidates) {
    try {
      const library = require(file);
      if (typeof library.jobObservation === "function" && typeof library.stableToolResult === "function") return library;
    } catch { /* Missing/corrupt optional observation must not prevent startup. */ }
  }
  return { jobObservation: () => null, stableToolResult: (_name, _input, result) => result };
}

module.exports = load();
