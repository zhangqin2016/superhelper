import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateQiniuObjectStore } from "../server/src/services/collaboration/object-store.js";
import { inspectObjectRecovery } from "../server/src/services/collaboration/object-recovery.js";
const config = { accessKey: "ak", secretKey: "sk", bucket: "private-bucket", privateBucket: true, privateBaseUrl: "https://private.invalid", uploadUrl: "https://upload.invalid" };
const objectKey = `collaboration/${"a".repeat(64)}`;

test("recovery distinguishes a proven absent ciphertext from an unreachable provider", async () => {
  const absent = createPrivateQiniuObjectStore({ config, fetchImpl: async () => new Response(null, { status: 404 }) });
  assert.equal(typeof absent.probe, "function");
  assert.equal(await absent.probe({ objectKey }), null);
  // Existing completion must still reject absent objects, never accept null HEAD.
  await assert.rejects(absent.head({ objectKey }), { code: "COLLAB_OBJECT_STORE_UNAVAILABLE" });
  for (const status of [401, 403, 408, 429, 500]) {
    const store = createPrivateQiniuObjectStore({ config, fetchImpl: async () => new Response(null, { status }) });
    await assert.rejects(store.probe({ objectKey }), { code: "COLLAB_OBJECT_STORE_UNAVAILABLE", retryable: true });
  }
});

test("recovery reads the same independently verified metadata as completion", async () => {
  const store = createPrivateQiniuObjectStore({ config, fetchImpl: async (_url, options) => options.method === "HEAD"
    ? new Response(null, { headers: { "content-length": "100", etag: "etag", "content-type": "application/octet-stream" } })
    : Response.json({ hash: "b".repeat(64), fsize: 100 }) });
  assert.equal(typeof store.probe, "function");
  assert.deepEqual(await store.probe({ objectKey }), await store.head({ objectKey }));
});

test("time spent probing cannot extend credentials beyond object expiry", async () => {
  let clock = 1000000;
  let issued = false;
  const object = { id: "obj", state: "uploading", ciphertext_size: 100, ciphertext_sha256: "a".repeat(64), orphan_expires_at: new Date(clock + 1000), object_key: objectKey };
  const repository = { withTransaction: (fn) => fn({}), authorizeObject: async () => ({ ok: true, object }) };
  const objectStore = { probe: async () => { clock += 2000; return null; }, createUploadTicket: () => { issued = true; return {}; } };
  await assert.rejects(inspectObjectRecovery({ repository, objectStore, account: {}, objectId: "obj", now: () => clock }), { code: "COLLAB_OBJECT_UNAVAILABLE" });
  assert.equal(issued, false);
});

test("expired unbound verified objects cannot be recovered as usable attachments", async () => {
  const object = { state: "verified", ciphertext_size: 100, ciphertext_sha256: "a".repeat(64), orphan_expires_at: new Date(0), provider_etag: "etag" };
  const repository = { withTransaction: (fn) => fn({}), authorizeObject: async () => ({ ok: true, object }) };
  await assert.rejects(inspectObjectRecovery({ repository, account: {}, objectId: "obj", now: () => 100000 }), { code: "COLLAB_OBJECT_UNAVAILABLE" });
  object.state = "bound";
  assert.equal((await inspectObjectRecovery({ repository, account: {}, objectId: "obj", now: () => 100000 })).state, "bound", "binding ends the orphan deadline, not the actual object expiration policy");
});
