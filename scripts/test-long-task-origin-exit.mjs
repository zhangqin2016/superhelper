#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { issueScopeToken } = require("../src/main/long-task/scope-token.js");
const { statusJob } = require("../src/main/mcp/process-jobs-core.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-origin-exit-"));
const dbPath = path.join(dir, "long-tasks.db");
const jobsDir = path.join(dir, "jobs");
const resultPath = path.join(dir, "survived.txt");
const secret = Buffer.alloc(32, 31).toString("base64url");
const scope = { ownerScope: "owner", sessionId: "session", projectId: "project", turnId: "turn" };
const token = issueScopeToken({ secret, scope, operations: ["start", "status"], ttlMs: 60_000 });
const corePath = path.join(process.cwd(), "src/main/mcp/process-jobs-core.js");
const helper = `
  const { startJob } = require(${JSON.stringify(corePath)});
  startJob({ scopeToken: process.env.TOKEN, command: process.execPath,
    args: ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(resultPath)}, 'ok'), 350)`)}],
    cwd: process.env.DIR, idempotencyKey: 'origin-exit', outputFiles: [process.env.RESULT]
  }, { durable: { dbPath: process.env.DB, jobsDir: process.env.JOBS, secret: process.env.SECRET } })
    .then((result) => { console.log(JSON.stringify(result)); process.exit(result.ok ? 0 : 1); });
`;

try {
  const child = spawnSync(process.execPath, ["-e", helper], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, TOKEN: token, DIR: dir, RESULT: resultPath, DB: dbPath, JOBS: jobsDir, SECRET: secret },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const started = JSON.parse(child.stdout.trim().split("\n").at(-1));
  assert.equal(started.ok, true);
  let status;
  const deadline = Date.now() + 5_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = await statusJob({ scopeToken: token, jobId: started.jobId }, {
      durable: { dbPath, jobsDir, secret },
    });
  } while (status.status !== "succeeded" && Date.now() < deadline);
  assert.equal(status.status, "succeeded", JSON.stringify(status));
  assert.equal(fs.readFileSync(resultPath, "utf8"), "ok", "worker survives the MCP/origin process exit");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("long-task-origin-exit: ok");
