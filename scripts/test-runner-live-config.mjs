#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-runner-live-config-"));
process.env.LILY_USER_DATA_DIR = root;
process.resourcesPath ||= root;
const { buildLiveEngineEnvPatch, applyLiveEnvToPool, terminateIdleRunners } = require("../src/main/runner-live-config.js");

function writeRemoteConfig(effectiveConfig) {
  const state = {
    schemaVersion: 1,
    configVersion: "test",
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    effectiveConfig,
  };
  fs.writeFileSync(
    path.join(root, "remote-config-cache.json"),
    JSON.stringify({
      config: {
        encrypted: false,
        data: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
      },
      updatedAt: new Date().toISOString(),
    }),
    "utf8",
  );
}

writeRemoteConfig({
  runtime: {
    env: {
      LILY_IMAGE_PROVIDER: "lily",
      LILY_VIDEO_PROVIDER: "lily",
      LILY_SPEECH_PROVIDER: "lily",
      LILY_MEDIA_IMAGE_ENDPOINT: "https://lily.example.com/llm/media/lily/image/generate",
      WEBSEARCH_IQS_API_KEY: "lily-search-token",
      WEBSEARCH_IQS_API_URL: "https://lily.example.com/llm/search/iqs",
    },
  },
});

{
  const patch = buildLiveEngineEnvPatch();
  assert.equal(patch.LILY_IMAGE_PROVIDER, "lily", "live env patch must include server-delivered image provider");
  assert.equal(patch.LILY_VIDEO_PROVIDER, "lily", "live env patch must include server-delivered video provider");
  assert.equal(patch.LILY_SPEECH_PROVIDER, "lily", "live env patch must include server-delivered speech provider");
  assert.equal(
    patch.LILY_MEDIA_IMAGE_ENDPOINT,
    "https://lily.example.com/llm/media/lily/image/generate",
    "live env patch must include server-delivered Lily media gateway endpoint",
  );
  assert.equal(patch.WEBSEARCH_IQS_API_KEY, "lily-search-token", "live env patch must include server-delivered search token");
  assert.equal(
    patch.WEBSEARCH_IQS_API_URL,
    "https://lily.example.com/llm/search/iqs",
    "live env patch must include server-delivered search gateway endpoint",
  );
}

{
  const calls = [];
  const runners = new Map([
    ["s1", { isAlive: () => true, updateEnvironmentVariables: (patch) => { calls.push(["s1", patch]); return true; } }],
    ["s2", { isAlive: () => true, updateEnvironmentVariables: (patch) => { calls.push(["s2", patch]); return false; } }],
    ["dead", { isAlive: () => false, updateEnvironmentVariables: () => { throw new Error("dead runner should be skipped"); } }],
  ]);
  const pool = {
    getSessionIds: () => [...runners.keys()],
    get: (id) => runners.get(id),
  };
  const result = applyLiveEnvToPool(pool, { LILY_MODEL: "deepseek-v4-pro[1m]" });
  assert.deepEqual(result, { applied: ["s1"], failed: ["s2"] }, "failed hot updates are surfaced for restart");
  assert.deepEqual(calls.map((entry) => entry[0]), ["s1", "s2"], "only live runners are patched");
}

{
  const terminated = [];
  const runners = new Map([
    ["idle", { isAlive: () => true, isBusy: () => false }],
    ["busy", { isAlive: () => true, isBusy: () => true }],
    ["dead", { isAlive: () => false, isBusy: () => false }],
  ]);
  const pool = {
    getSessionIds: () => [...runners.keys()],
    get: (id) => runners.get(id),
    terminateSession: (id) => terminated.push(id),
  };
  const result = terminateIdleRunners(pool);
  assert.deepEqual(terminated, ["idle"], "config rebuild only terminates idle live runners");
  assert.deepEqual(result, { terminated: ["idle"] }, "terminated runner ids are returned for callers that need observability");
}

console.log("runner-live-config: ok");
