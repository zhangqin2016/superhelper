#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, finish } from "./lib/test-assert.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function readSkill(id) {
  return fs.readFileSync(path.join(ROOT, "resources", "skills-catalog", id, "SKILL.md"), "utf8");
}

function assertLongTaskContract(id) {
  const text = readSkill(id);
  const body = text.replace(/^---[\s\S]*?---\s*/, "");
  assert(text.includes("lily_process_jobs"), `${id} must use the generic process job supervisor for long work`);
  assert(text.includes("[lily-progress]"), `${id} must use the generic work progress marker`);
  assert(text.includes("job_status") && text.includes("job_logs"), `${id} must observe progress through generic job status/logs`);
  assert(!/matrx|web-system-learning|stock/i.test(body), `${id} long-task guidance must stay domain-neutral`);
}

assertLongTaskContract("lily-web-system-learning");
assertLongTaskContract("lily-runtime-packs");
assertLongTaskContract("lily-office-intent");
assertLongTaskContract("lily-pdf-extraction-router");
assertLongTaskContract("lily-excel-data-analysis");
assertLongTaskContract("lily-document-verify");
assertLongTaskContract("lily-template-fill");

const runtimePackScript = fs.readFileSync(
  path.join(ROOT, "resources", "skills-catalog", "lily-runtime-packs", "scripts", "manage_runtime_pack.py"),
  "utf8",
);
assert(runtimePackScript.includes("[lily-progress]"), "runtime pack installer script must emit platform progress markers");
assert(runtimePackScript.includes('"domain": "runtime-pack"'), "runtime pack progress must use a generic domain");

finish("test-long-task-supervisor-migration", 30);
