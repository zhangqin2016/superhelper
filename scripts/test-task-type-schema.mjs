#!/usr/bin/env node
import assert from "node:assert/strict";
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = module.createRequire(import.meta.url);

const {
  PLATFORM_BASELINE_RULES,
  TASK_TYPE_SCHEMA_VERSION,
  TASK_TYPES,
  canonicalTaskTypeFromCategories,
  modelDraftSchema,
  taskTypeDefinition,
} = require(path.join(ROOT, "src/main/task-type-schema.js"));

assert.equal(TASK_TYPE_SCHEMA_VERSION, 5);
assert(Object.keys(TASK_TYPES).includes("runtime_protocol"));
assert(Object.keys(TASK_TYPES).includes("bug_investigation"));
assert(Object.keys(TASK_TYPES).includes("external_fact"));
assert(Object.keys(TASK_TYPES).includes("content_extraction"));
assert.equal(canonicalTaskTypeFromCategories(["bugfix", "runtime"]), "runtime_protocol");
assert.equal(canonicalTaskTypeFromCategories(["ui"]), "ui_change");
assert.equal(canonicalTaskTypeFromCategories(["release", "external_fact"]), "external_fact");
assert.equal(canonicalTaskTypeFromCategories(["media", "content_extraction"]), "content_extraction");
assert.equal(canonicalTaskTypeFromCategories(["unknown"]), "general");
assert.equal(taskTypeDefinition("missing").id, "general");
assert(PLATFORM_BASELINE_RULES.some((rule) => rule.includes("Preserve the user's original request")));

const schema = modelDraftSchema();
assert.equal(schema.schemaVersion, TASK_TYPE_SCHEMA_VERSION);
assert(schema.required.includes("taskType"));
assert(schema.required.includes("operation"));
assert(schema.required.includes("sourceKinds"));
assert(schema.required.includes("outputMode"));
assert(schema.required.includes("relation"));
assert(schema.required.includes("deliverables"));
assert(schema.required.includes("successCriteria"));
assert(schema.required.includes("verificationPlan"));
assert(schema.properties.taskType.enum.includes("release_deploy"));
assert(schema.properties.taskType.enum.includes("external_fact"));
assert(schema.properties.taskType.enum.includes("content_extraction"));
assert(schema.properties.relation.enum.includes("correct"));

console.log("task-type-schema: ok");
