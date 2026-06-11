#!/usr/bin/env node
/**
 * Replay Claude CLI JSONL fixtures through the protocol normalizer.
 * Fixtures are the compatibility contract for Claude runtime event shapes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeClaudeEvent } from "../src/main/runtime/adapters/claude-event-normalizer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const fixtureDir = path.join(repoRoot, "fixtures", "claude-runtime");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonl(file) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`${path.basename(file)}:${index + 1} invalid JSON: ${err.message}`);
      }
    });
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function hasKind(actions, kind) {
  return actions.some((action) => action.kind === kind);
}

function warningActions(actions) {
  return actions.filter((action) =>
    ["protocol_warning", "unknown_runtime_event", "unknown_control_request"].includes(action.kind),
  );
}

const jsonlFiles = fs
  .readdirSync(fixtureDir)
  .filter((file) => file.endsWith(".jsonl"))
  .sort();

if (!jsonlFiles.length) {
  throw new Error(`No Claude runtime fixtures found in ${fixtureDir}`);
}

const summary = [];

for (const file of jsonlFiles) {
  const base = file.replace(/\.jsonl$/, "");
  const jsonlPath = path.join(fixtureDir, file);
  const expectedPath = path.join(fixtureDir, `${base}.expected.json`);
  if (!fs.existsSync(expectedPath)) {
    throw new Error(`${file} is missing ${base}.expected.json`);
  }

  const events = readJsonl(jsonlPath);
  const expected = readJson(expectedPath);
  const actions = events.flatMap((event) => normalizeClaudeEvent(event));
  const kindCounts = countBy(actions, (action) => action.kind);
  const warnings = warningActions(actions);

  for (const kind of expected.mustIncludeKinds || []) {
    if (!hasKind(actions, kind)) {
      throw new Error(`${file} expected kind ${kind}, got ${[...kindCounts.keys()].join(", ")}`);
    }
  }

  for (const kind of expected.mustNotIncludeKinds || []) {
    if (hasKind(actions, kind)) {
      throw new Error(`${file} must not include kind ${kind}`);
    }
  }

  if (expected.warningCount != null && warnings.length !== expected.warningCount) {
    throw new Error(`${file} expected ${expected.warningCount} warning(s), got ${warnings.length}`);
  }

  if (expected.counts) {
    for (const [kind, count] of Object.entries(expected.counts)) {
      if ((kindCounts.get(kind) || 0) !== count) {
        throw new Error(`${file} expected ${count} ${kind}, got ${kindCounts.get(kind) || 0}`);
      }
    }
  }

  if (expected.firstQuestion) {
    const question = actions.find((action) => action.kind === "ask_user_question");
    if (question?.questions?.[0]?.question !== expected.firstQuestion) {
      throw new Error(`${file} expected first question ${expected.firstQuestion}, got ${JSON.stringify(question)}`);
    }
  }

  if (expected.resultSubtype) {
    const result = actions.find((action) => action.kind === "turn_result");
    if (result?.event?.subtype !== expected.resultSubtype) {
      throw new Error(`${file} expected result subtype ${expected.resultSubtype}, got ${result?.event?.subtype}`);
    }
  }

  summary.push({
    fixture: file,
    events: events.length,
    actions: actions.length,
    warnings: warnings.length,
    kinds: Object.fromEntries([...kindCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
  });
}

console.log(`claude-runtime-fixtures: ok (${summary.length} fixtures)`);
for (const row of summary) {
  console.log(`${row.fixture}: events=${row.events} actions=${row.actions} warnings=${row.warnings}`);
}
