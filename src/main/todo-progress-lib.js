"use strict";
/**
 * Loads the todo-progress inference library that is SHARED with the OpenCode
 * plugin (resources/opencode-plugins/lib/todo-progress.cjs). One implementation
 * serves both the engine-side nudge and the main-process progress overlay, so
 * the reminder the model receives and the state the user sees can never
 * disagree. Fail-open: a missing file yields a no-op library.
 */
const fs = require("node:fs");
const path = require("node:path");

let cached;

function candidates() {
  const rel = path.join("resources", "opencode-plugins", "lib", "todo-progress.cjs");
  const out = [];
  if (typeof process.resourcesPath === "string") out.push(path.join(process.resourcesPath, rel));
  try {
    const { PROJECT_ROOT } = require("./config");
    if (PROJECT_ROOT) out.push(path.join(PROJECT_ROOT, rel));
  } catch {
    /* config unavailable in some test harnesses */
  }
  out.push(path.resolve(__dirname, "..", "..", rel));
  return out;
}

const NOOP = {
  MAX_TOOLS: 24,
  buildNudgeNote: () => "",
  compactTool: (tool = {}) => ({ id: String(tool.id || ""), name: String(tool.name || ""), inputText: "", outputText: "", ok: false, running: false }),
  computeStepTokenSets: (titles = []) => titles.map(() => ({ unique: [], shared: [] })),
  extractStepTokens: () => [],
  inferPlanProgress: (steps = []) => steps.map((_, index) => ({ index, inferred: null, toolId: "", toolName: "", snippet: "" })),
  localeKind: () => "en",
  resultText: () => "",
};

function loadTodoProgressLib() {
  if (cached) return cached;
  for (const file of candidates()) {
    try {
      if (fs.existsSync(file)) {
        cached = require(file);
        return cached;
      }
    } catch {
      /* try the next candidate */
    }
  }
  cached = NOOP;
  return cached;
}

module.exports = { loadTodoProgressLib };
