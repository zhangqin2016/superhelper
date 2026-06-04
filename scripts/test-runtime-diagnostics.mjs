#!/usr/bin/env node
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);

const serviceClientPath = require.resolve("../src/main/service-client.js");
const reports = [];
require.cache[serviceClientPath] = {
  id: serviceClientPath,
  filename: serviceClientPath,
  loaded: true,
  exports: {
    reportRuntimeDiagnostic: async (payload) => {
      reports.push(payload);
      return { ok: true };
    },
  },
};

const { reportRuntimeProtocolIssue, sanitizeEvent } = require("../src/main/runtime-diagnostics.js");

const raw = {
  type: "control_request",
  request_id: "req_secret",
  request: {
    subtype: "can_use_tool",
    tool_name: "Bash",
    input: {
      command: "cat /Users/private/customer-contract.md",
      prompt: "private user question",
    },
  },
};

const sanitized = sanitizeEvent(raw);
const asText = JSON.stringify(sanitized);
if (asText.includes("customer-contract") || asText.includes("private user question") || asText.includes("cat /Users")) {
  throw new Error(`sanitizeEvent leaked private content: ${asText}`);
}
if (sanitized.type !== "control_request" || sanitized.requestSubtype !== "can_use_tool" || sanitized.toolName !== "Bash") {
  throw new Error(`sanitizeEvent removed protocol fields: ${asText}`);
}

await reportRuntimeProtocolIssue({
  normalizedKind: "unknown_control_request",
  event: raw,
  notice: { code: "unknownEvent", level: "warning", type: "control_request", subtype: "can_use_tool" },
  turnPhase: "busy",
  sessionState: "running",
});

if (reports.length !== 1) {
  throw new Error(`expected one diagnostic report, got ${reports.length}`);
}
const reportText = JSON.stringify(reports[0]);
if (reportText.includes("customer-contract") || reportText.includes("private user question") || reportText.includes("cat /Users")) {
  throw new Error(`runtime diagnostic report leaked private content: ${reportText}`);
}
if (reports[0].normalizedKind !== "unknown_control_request" || reports[0].eventType !== "control_request") {
  throw new Error(`runtime diagnostic report missing summary fields: ${reportText}`);
}

await reportRuntimeProtocolIssue({
  normalizedKind: "unknown_control_request",
  event: raw,
  notice: { code: "unknownEvent", level: "warning", type: "control_request", subtype: "can_use_tool" },
});
if (reports.length !== 1) {
  throw new Error("runtime diagnostic debounce should skip duplicate reports");
}

console.log("runtime-diagnostics: ok");
