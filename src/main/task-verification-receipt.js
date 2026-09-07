"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { resolveToolSemantics } = require("./tool-semantics");
const { buildIntentContract } = require("./intent-contract");
const { taskTypeDefinition } = require("./task-type-schema");
const extractionBaseline = buildIntentContract({ taskType: "content_extraction", verificationStrategy: taskTypeDefinition("content_extraction").verification });

function defaultExtractionRequirements(criteria = [], deliverables = []) {
  return criteria.every(item => extractionBaseline.successCriteria.includes(item))
    && deliverables.every(item => extractionBaseline.deliverables.includes(item));
}

// Recognize literal invocations, not words in titles, paths or printed output.
// Complex shell programs remain observations; this function never runs a shell.
function verificationInvocation(command = "") {
  const text = String(command).trim();
  if (!text || text.length > 4096 || /[\n\r;|&<>`$()#\\]/.test(text)) return "";
  const args = text.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)?.map(x => x.replace(/^(["'])(.*)\1$/, "$2")) || [];
  if (args.some(arg => ["--help", "-h", "--version", "--collect-only", "--listTests", "--list", "list", "--dry-run"].includes(arg))) return "";
  const executable = path.basename(args.shift() || "").replace(/\.(exe|cmd)$/i, "").toLowerCase();
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
    if (args[0] === "run") args.shift();
    const action = args[0] || "";
    if (/^(test|lint|typecheck|type-check|build)(?::[\w-]+)?$/.test(action)) return action.split(":")[0].replace("type-check", "typecheck");
  }
  if (["pytest", "jest", "vitest", "mocha"].includes(executable)) return "test";
  if (executable === "npx" && ["jest", "vitest", "mocha"].includes(args[0])) return "test";
  if (["python", "python3"].includes(executable) && args[0] === "-m" && args[1] === "pytest") return "test";
  if (executable === "node" && (args[0] === "--test" || /^test-[\w.-]+\.(mjs|cjs|js)$/.test(path.basename(args[0] || "")))) return "test";
  return "";
}

function executionReceipt(tool = {}) {
  const name = String(tool.name || "").toLowerCase();
  const shell = ["bash", "shell_command", "exec_command"].includes(name);
  const command = String(tool.input?.command || tool.input?.cmd || "");
  const wrapper = shell && command.length <= 4096 ? command.match(/^([^\n\r;]+);\s*echo "EXIT_CODE=\$\?"\s*$/) : null;
  const kind = shell ? verificationInvocation(wrapper ? wrapper[1] : command) : "";
  const outerCode = tool.metadata?.exit ?? tool.metadata?.exitCode ?? tool.result?.exitCode ?? tool.result?.exit_code;
  // This suffix reports the immediately preceding command, not a claimed PASS.
  // Require its final complete line: earlier markers printed by a test do not count.
  const output = typeof tool.result === "string" ? tool.result : "";
  const reported = wrapper && tool.metadata?.truncated !== true ? output.match(/(?:^|\n)EXIT_CODE=(\d{1,3})\r?\n?$/) : null;
  const code = wrapper ? (reported && Number(reported[1]) <= 255 ? Number(reported[1]) : undefined) : outerCode;
  const completed = tool.completionObserved === true && ["done", "completed", "success"].includes(tool.status) && tool.isError !== true;
  const successful = completed && code === 0 && (!wrapper || outerCode === 0);
  return {
    schemaVersion: 1,
    kind: kind || "observation",
    verified: Boolean(kind && successful),
    // Later writes invalidate earlier checks. Known inspections do not.
    mutates: !kind && tool.completionObserved === true && resolveToolSemantics(tool).externalSideEffect === true,
    ...(Number.isInteger(code) ? { exitCode: code } : {}),
  };
}

function hasVerificationReceipt(evidence, kind = "") {
  return evidence.some(item => item.receipt?.schemaVersion === 1 && item.receipt.verified === true
    && item.receipt.stale !== true && (!kind || item.receipt.kind === kind));
}

function existingArtifacts(artifacts = []) {
  return artifacts.slice(0, 64).filter(artifact => {
    if (typeof artifact?.path !== "string" || !path.isAbsolute(artifact.path)) return false;
    try { const stat = fs.statSync(artifact.path); return stat.isFile() && stat.size > 0; } catch { return false; }
  });
}

function deliveryAssessment(deliverables = [], workspacePath = "") {
  if (!Array.isArray(deliverables) || !deliverables.length) return null;
  const manifest = require("./task-delivery-manifest").inspectDeliverables(deliverables, workspacePath);
  if (manifest.some(item => item.status !== "exists")) return { status: "unverified", reason: "missing_declared_delivery", manifest };
  return { status: "observed", reason: "delivery_requires_semantic_acceptance" };
}

module.exports = { executionReceipt, hasVerificationReceipt, verificationInvocation, existingArtifacts, deliveryAssessment, defaultExtractionRequirements };
