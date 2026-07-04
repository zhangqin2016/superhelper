#!/usr/bin/env node
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/lily_validation_test";

const { validateConfigProfileConfig } = await import("../server/src/routes/admin/config-profiles.js");
const { closeDb } = await import("../server/src/db.js");

try {
  assert.equal(
    validateConfigProfileConfig({
      schemaVersion: 1,
      models: {
        source: "service",
        providers: ["deepseek", "glm"],
        activeProvider: "deepseek",
      },
    }),
    null,
    "provider-menu delivery should be accepted",
  );

  assert.equal(
    validateConfigProfileConfig({
      schemaVersion: 1,
      models: {
        source: "service-managed",
        activePresetId: "deepseek-gateway",
        presets: [
          {
            id: "deepseek-gateway",
            env: {
              LILY_API_BASE_URL: "/llm/deepseek",
              LILY_API_KEY: "$LILY_GATEWAY_TOKEN",
              LILY_GATEWAY_PROVIDER: "deepseek",
            },
          },
        ],
      },
    }),
    null,
    "manual gateway presets should remain possible for advanced safe use",
  );

  assert.equal(
    validateConfigProfileConfig({
      models: {
        providers: ["deepseek"],
        activeProvider: "deepseek",
        presets: [{ id: "legacy" }],
      },
    })?.code,
    "CONFIG_PROFILE_MIXED_MODEL_MODES",
    "provider directives and preset directives must not be mixed in one profile",
  );

  assert.equal(
    validateConfigProfileConfig({
      models: {
        source: "client-direct",
        activePresetId: "deepseek",
        presets: [
          {
            id: "deepseek",
            env: {
              LILY_API_BASE_URL: "https://api.deepseek.com/anthropic",
              LILY_API_KEY: "$LILY_PROVIDER_KEY",
              LILY_GATEWAY_PROVIDER: "deepseek",
            },
          },
        ],
      },
    })?.code,
    "CONFIG_PROFILE_CLIENT_DIRECT_NOT_ALLOWED",
    "admin profiles must not ship client-direct presets",
  );

  assert.equal(
    validateConfigProfileConfig({
      models: {
        activePresetId: "deepseek",
        presets: [
          {
            id: "deepseek",
            env: {
              LILY_API_BASE_URL: "/llm/deepseek",
              LILY_API_KEY: "$LILY_PROVIDER_KEY",
            },
          },
        ],
      },
    })?.code,
    "CONFIG_PROFILE_PROVIDER_KEY_PLACEHOLDER_NOT_ALLOWED",
    "admin profiles must not contain provider-key placeholders",
  );

  assert.equal(
    validateConfigProfileConfig({
      models: {
        activePresetId: "deepseek",
        presets: [
          {
            id: "deepseek",
            env: {
              LILY_API_BASE_URL: "https://api.deepseek.com/anthropic",
              LILY_API_KEY: "$LILY_GATEWAY_TOKEN",
              LILY_GATEWAY_PROVIDER: "deepseek",
            },
          },
        ],
      },
    })?.code,
    "CONFIG_PROFILE_MIXED_GATEWAY_AND_UPSTREAM_URL",
    "gateway provider markers must not point at upstream provider URLs",
  );
} finally {
  await closeDb();
}

console.log("config profile validation tests passed");
