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

// LOAD-BEARING DATA-STABILITY PIN. Electron's default userData folder is derived
// from the app's display name; renaming the product (this app has already been
// "terminal-chat-claude" → "ai-super-terminal" → "Lily Workbench") would move the
// folder and orphan ALL persisted data (sessions, licenses, model config, memory).
// So userData is pinned to a fixed <appData>/lily-workbench. If anyone changes
// that string, every existing install silently loses its data. This guard fails
// the build before that can ship.
assert.match(
  mainEntry,
  /app\.setPath\(\s*["']userData["']\s*,\s*path\.join\(\s*app\.getPath\(\s*["']appData["']\s*\)\s*,\s*["']lily-workbench["']\s*\)\s*\)/,
  "userData MUST stay pinned to <appData>/lily-workbench — changing this folder name orphans all persisted user data.",
);

const pinIndex = mainEntry.search(/app\.setPath\(\s*["']userData["']/);
const bindIndex = mainEntry.search(/bindRuntimePaths\s*\(/);
assert.ok(
  pinIndex >= 0 && bindIndex >= 0 && pinIndex < bindIndex,
  "the userData pin must run BEFORE bindRuntimePaths(), otherwise config binds the unpinned default path.",
);

console.log("main single-instance lock ok");
