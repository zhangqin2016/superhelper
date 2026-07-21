#!/usr/bin/env node
// Startup health self-check: engine-missing surfaces as an issue, local
// diagnostics errors are forwarded, internal failures stay silent (fail-open).

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const supportDiagnosticsPath = require.resolve("../src/main/support-diagnostics.js");
let diagnosticsResult = { checks: [] };
require.cache[supportDiagnosticsPath] = {
  id: supportDiagnosticsPath,
  filename: supportDiagnosticsPath,
  loaded: true,
  exports: {
    runSupportDiagnosticsPublic: async () => diagnosticsResult,
  },
};

const { collectStartupIssues } = require("../src/main/startup-health.js");

// 1. Engine missing is reported even when diagnostics is clean.
diagnosticsResult = { checks: [{ id: "model.default", status: "ok" }] };
{
  const issues = await collectStartupIssues({ getAgentBootstrap: () => ({ ok: false, error: "OPENCODE_ENGINE_MISSING" }) });
  assert(issues.some((issue) => issue.id === "engine.missing"));
}

// 2. Error-status checks become issues; ok/warning stay silent.
diagnosticsResult = {
  checks: [
    { id: "model.default", status: "ok" },
    { id: "service.config", status: "warning", label: "服务配置", detail: "缓存不可用" },
    { id: "engine.boot", status: "error", label: "引擎启动", detail: "引擎启动后立即退出（退出码 1）。" },
  ],
};
{
  const issues = await collectStartupIssues({ getAgentBootstrap: () => ({ ok: true }) });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].id, "engine.boot");
  assert(/引擎启动后立即退出/.test(issues[0].message));
}

// 3. Diagnostics exploding internally → fail-open, no issues.
require.cache[supportDiagnosticsPath].exports.runSupportDiagnosticsPublic = async () => {
  throw new Error("diagnostics exploded");
};
{
  const issues = await collectStartupIssues({ getAgentBootstrap: () => ({ ok: true }) });
  assert.equal(issues.length, 0);
}

console.log("startup-health: ok");
