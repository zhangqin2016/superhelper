#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";

const require = module.createRequire(import.meta.url);
const {
  assessWorkspaceWrite,
  extractWriteTarget,
  normalizeTargetPath,
} = require("../src/main/workspace-grounding-gate.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-grounding-"));
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.mkdirSync(path.join(root, ".lily-work"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "app.js"), "", "utf8");

const policy = {
  required: true,
  allowNewTopLevel: false,
};

assert.equal(normalizeTargetPath(root, path.join(root, "src", "app.js")), path.join(root, "src", "app.js"));
assert.equal(normalizeTargetPath(root, path.join(root, "..", "outside.js")), "");
assert.equal(extractWriteTarget("edit", { filePath: "src/app.js" }), "src/app.js");
assert.equal(extractWriteTarget("bash", { command: "mkdir -p apps/new-stock" }), "apps/new-stock");
assert.equal(extractWriteTarget("bash", { command: "cat > src/new.js <<'EOF'" }), "src/new.js");

assert.deepEqual(
  assessWorkspaceWrite({
    projectPath: root,
    toolName: "edit",
    input: { filePath: "src/app.js" },
    groundingPolicy: policy,
  }).verdict,
  "allow",
  "existing workspace target should be allowed",
);

assert.equal(
  assessWorkspaceWrite({
    projectPath: root,
    toolName: "write",
    input: { path: "new-app/index.js" },
    groundingPolicy: policy,
  }).reason,
  "new_top_level_without_grounding",
  "new top-level project should ask",
);

assert.equal(
  assessWorkspaceWrite({
    projectPath: root,
    toolName: "write",
    input: { path: "src/features/new.js" },
    groundingPolicy: policy,
  }).reason,
  "new_nested_parent_without_grounding",
  "new nested parent should ask",
);

assert.equal(
  assessWorkspaceWrite({
    projectPath: root,
    toolName: "write",
    input: { path: ".lily-work/report.json" },
    groundingPolicy: policy,
  }).verdict,
  "allow",
  "scratch workspace should be allowed",
);

assert.equal(
  assessWorkspaceWrite({
    projectPath: root,
    toolName: "write",
    input: { path: "greenfield/index.js" },
    groundingPolicy: { required: true, allowNewTopLevel: true },
  }).verdict,
  "allow",
  "explicit greenfield should allow new top-level",
);

fs.rmSync(root, { recursive: true, force: true });
console.log("workspace-grounding-gate: ok");
