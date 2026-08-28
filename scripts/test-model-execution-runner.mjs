import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SessionRunnerPool } = require("../src/main/session-runner-pool.js");
const spawnEnv = require("../src/main/spawn-env.js");
const original = spawnEnv.resolveLilyEnv;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-model-execution-"));
const old = { ...process.env };
const globalEnv = { LILY_MODEL: "global", LILY_API_BASE_URL: "https://global.test/v1", LILY_API_KEY: "fixture", LILY_CONTEXT_WINDOW_TOKENS: "1000000", LILY_MODEL_CAPABILITY_GRADE: "lite" };
const selectedEnv = { LILY_MODEL: "selected", LILY_API_BASE_URL: "https://selected.test/v1", LILY_OPENCODE_PROVIDER_ID: "selected-provider", LILY_API_KEY: "fixture", LILY_CONTEXT_WINDOW_TOKENS: "32000" };
let pool;
try {
  process.env.OPENCODE_BIN = process.execPath;
  process.env.LILY_USER_DATA_DIR = tmp;
  spawnEnv.resolveLilyEnv = () => ({ ...globalEnv });
  pool = new SessionRunnerPool();
  pool._opencodeMcpServers = () => ({});
  pool._opencodePlugins = () => [];
  pool._opencodeGuideContent = () => "";
  const runner = pool.ensure("session_1", process.cwd(), {
    modelExecution: { env: selectedEnv, model: { id: "selected", modelID: "selected", providerID: "selected-provider", limits: { contextTokens: 32000 } } },
  }, { lazy: true });
  const config = JSON.parse(runner.spawnOptions.opencodeConfig);
  assert.equal(config.model, "selected-provider/selected");
  const model = config.provider["selected-provider"].models.selected;
  assert.equal(model.limit.context, 32000);
  assert(Number.isFinite(model.limit.output), "OpenCode's limit schema requires both context and output even if one is unknown");
  for (const id of ["general", "explore", "compaction", "title"]) assert.equal(config.agent[id].model, config.model);
  assert.notEqual(config.permission.task, "deny", "a strong selected model must not inherit the global lite tool restriction");
  assert.equal(runner.spawnOptions.model.contextWindowTokens, 32000);
  assert.equal(runner.spawnOptions.env.LILY_MODEL, "selected");
  assert(Number(runner.spawnOptions.env.LILY_CONTEXT_TOKEN_BUDGET) < 32000);
  assert.equal(spawnEnv.resolveLilyEnv().LILY_MODEL, "global", "no global setting mutation");
  pool._opencodeBasePersona = () => "";
  assert.throws(() => pool.ensure("session_1", process.cwd(), {
    modelExecution: { env: globalEnv, model: { modelID: "global", providerID: "lily" } },
  }, { lazy: true }), /LILY_BASE_PERSONA_UNAVAILABLE/, "a failed model switch must not reuse the previous model silently");
  console.log("model-execution-runner: ok");
} finally {
  pool?.terminateAll?.();
  spawnEnv.resolveLilyEnv = original;
  for (const key of ["OPENCODE_BIN", "LILY_USER_DATA_DIR"]) {
    if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
