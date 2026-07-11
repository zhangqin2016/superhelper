#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import capabilityBroker from "../src/main/capability-broker.js";

const { recommendSkillCapabilityGraph } = capabilityBroker;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_GOLDEN = path.join(
  ROOT,
  "resources/skills-catalog/lily-intent-eval/references/golden.jsonl",
);

function parseArgs(argv) {
  const args = { golden: DEFAULT_GOLDEN, actual: null, broker: false, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--golden") args.golden = path.resolve(argv[++i]);
    else if (arg === "--actual") args.actual = path.resolve(argv[++i]);
    else if (arg === "--broker") args.broker = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help") {
      console.log("Usage: node scripts/run-intent-eval.mjs [--golden file.jsonl] [--actual route-output.jsonl | --broker] [--json]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function readJsonl(filePath) {
  const lines = fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(`${filePath}:${index + 1} invalid JSON: ${err.message}`);
    }
  });
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function validateGolden(row, index) {
  const prefix = `${row.id || `row-${index + 1}`}`;
  const issues = [];
  for (const key of [
    "id",
    "prompt",
    "expected_intents",
    "expected_route",
    "must_not_route",
    "needs_clarification",
    "verification_required",
    "risk",
  ]) {
    if (!(key in row)) issues.push(`${prefix}: missing ${key}`);
  }
  if (!Array.isArray(row.expected_intents) || row.expected_intents.length < 1) {
    issues.push(`${prefix}: expected_intents must be non-empty`);
  }
  if (!Array.isArray(row.expected_route)) issues.push(`${prefix}: expected_route must be an array`);
  if (!Array.isArray(row.must_not_route)) issues.push(`${prefix}: must_not_route must be an array`);
  if (!Array.isArray(row.verification_required)) {
    issues.push(`${prefix}: verification_required must be an array`);
  }
  if (typeof row.needs_clarification !== "boolean") {
    issues.push(`${prefix}: needs_clarification must be boolean`);
  }
  if (!["low", "medium", "high"].includes(String(row.risk || ""))) {
    issues.push(`${prefix}: risk must be low/medium/high`);
  }
  return issues;
}

function includesAll(actual, expected) {
  const actualSet = new Set(normalizeArray(actual));
  return normalizeArray(expected).filter((item) => !actualSet.has(item));
}

function intersects(actual, forbidden) {
  const actualSet = new Set(normalizeArray(actual));
  return normalizeArray(forbidden).filter((item) => actualSet.has(item));
}

function evaluateActual(goldenRows, actualRows, dimensions) {
  const evaluated = new Set(dimensions);
  const byId = new Map(actualRows.map((row) => [row.id, row]));
  const failures = [];
  for (const expected of goldenRows) {
    const actual = byId.get(expected.id);
    if (!actual) {
      failures.push({ id: expected.id, issue: "missing actual route output" });
      continue;
    }
    const missingIntents = evaluated.has("intents")
      ? includesAll(actual.intents || actual.actual_intents, expected.expected_intents)
      : [];
    const missingRoute = evaluated.has("route")
      ? includesAll(actual.route || actual.actual_route, expected.expected_route)
      : [];
    const forbiddenRoute = evaluated.has("must_not_route")
      ? intersects(actual.route || actual.actual_route, expected.must_not_route)
      : [];
    const missingVerification = evaluated.has("verification")
      ? includesAll(actual.verification || actual.verification_required, expected.verification_required)
      : [];
    if (missingIntents.length) failures.push({ id: expected.id, issue: `missing intents: ${missingIntents.join(",")}` });
    if (missingRoute.length) failures.push({ id: expected.id, issue: `missing route: ${missingRoute.join(",")}` });
    if (forbiddenRoute.length) failures.push({ id: expected.id, issue: `forbidden route: ${forbiddenRoute.join(",")}` });
    if (evaluated.has("clarification") && actual.needs_clarification !== expected.needs_clarification) {
      failures.push({
        id: expected.id,
        issue: `clarification mismatch: expected ${expected.needs_clarification}, got ${actual.needs_clarification}`,
      });
    }
    if (missingVerification.length) {
      failures.push({ id: expected.id, issue: `missing verification: ${missingVerification.join(",")}` });
    }
  }
  return failures;
}

function summarizeCoverage(rows) {
  const intents = new Set();
  const routes = new Set();
  for (const row of rows) {
    for (const item of normalizeArray(row.expected_intents)) intents.add(item);
    for (const item of normalizeArray(row.expected_route)) routes.add(item);
  }
  return { examples: rows.length, intents: intents.size, routes: routes.size };
}

function brokerActual(row) {
  return {
    id: row.id,
    route: recommendSkillCapabilityGraph({
      text: row.prompt,
      files: normalizeArray(row.attachments).map((name) => ({ name })),
    }).map((skill) => skill.id),
  };
}

const args = parseArgs(process.argv);
const goldenRows = readJsonl(args.golden);
const validationIssues = goldenRows.flatMap(validateGolden);
const duplicateIds = goldenRows
  .map((row) => row.id)
  .filter((id, index, ids) => ids.indexOf(id) !== index);
for (const id of new Set(duplicateIds)) validationIssues.push(`${id}: duplicate id`);

let actualFailures = [];
let evaluatedDimensions = [];
if (args.actual) {
  evaluatedDimensions = ["intents", "route", "must_not_route", "clarification", "verification"];
  actualFailures = evaluateActual(goldenRows, readJsonl(args.actual), evaluatedDimensions);
} else if (args.broker) {
  evaluatedDimensions = ["route", "must_not_route"];
  actualFailures = evaluateActual(goldenRows, goldenRows.map(brokerActual), evaluatedDimensions);
}

const report = {
  ok: validationIssues.length === 0 && actualFailures.length === 0,
  mode: args.actual ? "actual" : args.broker ? "broker-route" : "validate",
  evaluatedDimensions,
  coverage: summarizeCoverage(goldenRows),
  validationIssues,
  actualFailures,
};

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`intent-eval: ${report.ok ? "ok" : "failed"} (${report.coverage.examples} examples, ${report.coverage.intents} intents, ${report.coverage.routes} routes)`);
  for (const issue of validationIssues) console.log(`VALIDATION ${issue}`);
  for (const failure of actualFailures) console.log(`ROUTE ${failure.id}: ${failure.issue}`);
}

process.exit(report.ok ? 0 : 1);
