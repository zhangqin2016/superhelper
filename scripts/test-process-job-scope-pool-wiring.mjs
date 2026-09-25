#!/usr/bin/env node
/**
 * The process-job scope reaches the runner THROUGH the pool.
 *
 * The plugin, the grant and the guidance were each unit-tested against options
 * handed straight to the runner; the pool, which assembles those options in
 * production, dropped the scope — so a session would have had neither the
 * host-attached token nor the prompt-carried one. Review catch, 2026-09-25.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-job-scope-pool-"));
process.env.LILY_USER_DATA_DIR = tmp;
process.env.LILY_PROCESS_JOBS_SCOPE_SECRET = Buffer.alloc(32, 5).toString("base64url");
const previousIdentity = process.env.LILY_RUNTIME_IDENTITY_V1;
process.env.OPENCODE_BIN = process.execPath;
const spawnEnv = require("../src/main/spawn-env.js");
spawnEnv.resolveLilyEnv = () => ({ LILY_MODEL: "fixture", LILY_API_BASE_URL: "https://fixture.test/v1", LILY_API_KEY: "fixture", LILY_CONTEXT_WINDOW_TOKENS: "32000" });
const { SessionRunnerPool } = require("../src/main/session-runner-pool.js");
const { verifyProcessJobScope } = require("../src/main/long-task/turn-scope.js");
let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };

function build(extra) {
  const pool = new SessionRunnerPool();
  pool._opencodeMcpServers = () => ({});
  pool._opencodePlugins = () => [];
  pool._opencodeGuideContent = () => "# Lily";
  const runner = pool.ensure("session_scope", tmp, extra, { lazy: true });
  return runner.spawnOptions;
}
const scope = { ownerScope: "owner:u1", sessionId: "session_scope", projectId: "project_1" };

try {
  delete process.env.LILY_RUNTIME_IDENTITY_V1;
  const hosted = build({ processJobScope: scope, processJobTurnId: "turn_1" });
  assert.ok(hosted.runtimeIdentity, "the engine is fed the identity registry");
  assert.deepEqual(hosted.processJobScope, scope, "the scope rides the runner so each dispatch issues it for its own turn");
  assert.match(hosted.guidance, /omit scopeToken/, "the prompt says the host attaches it");
  assert.doesNotMatch(hosted.guidance, /scopeToken: `/, "and carries no token");
  check("with the identity registry, the scope is on the runner and out of the prompt");

  process.env.LILY_RUNTIME_IDENTITY_V1 = "0";
  const prompted = build({ processJobScope: scope, processJobTurnId: "turn_2" });
  assert.equal(prompted.processJobScope, null, "no registry: nothing for the plugin to attach");
  const token = /scopeToken: `([^`]+)`/.exec(prompted.guidance)?.[1];
  assert.ok(token, "the prompt carries the token instead");
  const verified = verifyProcessJobScope({ scopeToken: token }, { secret: process.env.LILY_PROCESS_JOBS_SCOPE_SECRET, operation: "start" });
  assert.deepEqual(verified.scope, { ...scope, turnId: "turn_2" }, "and it is this turn's scope");
  check("without the identity registry, the prompt-carried token is exactly the previous route");

  delete process.env.LILY_RUNTIME_IDENTITY_V1;
  const none = build({});
  assert.equal(none.processJobScope, null);
  assert.doesNotMatch(none.guidance, /Process Job Scope/, "a session with no owner scope gets no scope guidance, as before");
  check("no scope, no guidance");
} finally {
  if (previousIdentity === undefined) delete process.env.LILY_RUNTIME_IDENTITY_V1; else process.env.LILY_RUNTIME_IDENTITY_V1 = previousIdentity;
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`process-job-scope-pool-wiring: ok (${checks} checks)`);
