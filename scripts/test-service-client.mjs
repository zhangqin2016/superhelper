#!/usr/bin/env node
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-service-client-"));

const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      getPath(name) {
        if (name === "userData") return tmp;
        return os.tmpdir();
      },
      getVersion: () => "0.1.0",
    },
  },
};

fs.writeFileSync(
  path.join(tmp, "service-settings.json"),
  JSON.stringify({ apiBaseUrl: "https://user-controlled.example.com" }),
);

delete process.env.LILY_SERVICE_API_BASE_URL;
delete process.env.SERVICE_API_BASE_URL;
const {
  getServiceSettings,
  registerDevice,
  reportSkillEvent,
  reportRuntimeDiagnostic,
} = require(path.join(__dirname, "../src/main/service-client.js"));

const builtInSettings = getServiceSettings();
if (builtInSettings.apiBaseUrl !== "https://lily.lanrensoft.cn") {
  throw new Error(`built-in service API should point to production domain: ${JSON.stringify(builtInSettings)}`);
}

process.env.LILY_SERVICE_API_BASE_URL = "https://service.example.com/";
const settings = getServiceSettings();
if (settings.apiBaseUrl !== "https://service.example.com") {
  throw new Error(`service API should ignore user settings: ${JSON.stringify(settings)}`);
}
if (settings.configurable !== false) {
  throw new Error("service API should not be user-configurable");
}

const requests = [];
global.fetch = async (url, options = {}) => {
  requests.push({ url, options, body: JSON.parse(options.body || "{}") });
  return {
    ok: true,
    json: async () => ({ ok: true }),
  };
};

await registerDevice();
await reportSkillEvent({
  eventType: "install",
  pluginId: "example-skill",
  pluginVersion: "1.2.3",
  metadata: { source: "test" },
});
await reportRuntimeDiagnostic({
  claudeVersion: "2.1.160",
  eventType: "system",
  eventSubtype: "new_protocol_shape",
  normalizedKind: "protocol_warning",
  severity: "warning",
  turnPhase: "busy",
  sessionState: "running",
  summary: "unknownEvent",
  trace: { schemaVersion: 1, event: { type: "system", subtype: "new_protocol_shape" } },
});

if (requests[0]?.url !== "https://service.example.com/api/devices/register") {
  throw new Error(`device registration URL mismatch: ${requests[0]?.url}`);
}
if (requests[1]?.url !== "https://service.example.com/api/plugins/events") {
  throw new Error(`skill event URL mismatch: ${requests[1]?.url}`);
}
if (requests[1].body.eventType !== "install" || requests[1].body.pluginId !== "example-skill") {
  throw new Error(`skill event body mismatch: ${JSON.stringify(requests[1].body)}`);
}
if (!requests[1].body.deviceId || !requests[1].body.fingerprintHash) {
  throw new Error(`skill event should include device identity: ${JSON.stringify(requests[1].body)}`);
}
if (requests[2]?.url !== "https://service.example.com/api/diagnostics/runtime-traces") {
  throw new Error(`runtime diagnostic URL mismatch: ${requests[2]?.url}`);
}
if (
  requests[2].body.normalizedKind !== "protocol_warning" ||
  requests[2].body.eventSubtype !== "new_protocol_shape" ||
  requests[2].body.trace?.event?.type !== "system"
) {
  throw new Error(`runtime diagnostic body mismatch: ${JSON.stringify(requests[2].body)}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("service-client: ok");
