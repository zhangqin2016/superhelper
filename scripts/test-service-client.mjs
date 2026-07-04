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
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
      decryptString: (buffer) => Buffer.from(buffer).toString("utf8").replace(/^protected:/, ""),
    },
  },
};

fs.writeFileSync(
  path.join(tmp, "service-settings.json"),
  JSON.stringify({ apiBaseUrl: "https://user-controlled.example.com" }),
);

delete process.env.LILY_SERVICE_API_BASE_URL;
delete process.env.SERVICE_API_BASE_URL;
process.env.CLIENT_REGION = "china";
const {
  getServiceSettings,
  registerDevice,
  fetchClientConfig,
  workspaceAppCatalog,
  rotateDeviceKeypair,
  reportSkillEvent,
  reportRuntimeDiagnostic,
} = require(path.join(__dirname, "../src/main/service-client.js"));

const builtInSettings = getServiceSettings();
if (builtInSettings.apiBaseUrl !== "https://lilych.lilywb.cn") {
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
await fetchClientConfig();
await workspaceAppCatalog();
await reportSkillEvent({
  eventType: "install",
  skillId: "example-skill",
  skillVersion: "1.2.3",
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
const beforeRotation = JSON.parse(fs.readFileSync(path.join(tmp, "device-state.json"), "utf8")).publicKey;
await rotateDeviceKeypair();
const afterRotation = JSON.parse(fs.readFileSync(path.join(tmp, "device-state.json"), "utf8")).publicKey;

if (requests[0]?.url !== "https://service.example.com/api/devices/register") {
  throw new Error(`device registration URL mismatch: ${requests[0]?.url}`);
}
if (requests[1]?.url !== "https://service.example.com/api/client/config") {
  throw new Error(`client config URL mismatch: ${requests[1]?.url}`);
}
if (!requests[1].body.deviceId || !requests[1].body.fingerprintHash) {
  throw new Error(`client config should include device identity: ${JSON.stringify(requests[1].body)}`);
}
if (!requests[1].body.publicKey || requests[1].body.keyAlg !== "ed25519") {
  throw new Error(`client config should include device public key: ${JSON.stringify(requests[1].body)}`);
}
for (const header of [
  "X-Lily-Device-Id",
  "X-Lily-Timestamp",
  "X-Lily-Nonce",
  "X-Lily-Body-Sha256",
  "X-Lily-Signature",
]) {
  if (!requests[1].options.headers?.[header]) {
    throw new Error(`client config request missing signature header ${header}`);
  }
}
if (requests[2]?.url !== "https://service.example.com/api/apps/catalog") {
  throw new Error(`workspace app catalog URL mismatch: ${requests[2]?.url}`);
}
for (const header of [
  "X-Lily-Device-Id",
  "X-Lily-Timestamp",
  "X-Lily-Nonce",
  "X-Lily-Body-Sha256",
  "X-Lily-Signature",
]) {
  if (!requests[2].options.headers?.[header]) {
    throw new Error(`workspace app catalog request missing signature header ${header}`);
  }
}
if (requests[3]?.url !== "https://service.example.com/api/skills/events") {
  throw new Error(`skill event URL mismatch: ${requests[3]?.url}`);
}
if (requests[3].body.eventType !== "install" || requests[3].body.skillId !== "example-skill") {
  throw new Error(`skill event body mismatch: ${JSON.stringify(requests[3].body)}`);
}
if (!requests[3].body.deviceId || !requests[3].body.fingerprintHash) {
  throw new Error(`skill event should include device identity: ${JSON.stringify(requests[3].body)}`);
}
if (requests[4]?.url !== "https://service.example.com/api/diagnostics/runtime-traces") {
  throw new Error(`runtime diagnostic URL mismatch: ${requests[4]?.url}`);
}
if (
  requests[4].body.normalizedKind !== "protocol_warning" ||
  requests[4].body.eventSubtype !== "new_protocol_shape" ||
  requests[4].body.trace?.event?.type !== "system"
) {
  throw new Error(`runtime diagnostic body mismatch: ${JSON.stringify(requests[4].body)}`);
}
if (requests[5]?.url !== "https://service.example.com/api/devices/rotate-key") {
  throw new Error(`device key rotation URL mismatch: ${requests[5]?.url}`);
}
if (!requests[5].body.newPublicKey || requests[5].body.newKeyAlg !== "ed25519") {
  throw new Error(`device key rotation should include new public key: ${JSON.stringify(requests[5].body)}`);
}
if (!beforeRotation || beforeRotation === afterRotation) {
  throw new Error("device key rotation should persist a new public key after service confirmation");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("service-client: ok");
