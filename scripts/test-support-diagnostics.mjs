#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-support-diagnostics-"));

function fakeGatewayToken() {
  const payload = Buffer.from(JSON.stringify({
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }), "utf8").toString("base64url");
  return `lilygw.${payload}.sig`;
}

const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      getPath(name) {
        if (name === "userData") return tmp;
        if (name === "home") return os.homedir();
        if (name === "documents") return tmp;
        return tmp;
      },
      getVersion: () => "0.1.114",
      isPackaged: false,
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
      decryptString: (buffer) => Buffer.from(buffer).toString("utf8").replace(/^protected:/, ""),
    },
  },
};

const remoteConfigState = {
  schemaVersion: 1,
  configVersion: "support-diagnostics-test",
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  effectiveConfig: {
    models: {
      activePresetId: "lily-managed:deepseek:gateway",
      presets: [
        {
          id: "lily-managed:deepseek:gateway",
          label: "DeepSeek Gateway",
          env: {
            LILY_API_BASE_URL: "/llm/deepseek",
            LILY_API_KEY: fakeGatewayToken(),
            LILY_MODEL: "deepseek-v4-pro[1m]",
          },
        },
      ],
    },
  },
};

fs.writeFileSync(
  path.join(tmp, "remote-config-cache.json"),
  JSON.stringify({
    config: {
      encrypted: true,
      data: Buffer.from(`protected:${JSON.stringify(remoteConfigState)}`, "utf8").toString("base64"),
    },
    updatedAt: new Date().toISOString(),
  }),
  "utf8",
);
fs.writeFileSync(
  path.join(tmp, "model-settings.json"),
  JSON.stringify({
    activePresetId: "custom-bad-gateway",
    customPresets: [
      {
        id: "custom-bad-gateway",
        label: "Bad Gateway",
        model: "bad-model",
        baseUrl: "https://bad-local.example.com/llm",
        apiKey: "sk-bad-custom-secret-123456",
        protocol: "openai",
      },
    ],
    apiGateway: {
      mode: "custom",
      baseUrl: "https://bad-gateway.example.com/v1",
      apiKey: "sk-bad-custom-gateway-123456",
      protocol: "openai",
    },
  }),
  "utf8",
);

const supportDiagnostics = require(path.join(__dirname, "../src/main/support-diagnostics.js"));
const diagnostic = await supportDiagnostics.runSupportDiagnosticsPublic({
  refreshService: false,
  includeEngine: false,
});

assert.equal(diagnostic.ok, true);
assert.equal(diagnostic.summary.status, "warning");
assert.equal(diagnostic.context.model.activePresetId, "custom-bad-gateway");
assert(
  diagnostic.checks.some((check) => check.id === "model.default" && check.status === "warning"),
  "diagnostics should flag custom model selection",
);
assert(
  diagnostic.recommendedActions.some((action) => action.id === "restore_default_model"),
  "diagnostics should recommend restoring Lily default model",
);
assert(
  JSON.stringify(diagnostic).includes("sk-bad-custom-secret") === false,
  "diagnostics must not expose API keys",
);

const reportCalls = [];
const serviceClientPath = require.resolve(path.join(__dirname, "../src/main/service-client.js"));
require.cache[serviceClientPath].exports.reportRuntimeDiagnostic = async (payload) => {
  reportCalls.push(payload);
  return { ok: true, json: { id: "diag_test" } };
};

const submitted = await supportDiagnostics.submitDiagnosticsFeedbackPublic({
  message: "客户点击发送后模型连接中断",
  diagnostic,
});
assert.equal(submitted.ok, true);
assert.equal(reportCalls.length, 1);
assert.equal(reportCalls[0].normalizedKind, "support_diagnostics");
assert.equal(reportCalls[0].eventSubtype, "model_default_warning");
assert.equal(reportCalls[0].trace.summary.status, "warning");
assert(
  JSON.stringify(reportCalls[0]).includes("sk-bad-custom-secret") === false,
  "submitted diagnostics must stay redacted",
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("support-diagnostics: ok");
