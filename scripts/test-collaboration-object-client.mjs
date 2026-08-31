import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createCollaborationClient } = require("../src/main/collaboration/client");
function fixture() {
  const calls = [], signed = [];
  let current = "alice", hold;
  const key = Buffer.alloc(32, 7).toString("base64");
  const client = createCollaborationClient({ expectedAccountId: "alice",
    accountManager: { accountStatus: () => ({ loggedIn: true, user: { id: current } }), accessTokenForService: async () => ({ ok: true, accessToken: "main-only-token" }) },
    signDeviceRequest: async (input) => { signed.push(input); return { "x-lily-signature": "signed" }; },
    request: async (input) => { calls.push(input); if (hold) await hold;
      return { ok: true, status: 200, json: { ok: true, result: input.path.endsWith("download-ticket") ? { objectId: "obj", dek: key, url: "https://private.invalid/?token=secret" } : { objectId: "obj", state: "uploading" } } }; },
  });
  return { client, calls, signed, key, account: (value) => { current = value; }, hold: (value) => { hold = value; } };
}
test("object operations reuse the real signed account-bound client with immutable command IDs", async () => {
  const f = fixture(); assert.ok(f.client.objects);
  const init = { deviceId: "device", clientCommandId: "stable-init", conversationId: "c", purpose: "attachment", dek: f.key, ciphertextSize: 100, ciphertextSha256: "a".repeat(64), originalName: "a.txt", mimeType: "text/plain" };
  await f.client.objects.init(init); await f.client.objects.init(init);
  assert.deepEqual(f.calls[0].body, init); assert.deepEqual(f.calls[1].body, init);
  for (const method of ["status", "complete", "abort", "revoke", "downloadTicket"]) await f.client.objects[method]({ deviceId: "device", clientCommandId: `stable-${method}`, objectId: "obj", ...(method === "complete" ? { etag: "etag", ciphertextSize: 100, ciphertextSha256: "a".repeat(64) } : {}) });
  assert.equal(f.calls.at(-1).path, "/api/collaboration/v1/objects/obj/download-ticket");
  for (const call of f.calls) { assert.equal(call.headers.authorization, "Bearer main-only-token"); assert.equal(call.headers["x-lily-signature"], "signed"); assert.equal(call.body.objectId, undefined); }
  assert.deepEqual(f.signed.map((s) => s.body), f.calls.map((s) => s.body));
});
test("object paths reject traversal without transport and account switches fence late keys", async () => {
  const f = fixture(); assert.ok(f.client.objects);
  await assert.rejects(f.client.objects.status({ objectId: "../other", deviceId: "d", clientCommandId: "cmd" }), { code: "COLLAB_OBJECT_METADATA_INVALID" });
  assert.equal(f.calls.length, 0);
  let release; f.hold(new Promise((resolve) => { release = resolve; }));
  const pending = f.client.objects.downloadTicket({ objectId: "obj", deviceId: "d", clientCommandId: "cmd" });
  while (!f.calls.length) await new Promise((resolve) => setImmediate(resolve));
  f.account("bob"); release();
  await assert.rejects(pending, { code: "COLLAB_ACCOUNT_CHANGED" });
});
