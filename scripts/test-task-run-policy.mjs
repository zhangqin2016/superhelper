#!/usr/bin/env node

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { assessTaskVerification } = require("../src/main/task-run-state.js");

{
  const code = assessTaskVerification({
    taskType: "code",
    evidence: [{ kind: "tool_result", label: "npm test", status: "done" }],
  });
  if (code.status !== "verified" || code.reason !== "test_or_build_evidence") {
    throw new Error(`code test evidence should verify task: ${JSON.stringify(code)}`);
  }
}

{
  const weak = assessTaskVerification({
    taskType: "code",
    evidence: [{ kind: "tool_result", label: "Read done", status: "done" }],
  });
  if (weak.status !== "unverified" || weak.reason !== "missing_test_or_build_evidence") {
    throw new Error(`code task without test/build evidence should be unverified: ${JSON.stringify(weak)}`);
  }
}

{
  const unknown = assessTaskVerification({ taskType: "", evidence: [] });
  if (unknown.status !== "not_required") {
    throw new Error(`unknown task should not require verification: ${JSON.stringify(unknown)}`);
  }
}

{
  const gate = assessTaskVerification({
    taskType: "code",
    evidenceGateAssessment: { ok: false, code: "MISSING_SOURCE_COVERAGE" },
  });
  if (gate.status !== "unverified" || gate.reason !== "MISSING_SOURCE_COVERAGE") {
    throw new Error(`evidence gate should remain authoritative: ${JSON.stringify(gate)}`);
  }
}

console.log("task-run-policy: ok");
