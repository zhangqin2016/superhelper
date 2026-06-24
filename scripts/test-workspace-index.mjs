#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getWorkspaceIndex, searchWorkspaceIndex } = require("../src/main/workspace-index.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-workspace-index-"));
fs.mkdirSync(path.join(root, "src/main"), { recursive: true });
fs.mkdirSync(path.join(root, "node_modules/pkg"), { recursive: true });
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "src/main/turn-orchestrator.js"), "const sessionIdle = true;\n", "utf8");
fs.writeFileSync(path.join(root, "src/main/evidence-ledger.js"), "module.exports = {};\n", "utf8");
fs.writeFileSync(path.join(root, "node_modules/pkg/session-idle.js"), "", "utf8");
fs.writeFileSync(path.join(root, "dist/session-idle.js"), "", "utf8");

const index = getWorkspaceIndex(root, { maxFiles: 100 });
assert(index.files.some((item) => item.relativePath === "src/main/turn-orchestrator.js"));
assert(!index.files.some((item) => item.relativePath.includes("node_modules")));
assert(!index.files.some((item) => item.relativePath.includes("dist")));

const hits = searchWorkspaceIndex(root, ["sessionIdle", "evidence-ledger"], { maxFiles: 100 });
assert(hits.some((item) => item.relativePath === "src/main/turn-orchestrator.js"));
assert(hits.some((item) => item.relativePath === "src/main/evidence-ledger.js"));
assert(hits.every((item) => !item.relativePath.includes("node_modules")));

console.log("workspace-index: ok");
