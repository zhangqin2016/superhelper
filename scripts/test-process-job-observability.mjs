#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { assert, finish } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const {
  listJobs,
  startJob,
  statusJob,
  stopJob,
} = require("../src/main/mcp/process-jobs-core.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-process-job-observability-"));
const outputFile = path.join(tmp, "result.json");
let startedPid = null;

try {
  const script = [
    "const fs = require('fs');",
    "fs.writeFileSync(process.argv[1], JSON.stringify({ ok: true }));",
    "console.log('[lily-progress] {\"phase\":\"extract\",\"label\":\"page\",\"current\":1,\"total\":3,\"domain\":\"document\"}');",
    "setInterval(() => {}, 1000);",
  ].join(" ");

  const job = await startJob({
    command: process.execPath,
    args: ["-e", script, outputFile],
    cwd: tmp,
    outputFiles: [outputFile],
    healthcheck: { type: "log", contains: "[lily-progress]" },
    waitForHealthMs: 5_000,
  }, { registryDir: tmp });

  assert(job.ok === true, `job_start should succeed: ${JSON.stringify(job)}`);
  startedPid = job.pid;
  assert(job.status === "running", "existing status field remains available");
  assert(job.state === "running", `job_start exposes state alias: ${JSON.stringify(job)}`);
  assert(job.phase === "extract", `job_start exposes progress phase: ${JSON.stringify(job)}`);
  assert(typeof job.heartbeatAt === "string" && job.heartbeatAt, `job_start exposes heartbeatAt: ${JSON.stringify(job)}`);
  assert(Array.isArray(job.outputFiles) && job.outputFiles.includes(outputFile), `job_start exposes output files: ${JSON.stringify(job)}`);
  assert(job.recoverable === true, `running job is recoverable/observable: ${JSON.stringify(job)}`);

  const status = await statusJob({ jobId: job.jobId, healthcheck: { type: "process" } }, { registryDir: tmp });
  assert(status.ok === true, `job_status should succeed: ${JSON.stringify(status)}`);
  assert(status.state === status.status, "state alias tracks existing status");
  assert(status.phase === "extract", `job_status exposes phase from latest progress: ${JSON.stringify(status)}`);
  assert(status.progress?.label === "page", `job_status keeps full parsed progress: ${JSON.stringify(status.progress)}`);
  assert(status.outputFiles.includes(outputFile), `job_status preserves output file hints: ${JSON.stringify(status)}`);
  assert(status.heartbeatAt >= job.heartbeatAt, "heartbeat should not move backwards");

  const listed = listJobs({}, { registryDir: tmp });
  assert(listed.ok === true, `job_list should succeed: ${JSON.stringify(listed)}`);
  const listedJob = listed.jobs.find((item) => item.jobId === job.jobId);
  assert(listedJob?.state === "running", `job_list exposes normalized state: ${JSON.stringify(listedJob)}`);
  assert(Array.isArray(listedJob.outputFiles), `job_list exposes outputFiles array: ${JSON.stringify(listedJob)}`);

  const stopped = await stopJob({ jobId: job.jobId, timeoutMs: 2_000 }, { registryDir: tmp });
  assert(stopped.ok === true && stopped.stopped === true, `job_stop should stop process: ${JSON.stringify(stopped)}`);
  assert(stopped.state === "stopped", `job_stop exposes normalized state: ${JSON.stringify(stopped)}`);
  assert(stopped.recoverable === false, `stopped job should not be marked recoverable: ${JSON.stringify(stopped)}`);

  finish("test-process-job-observability", 10);
} finally {
  if (startedPid) {
    try { process.kill(startedPid, "SIGTERM"); } catch { /* best effort cleanup */ }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
