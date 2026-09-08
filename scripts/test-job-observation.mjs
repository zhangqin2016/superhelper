import assert from "node:assert/strict";
import helper from "../resources/opencode-plugins/lib/job-observation.cjs";
const { stableToolResult } = helper;
const input = { jobId: "j" };
const base = { ok: true, jobId: "j", state: "running", stdoutBytes: 1, progress: { current: 1, total: 5 }, updatedAt: "a" };
const a = JSON.stringify(base);
const b = JSON.stringify({ updatedAt: "b", progress: { total: 5, current: 1 }, stdoutBytes: 1, state: "running", jobId: "j", ok: true });
assert.equal(stableToolResult("job_status", input, a), stableToolResult("job_status", input, b), "field order and timestamps do not create job progress");
for (const patch of [{ stdoutBytes: 2 }, { state: "succeeded" }, { progress: { current: 2, total: 5 } }, { error: "new error" }]) {
  assert.notEqual(stableToolResult("job_status", input, a), stableToolResult("job_status", input, JSON.stringify({ ...base, ...patch })), "real changes remain distinct");
}
for (const raw of ["broken json", "x".repeat(1_000_001), JSON.stringify({ ...base, ok: false }), JSON.stringify({ ...base, jobId: "other" }), JSON.stringify({ ...base, state: "invented" })]) {
  assert.equal(stableToolResult("job_status", input, raw), raw, "unknown/failed/oversized observations remain untouched");
}
assert.equal(stableToolResult("unrelated_job_status", input, a), a, "unrelated tool name has no normalization authority");
assert.equal(stableToolResult("read", input, a), a);
const wrapper = { content: [{ type: "text", text: a }] };
const copy = JSON.stringify(wrapper); stableToolResult("job_status", input, wrapper); assert.equal(JSON.stringify(wrapper), copy, "wire output is immutable");
for (const name of ["job_status", "lily_process_jobs_job_status", "lily_process_jobs.job_status", "mcp__lily_process_jobs__job_status", "lily_pj_job_status", "mcp__lily_pj__job_status"]) {
  assert.equal(stableToolResult(name, input, a), stableToolResult("job_status", input, a), "native and MCP tool names share observation semantics");
}
const errorWrapper = { isError: true, content: [{ type: "text", text: a }] };
assert.equal(stableToolResult("job_status", input, errorWrapper), errorWrapper, "error envelope keeps baseline identity and contents");
console.log("job-observation: PASS");
