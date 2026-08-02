#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { issueScopeToken } = require("../src/main/long-task/scope-token.js");
const { startJob, statusJob, logsJob, listJobs, stopJob } = require("../src/main/mcp/process-jobs-core.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-durable-process-"));
const secret = Buffer.alloc(32, 19).toString("base64url");
const scope = { ownerScope: "owner-a", sessionId: "session-a", projectId: "project-a", turnId: "turn-a" };
const foreign = { ownerScope: "owner-a", sessionId: "session-b", projectId: "project-a", turnId: "turn-b" };
const token = issueScopeToken({ secret, scope, operations: ["start", "status", "logs", "stop", "list"], ttlMs: 60_000 });
const foreignToken = issueScopeToken({ secret, scope: foreign, operations: ["status", "logs", "stop", "list"], ttlMs: 60_000 });
const options = { durable: { dbPath: path.join(dir, "long-tasks.db"), secret, jobsDir: path.join(dir, "jobs") } };

try {
  const started = await startJob({
    scopeToken: token,
    command: process.execPath,
    args: ["-e", "console.log('[lily-progress] {\"phase\":\"work\",\"current\":1,\"total\":1}'); console.log('DURABLE_DONE')"],
    cwd: dir,
    idempotencyKey: "turn-a:durable",
    healthcheck: { type: "process" },
  }, options);
  assert.equal(started.ok, true, JSON.stringify(started));
  assert(started.jobId && started.pid > 0);

  const hidden = await statusJob({ scopeToken: foreignToken, jobId: started.jobId }, options);
  assert.equal(hidden.error, "JOB_NOT_FOUND", "foreign session cannot infer job existence");

  let status;
  const deadline = Date.now() + 5_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = await statusJob({ scopeToken: token, jobId: started.jobId }, options);
  } while (status.status !== "succeeded" && Date.now() < deadline);
  assert.equal(status.status, "succeeded", JSON.stringify(status));
  assert.equal(status.exitCode, 0);
  assert.equal(status.progress?.phase, "work");

  const logs = logsJob({ scopeToken: token, jobId: started.jobId, tailBytes: 4096 }, options);
  assert.equal(logs.ok, true);
  assert.match(logs.stdout.text, /DURABLE_DONE/);
  const listed = listJobs({ scopeToken: token }, options);
  assert.equal(listed.jobs.length, 1);

  const duplicate = await startJob({
    scopeToken: token,
    command: process.execPath,
    args: ["-e", "process.exit(99)"],
    cwd: dir,
    idempotencyKey: "turn-a:durable",
  }, options);
  assert.equal(duplicate.jobId, started.jobId, "idempotent restart does not execute a second command");

  const stopped = await stopJob({ scopeToken: token, jobId: started.jobId }, options);
  assert.equal(stopped.alreadyExited, true);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("durable-process-jobs: ok");
