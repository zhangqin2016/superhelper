#!/usr/bin/env node
import assert from "node:assert/strict";
import { createCollaborationObjectKeyBroker } from "../server/src/services/collaboration/object-key-broker.js";
import { createPrivateQiniuObjectStore } from "../server/src/services/collaboration/object-store.js";
import { canTransitionObject, normalizeObjectInput } from "../server/src/services/collaboration/objects.js";

const context = { objectId: "obj-a", ownerUserId: "user-a", conversationId: "conv-a", scopeType: "organization", organizationId: "org-a", purpose: "attachment" };
const key = Buffer.alloc(32, 7); const dek = Buffer.alloc(32, 9);
const broker = createCollaborationObjectKeyBroker({ currentKekVersion: 1, kekByVersion: { 1: key } });
const envelope = broker.wrap({ dek, ...context });
assert.equal(envelope.kekVersion, 1);
assert.equal(Buffer.from(envelope.wrappedDek).includes(dek), false);
assert.deepEqual(broker.unwrap({ ...context, ...envelope }), dek);
for (const field of ["objectId", "ownerUserId", "conversationId", "organizationId", "purpose", "scopeType"]) {
  assert.throws(() => broker.unwrap({ ...context, ...envelope, [field]: "different" }), /COLLAB_OBJECT_KEY_INVALID/);
}
const rotated = createCollaborationObjectKeyBroker({ currentKekVersion: 2, kekByVersion: { 1: key, 2: Buffer.alloc(32, 6) } });
assert.deepEqual(rotated.unwrap({ ...context, ...envelope }), dek);
assert.equal(rotated.wrap({ ...context, dek }).kekVersion, 2);
assert.throws(() => createCollaborationObjectKeyBroker({ currentKekVersion: 3, kekByVersion: {} }), /COLLAB_OBJECT_KEK_UNAVAILABLE/);
assert.throws(() => broker.wrap({ ...context, dek: Buffer.alloc(31) }), /COLLAB_OBJECT_KEY_INVALID/);
const corrupt = { ...envelope, wrappedDek: Buffer.from(envelope.wrappedDek) }; corrupt.wrappedDek[20] ^= 1;
assert.throws(() => broker.unwrap({ ...context, ...corrupt }), /COLLAB_OBJECT_KEY_INVALID/);

const transitions = ["initiated", "uploading", "uploaded", "verified", "bound"];
for (let i = 0; i < transitions.length - 1; i++) assert.equal(canTransitionObject(transitions[i], transitions[i + 1]), true);
for (const pair of [["initiated", "bound"], ["verified", "uploading"], ["bound", "aborted"], ["revoked", "bound"], ["deleted", "verified"]]) assert.equal(canTransitionObject(...pair), false);
assert.equal(canTransitionObject("bound", "revoked"), true);
const metadata = { conversationId: "conv-a", purpose: "attachment", ciphertextSize: 100, ciphertextSha256: "a".repeat(64), mimeType: "text/plain", originalName: "notes.txt" };
assert.equal(normalizeObjectInput(metadata).ciphertextSize, 100);
assert.throws(() => normalizeObjectInput({ ...metadata, ciphertextSize: 1024 ** 3 + 1 }), /COLLAB_OBJECT_SIZE_INVALID/);
assert.equal(normalizeObjectInput({ ...metadata, purpose: "workspace", ciphertextSize: 256 * 1024 ** 2 }).ciphertextSize, 256 * 1024 ** 2);
for (const ciphertextSize of [256 * 1024 ** 2 + 1, 1024 ** 3]) assert.throws(() => normalizeObjectInput({ ...metadata, purpose: "workspace", ciphertextSize }), /COLLAB_OBJECT_SIZE_INVALID/);
assert.throws(() => normalizeObjectInput({ ...metadata, ciphertextSha256: "bad" }), /COLLAB_OBJECT_METADATA_INVALID/);
assert.throws(() => normalizeObjectInput({ ...metadata, originalName: "../private.txt" }), /COLLAB_OBJECT_METADATA_INVALID/);

const now = () => 1_800_000_000_000;
const config = { accessKey: "test-ak", secretKey: "test-sk", bucket: "collab-private", privateBaseUrl: "https://private.invalid", uploadUrl: "https://upload.invalid", privateBucket: true };
assert.throws(() => createPrivateQiniuObjectStore({ config: { ...config, privateBaseUrl: undefined, publicBaseUrl: "https://public.invalid" } }), /COLLAB_OBJECT_STORE_UNAVAILABLE/);
assert.throws(() => createPrivateQiniuObjectStore({ config: { ...config, privateBucket: false } }), /COLLAB_OBJECT_STORE_UNAVAILABLE/);
let calls = [];
const store = createPrivateQiniuObjectStore({ config, now, fetchImpl: async (url, options) => {
  calls.push({ url, options });
  return options.method === "HEAD" ? new Response(null, { status: 200, headers: { "content-length": "100", etag: '"etag-a"', "content-type": "application/octet-stream" } }) : new Response(JSON.stringify({ hash: "a".repeat(64), fsize: 100 }), { status: 200 });
} });
const objectKey = store.createObjectKey();
assert.match(objectKey, /^collaboration\/[0-9a-f]{64}$/);
const upload = store.createUploadTicket({ objectKey, ciphertextSize: 100, ttlSeconds: 99999 });
assert.equal(upload.publicUrl, undefined);
const policy = JSON.parse(Buffer.from(upload.token.split(":")[2], "base64url"));
assert.equal(policy.scope, `collab-private:${objectKey}`);
assert.equal(policy.fsizeMin, 100); assert.equal(policy.fsizeLimit, 100);
assert.equal(policy.insertOnly, 1); assert.equal(policy.mimeLimit, "application/octet-stream");
assert.ok(policy.deadline <= now() / 1000 + 900);
const ticket = store.createDownloadTicket({ objectKey, ttlSeconds: 99999 });
assert.ok(Number(new URL(ticket.url).searchParams.get("e")) <= now() / 1000 + 300);
assert.ok(new URL(ticket.url).searchParams.get("token"));
assert.throws(() => store.createDownloadTicket({ objectKey: "../outside" }), /COLLAB_OBJECT_KEY_INVALID/);
const head = await store.head({ objectKey });
assert.deepEqual(head, { objectKey, ciphertextSize: 100, ciphertextSha256: "a".repeat(64), etag: "etag-a", mimeType: "application/octet-stream" });
assert.equal(calls[0].options.redirect, "error");
assert.equal(calls[0].options.method, "HEAD");
assert.ok(calls.some((call) => call.url.includes("qhash/sha256")), "hash is calculated by Qiniu, not trusted from uploader metadata");
const failingStore = createPrivateQiniuObjectStore({ config, now, fetchImpl: async () => { throw new Error("do not expose https://secret.invalid/token=secret"); } });
await assert.rejects(failingStore.head({ objectKey }), (error) => error.code === "COLLAB_OBJECT_STORE_UNAVAILABLE" && !error.message.includes("secret"));
console.log("collaboration objects: key wrapping, AAD, rotation, state machine, limits, private token and HEAD verification passed");
