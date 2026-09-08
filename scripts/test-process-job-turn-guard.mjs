#!/usr/bin/env node

import { createRequire } from "node:module";
import { assert, finish } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const {
  findBlockingRunningProcessJobs,
  runningProcessJobNotice,
} = require("../src/main/process-job-turn-guard.js");

const renderTool = {
  id: "tool_render",
  name: "job_status",
  status: "done",
  result: {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: true,
        jobId: "job_blender",
        status: "running",
        state: "running",
        phase: "render",
        progress: { label: "frame", current: 700, total: 2440 },
        outputFiles: ["output/yugong_blender/frame_0007.png"],
      }),
    }],
  },
};

const blockers = findBlockingRunningProcessJobs([renderTool]);
assert(blockers.length === 1, `running render job should block completion: ${JSON.stringify(blockers)}`);
assert(blockers[0].jobId === "job_blender", "job id is preserved for follow-up");
assert(blockers[0].progress.current === 700, "progress is preserved");
assert(runningProcessJobNotice(blockers).includes("job_blender"), "notice names the running job");

const serviceTool = {
  id: "tool_server",
  name: "job_start",
  status: "done",
  result: {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: true,
        jobId: "job_dev_server",
        status: "running",
        state: "running",
        health: { ok: true, type: "http" },
      }),
    }],
  },
};
assert(
  findBlockingRunningProcessJobs([serviceTool]).length === 0,
  "healthy long-lived service without deliverable progress should not block completion",
);

const finishedRenderTool = {
  ...renderTool,
  result: {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: true,
        jobId: "job_blender",
        status: "exited",
        state: "exited",
        progress: { current: 2440, total: 2440 },
        outputFiles: ["output/yugong_blender/yugong_blender_0000-2439.mp4"],
      }),
    }],
  },
};
assert(
  findBlockingRunningProcessJobs([finishedRenderTool]).length === 0,
  "exited render job should not block completion",
);

const runningPayload = JSON.parse(renderTool.result.content[0].text);
const observed = (payload, overrides = {}) => ({
  ...renderTool,
  result: payload,
  ...overrides,
});

for (const status of ["exited", "stopped", "succeeded", "failed", "cancelled", "outcome_unknown"]) {
  const receipt = observed({ ok: true, jobId: "job_blender", state: status, status });
  assert(
    findBlockingRunningProcessJobs([renderTool, receipt]).length === 0,
    `${status} receipt must retire an earlier running blocker`,
  );
  assert(
    findBlockingRunningProcessJobs([receipt, renderTool]).length === 0,
    `${status} receipt must remain terminal when a stale running observation arrives later`,
  );
}
assert(
  findBlockingRunningProcessJobs([renderTool, finishedRenderTool]).length === 0,
  "terminal MCP text content retires the earlier running observation",
);
assert(
  findBlockingRunningProcessJobs([renderTool, observed(JSON.stringify({ ok: true, jobId: "job_blender", status: "succeeded" }))]).length === 0,
  "terminal JSON string receipt retires the earlier running observation",
);
const otherRunning = observed({ ...runningPayload, jobId: "job_other" });
const remaining = findBlockingRunningProcessJobs([renderTool, otherRunning, finishedRenderTool]);
assert(remaining.length === 1 && remaining[0].jobId === "job_other", "terminal receipt preserves a different running job");

const terminalPayload = { ok: true, jobId: "job_blender", status: "succeeded" };
for (const [label, invalid] of [
  ["malformed JSON", observed('{"jobId":"job_blender",')],
  ["missing status", observed({ ok: true, jobId: "job_blender" })],
  ["unknown status", observed({ ...terminalPayload, status: "unknown" })],
  ["conflicting status", observed({ ...terminalPayload, state: "running" })],
  ["conflicting terminal statuses", observed({ ...terminalPayload, state: "failed" })],
  ["failed query", observed({ ...terminalPayload, ok: false, error: "QUERY_FAILED" })],
  ["MCP error envelope", { ...finishedRenderTool, result: { ...finishedRenderTool.result, isError: true } }],
  ["error payload", observed({ ...terminalPayload, isError: true })],
  ["unfinished tool", observed(terminalPayload, { status: "running" })],
  ["failed tool", observed(terminalPayload, { status: "error" })],
  ["missing tool status", observed(terminalPayload, { status: undefined })],
  ["unrelated tool", observed(terminalPayload, { name: "search" })],
  ["missing tool name", observed(terminalPayload, { name: undefined })],
  ["mismatched requested job", observed(terminalPayload, { input: { jobId: "job_other" } })],
  ["malformed requested job", observed(terminalPayload, { input: { jobId: ["job_blender"] } })],
  ["incomplete success receipt", observed({ jobId: "job_blender", status: "succeeded" })],
]) {
  assert(findBlockingRunningProcessJobs([renderTool, invalid]).length === 1, `${label} cannot clear a known running job`);
}

assert(
  findBlockingRunningProcessJobs([renderTool, observed(terminalPayload, { input: { jobId: "job_blender" } })]).length === 0,
  "terminal receipt matching the requested job retires the running job",
);

for (const name of ["job_stop", "job_logs", "lily_process_jobs_job_status", "mcp__lily_process_jobs__job_status", "lily_pj_job_status", "mcp__lily_pj__job_status", "mcp__lily_pj_job_logs"]) {
  assert(
    findBlockingRunningProcessJobs([renderTool, observed(terminalPayload, { name, status: "completed" })]).length === 0,
    `${name} completed receipt retires the running job`,
  );
}
assert(
  findBlockingRunningProcessJobs([renderTool, observed({ ...terminalPayload, status: "failed", error: "EXIT_NONZERO" })]).length === 0,
  "successful observation of a failed process is terminal even when it carries the process error",
);
const updated = findBlockingRunningProcessJobs([renderTool, observed({ ...runningPayload, progress: { current: 900, total: 2440 } })]);
assert(updated[0]?.progress.current === 900, "newer running progress replaces earlier progress");
assert(
  findBlockingRunningProcessJobs([renderTool, observed({ ok: true, jobId: "job_blender", status: "running" })]).length === 1,
  "running observation without deliverable fields cannot erase a genuine blocker",
);

const firstGeneration = { pid: 101, startedAt: "2026-09-08T00:00:00.000Z" };
const nextGeneration = { pid: 202, startedAt: "2026-09-08T00:01:00.000Z" };
const oldTerminal = observed({ ...terminalPayload, ...firstGeneration });
const restarted = observed({ ...runningPayload, ...nextGeneration }, { name: "lily_pj_job_start", input: { jobId: "job_blender" } });
assert(
  findBlockingRunningProcessJobs([oldTerminal, restarted]).length === 1,
  "trusted new process start reusing a legacy job ID creates a new running blocker",
);
for (const oldReceipt of [
  oldTerminal,
  observed({ ...runningPayload, ...firstGeneration, progress: { current: 100, total: 2440 } }),
  observed({ ...runningPayload, ...firstGeneration, progress: { current: 100, total: 2440 } }, { name: "job_start" }),
  observed(terminalPayload),
]) {
  const jobs = findBlockingRunningProcessJobs([oldTerminal, restarted, oldReceipt]);
  assert(jobs.length === 1 && jobs[0].progress.current === 700, "older or unidentified receipt cannot retire or overwrite a new generation");
}
assert(
  findBlockingRunningProcessJobs([oldTerminal, restarted, observed({ ...terminalPayload, ...nextGeneration })]).length === 0,
  "terminal receipt for the new generation retires its blocker",
);
for (const staleStart of [
  observed({ ...runningPayload, ...firstGeneration }, { name: "job_start" }),
  observed({ ...runningPayload, ...nextGeneration }),
  observed({ ...runningPayload, pid: 202 }, { name: "job_start" }),
  observed({ ...runningPayload, ...nextGeneration }, { name: "job_start", status: "running" }),
  observed({ ...runningPayload, ...nextGeneration }, { name: "job_start", input: { jobId: "job_other" } }),
]) {
  assert(findBlockingRunningProcessJobs([oldTerminal, staleStart]).length === 0, "unproven restart cannot revive a terminal process generation");
}
assert(
  findBlockingRunningProcessJobs([observed(terminalPayload), restarted]).length === 0,
  "without the old generation identity a fresh process cannot be proven newer",
);

finish("test-process-job-turn-guard");
