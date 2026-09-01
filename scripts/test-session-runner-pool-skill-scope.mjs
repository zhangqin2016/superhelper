#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { SessionRunnerPool } = require("../src/main/session-runner-pool.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-runner-scope-"));
const oldBin = process.env.OPENCODE_BIN;
const oldModel = process.env.LILY_MODEL;
const oldBase = process.env.LILY_API_BASE_URL;
const oldKey = process.env.LILY_API_KEY;
const oldUserData = process.env.LILY_USER_DATA_DIR;

// This lazy config-only fixture never launches the engine.
process.env.OPENCODE_BIN = process.execPath;
process.env.LILY_MODEL = "test-model";
process.env.LILY_API_BASE_URL = "https://example.invalid/v1";
process.env.LILY_API_KEY = "test-key";
process.env.LILY_USER_DATA_DIR = tmp;
const spawnEnv = require("../src/main/spawn-env.js");
const originalResolveLilyEnv = spawnEnv.resolveLilyEnv;
spawnEnv.resolveLilyEnv = () => ({
  LILY_MODEL: "test-model",
  LILY_API_BASE_URL: "https://example.invalid/v1",
  LILY_API_KEY: "test-key",
});

try {
  const pool = new SessionRunnerPool();
  let seenSkillIds = null;
  pool._opencodeMcpServers = (activeSkillIds) => {
    seenSkillIds = activeSkillIds;
    return {};
  };
  pool._opencodePlugins = () => [];
  pool._opencodeGuideContent = () => "";

  const runner = pool.ensure("session_1", process.cwd(), {
    activeSkillIds: ["lily-write", "learned-crm"],
  }, { lazy: true });

  assert(runner, "runner is created");
  assert.deepEqual(seenSkillIds, ["lily-write", "learned-crm"],
    "SessionRunnerPool passes the session skill scope into MCP assembly");
  const cfg = JSON.parse(runner.spawnOptions.opencodeConfig || "{}");
  assert(typeof cfg.model === "string" && cfg.model,
    "test precondition: shared runner config resolves a real model");
  assert(cfg.provider && Object.keys(cfg.provider).length > 0,
    "test precondition: shared runner config contains a nonempty provider config");
  const skillPaths = cfg.skills?.paths || [];
  assert(!skillPaths.some((p) => String(p).endsWith(path.join("lily-config", "skills"))),
    "shared OpenCode config must not expose the global skill registry across workspaces");
  console.log("session-runner-pool-skill-scope: ok");
} finally {
  spawnEnv.resolveLilyEnv = originalResolveLilyEnv;
  if (oldBin === undefined) delete process.env.OPENCODE_BIN;
  else process.env.OPENCODE_BIN = oldBin;
  if (oldModel === undefined) delete process.env.LILY_MODEL;
  else process.env.LILY_MODEL = oldModel;
  if (oldBase === undefined) delete process.env.LILY_API_BASE_URL;
  else process.env.LILY_API_BASE_URL = oldBase;
  if (oldKey === undefined) delete process.env.LILY_API_KEY;
  else process.env.LILY_API_KEY = oldKey;
  if (oldUserData === undefined) delete process.env.LILY_USER_DATA_DIR;
  else process.env.LILY_USER_DATA_DIR = oldUserData;
  fs.rmSync(tmp, { recursive: true, force: true });
}
