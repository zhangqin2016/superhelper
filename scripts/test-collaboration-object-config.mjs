import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const api = await import("../server/src/services/collaboration/object-config.js").catch((error) => { if (error.code !== "ERR_MODULE_NOT_FOUND") throw error; return {}; });
assert.equal(typeof api.readCollaborationObjectConfig, "function", "private object settings need an independent explicit reader");
const { readCollaborationObjectConfig, validateCollaborationObjectConfig, createConfiguredCollaborationObjectService } = api;
const database = { transaction() {} };
const empty = readCollaborationObjectConfig({ QINIU_ACCESS_KEY: "public-ak", QINIU_SECRET_KEY: "public-secret", QINIU_BUCKET: "public", QINIU_PUBLIC_BASE_URL: "https://public.invalid", COLLAB_MESSAGE_KEK: "ab".repeat(32) });
assert.equal(empty.collaborationObjectStorage.accessKey, "");
assert.equal(empty.collaborationObjectKek, "");
assert.throws(() => validateCollaborationObjectConfig(empty), /COLLAB_OBJECT_KEK_UNAVAILABLE/);
const noConfig = createConfiguredCollaborationObjectService({ database, config: { ...empty, collaborationAttachmentsEnabled: true } });
await assert.rejects(noConfig.init({}), (error) => error.code === "COLLAB_OBJECT_KEK_UNAVAILABLE");
assert.equal(typeof noConfig.bindToMessage, "function", "binding and text assembly are not key-gated");
const env = { COLLAB_QINIU_ACCESS_KEY: "private-ak", COLLAB_QINIU_SECRET_KEY: "private-sk", COLLAB_QINIU_BUCKET: "private-bucket", COLLAB_QINIU_PRIVATE_BASE_URL: "https://private.invalid", COLLAB_QINIU_UPLOAD_URL: "https://upload.invalid", COLLAB_QINIU_PRIVATE_BUCKET: "true", COLLAB_OBJECT_KEK: "ab".repeat(32), COLLAB_OBJECT_KEK_VERSION: "v2", COLLAB_OBJECT_KEKS: JSON.stringify({ v1: Buffer.alloc(32, 4).toString("base64"), v2: "ab".repeat(32) }) };
const settings = readCollaborationObjectConfig(env);
const { keyBroker, objectStore } = validateCollaborationObjectConfig(settings);
assert.equal(typeof objectStore.head, "function");
const context = { objectId: "obj", ownerUserId: "owner", conversationId: "c", scopeType: "personal", organizationId: null, purpose: "attachment" };
const wrapped = keyBroker.wrap({ ...context, dek: Buffer.alloc(32, 1) });
assert.equal(wrapped.kekVersion, 2);
assert.deepEqual(keyBroker.unwrap({ ...context, ...wrapped }), Buffer.alloc(32, 1));
for (const overrides of [{ collaborationObjectKeks: '{secret' }, { collaborationObjectKek: "invalid!", collaborationObjectKeks: "" }, { collaborationObjectKekVersion: "v3" }, { collaborationObjectKeks: JSON.stringify({ 1: "ab".repeat(32), v1: "cd".repeat(32), v2: "ab".repeat(32) }) }]) {
  assert.throws(() => validateCollaborationObjectConfig({ ...settings, ...overrides }), /COLLAB_OBJECT_KEK_UNAVAILABLE/, "bad key maps/versions never fall back to message keys or leak input");
}
for (const overrides of [{ privateBucket: false }, { bucket: "" }, { privateBaseUrl: "http://private.invalid" }, { uploadUrl: "https://user:secret@upload.invalid" }]) {
  assert.throws(() => validateCollaborationObjectConfig({ ...settings, collaborationObjectStorage: { ...settings.collaborationObjectStorage, ...overrides } }), /COLLAB_OBJECT_STORE_UNAVAILABLE/);
}
assert.throws(() => validateCollaborationObjectConfig({ ...settings, qiniuBucket: "private-bucket" }), /COLLAB_OBJECT_STORE_UNAVAILABLE/, "an explicitly configured public artifact bucket still cannot be reused");
assert.throws(() => validateCollaborationObjectConfig({ ...settings, qiniuPublicBaseUrl: "https://private.invalid/releases" }), /COLLAB_OBJECT_STORE_UNAVAILABLE/);
await assert.rejects(createConfiguredCollaborationObjectService({ database, config: settings }).init({}), (error) => error.code === "COLLAB_OBJECT_SHARING_DISABLED");
// Import the actual config in a fresh cwd and an explicit synthetic environment:
// dotenv cannot read repository/operator secrets during this guard test.
const configCwd = mkdtempSync(join(tmpdir(), "collaboration-object-config-"));
try {
  const source = `import {config,assertProductionSecrets} from ${JSON.stringify(new URL("../server/src/config.js", import.meta.url).href)}; try {assertProductionSecrets(); console.log('CONFIG_OK')} catch {console.log('CONFIG_REFUSED')}`;
  const baseEnv = { NODE_ENV: "production", SESSION_SECRET: "synthetic-session-secret", MODEL_GATEWAY_TOKEN_SECRET: "synthetic-gateway-secret", COLLABORATION_ENABLED: "true", COLLAB_MESSAGE_KEK: "ab".repeat(32) };
  const run = (extra) => { const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: configCwd, env: { ...baseEnv, ...extra }, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim().split("\n").at(-1); };
  assert.equal(run({}), "CONFIG_OK", "a production text-only server needs no object keys/storage");
  assert.equal(run({ COLLABORATION_ATTACHMENTS_ENABLED: "true" }), "CONFIG_REFUSED");
  assert.equal(run({ ...env, COLLABORATION_ATTACHMENTS_ENABLED: "true" }), "CONFIG_OK");
  assert.equal(run({ ...env, COLLABORATION_WORKSPACE_SHARES_ENABLED: "true", COLLAB_OBJECT_KEKS: "invalid-secret-sentinel" }), "CONFIG_REFUSED");
} finally { rmdirSync(configCwd); }
console.log("collaboration object config: private-only, versioned keys, invalid config and optional gating passed");
