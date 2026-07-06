#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { assert, finish } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const {
  listJobs,
  logsJob,
  startJob,
  statusJob,
  stopJob,
} = require("../src/main/mcp/process-jobs-core.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-process-jobs-core-"));

try {
  const job = await startJob({
    command: process.execPath,
    args: ["-e", "console.log('ready'); console.log('[lily-progress] {\"label\":\"index\",\"current\":2,\"total\":5,\"domain\":\"file-index\"}'); setInterval(() => console.log('tick'), 1000);"],
    cwd: tmp,
    healthcheck: { type: "log", contains: "ready" },
    waitForHealthMs: 5_000,
  }, { registryDir: tmp });

  assert(job.ok === true, `job_start should succeed: ${JSON.stringify(job)}`);
  assert(job.pid > 0, "job_start returns a pid");
  assert(job.stdoutPath.startsWith(tmp), "job_start stores stdout under registry dir by default");
  assert(job.health?.ok === true, `job_start waits for log health: ${JSON.stringify(job.health)}`);

  const status = await statusJob({ jobId: job.jobId, healthcheck: { type: "process" } }, { registryDir: tmp });
  assert(status.ok === true && status.alive === true, `job_status should report live process: ${JSON.stringify(status)}`);
  assert(status.progress?.label === "index" && status.progress?.current === 2 && status.progress?.total === 5, `job_status should expose latest structured progress: ${JSON.stringify(status.progress)}`);

  const logs = logsJob({ jobId: job.jobId, tailBytes: 10_000 }, { registryDir: tmp });
  assert(logs.ok === true, `job_logs should succeed: ${JSON.stringify(logs)}`);
  assert(logs.stdout.text.includes("ready"), `job_logs should include stdout: ${JSON.stringify(logs.stdout)}`);
  assert(logs.progress?.domain === "file-index", `job_logs should expose parsed progress: ${JSON.stringify(logs.progress)}`);

  const listed = listJobs({}, { registryDir: tmp });
  assert(listed.ok === true && listed.jobs.some((item) => item.jobId === job.jobId), "job_list includes started job");

  const stopped = await stopJob({ jobId: job.jobId, timeoutMs: 2_000 }, { registryDir: tmp });
  assert(stopped.ok === true && stopped.stopped === true, `job_stop should stop the process: ${JSON.stringify(stopped)}`);

  const afterStop = await statusJob({ jobId: job.jobId }, { registryDir: tmp });
  assert(afterStop.ok === true && afterStop.alive === false, `stopped job should not be alive: ${JSON.stringify(afterStop)}`);

  const mediaFile = path.join(tmp, "speech.wav");
  fs.writeFileSync(mediaFile, "RIFFfakeWAVE");
  const mediaJob = await startJob({
    command: process.execPath,
    args: ["-e", `console.log('<generated_media type=\"speech\">\\n  <file path=\"${mediaFile}\" bytes=\"12\" />\\n</generated_media>');`],
    cwd: tmp,
    healthcheck: { type: "process" },
  }, { registryDir: tmp });
  assert(mediaJob.ok === true, `media job should start: ${JSON.stringify(mediaJob)}`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const mediaLogs = logsJob({ jobId: mediaJob.jobId, tailBytes: 10_000 }, { registryDir: tmp });
  assert(mediaLogs.ok === true, `media job logs should succeed: ${JSON.stringify(mediaLogs)}`);
  assert(mediaLogs.outputFiles.includes(mediaFile), `job_logs should infer generated_media outputFiles: ${JSON.stringify(mediaLogs)}`);
  const mediaStatus = await statusJob({ jobId: mediaJob.jobId }, { registryDir: tmp });
  assert(mediaStatus.outputFiles.includes(mediaFile), `job_status should persist inferred outputFiles: ${JSON.stringify(mediaStatus)}`);

  finish("test-process-jobs-core", 9);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
