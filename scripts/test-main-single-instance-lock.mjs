import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainEntry = await readFile(path.join(repoRoot, "src/main.js"), "utf8");

assert.match(
  mainEntry,
  /app\.requestSingleInstanceLock\(\)/,
  "main process must acquire Electron's single-instance lock before bootstrapping.",
);
assert.match(
  mainEntry,
  /app\.on\("second-instance"/,
  "second app launches must be routed to the existing window.",
);
assert.match(
  mainEntry,
  /function focusMainWindow\(\)/,
  "existing window focus/restore behavior must stay centralized.",
);
assert.match(
  mainEntry,
  /if \(!hasSingleInstanceLock\) {\s+return;\s+}/,
  "secondary processes must not continue into app bootstrap.",
);

console.log("main single-instance lock ok");
