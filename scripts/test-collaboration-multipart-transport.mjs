import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { createPrivateQiniuObjectStore } from "../server/src/services/collaboration/object-store.js";
const require = createRequire(import.meta.url);
let createQiniuMultipartTransport;
try { ({ createQiniuMultipartTransport } = require("../src/main/collaboration/multipart-transport")); } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
const ticket = { bucket: "private-bucket", objectKey: `collaboration/${"a".repeat(64)}`, token: "synthetic-token", uploadUrl: "https://upload.invalid" };
function transport(fetchImpl) { assert.equal(typeof createQiniuMultipartTransport, "function"); return createQiniuMultipartTransport({ fetchImpl }); }

test("multipart protocol binds all operations to the exact bucket/key and fresh supplied token", async () => {
  const calls = [];
  const api = transport(async (url, options) => {
    calls.push({ url, ...options });
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    assert.equal(options.headers.authorization, `UpToken ${ticket.token}`);
    if (url.endsWith("/uploads")) return Response.json({ uploadId: "upload_123", expireAt: 2_000_000_000 });
    if (options.method === "PUT") return Response.json({ etag: "etag_1", md5: crypto.createHash("md5").update(options.body).digest("hex") });
    if (options.method === "GET") return Response.json({ uploadId: "upload_123", expireAt: 2_000_000_000, partNumberMarker: 0, parts: [{ partNumber: 1, etag: "etag_1", size: 3, putTime: 1 }] });
    if (options.method === "DELETE") return new Response(null, { status: 200 });
    return Response.json({ key: ticket.objectKey, hash: "final-etag" });
  });
  const session = await api.initiate({ ticket }); assert.equal(session.uploadId, "upload_123");
  assert.deepEqual(await api.uploadPart({ ticket, uploadId: session.uploadId, partNumber: 1, bytes: Buffer.from("abc") }), { partNumber: 1, etag: "etag_1" });
  assert.deepEqual((await api.listParts({ ticket, uploadId: session.uploadId })).parts, [{ partNumber: 1, etag: "etag_1", size: 3 }]);
  assert.deepEqual(await api.complete({ ticket, uploadId: session.uploadId, parts: [{ partNumber: 1, etag: "etag_1" }] }), { etag: "final-etag" });
  await api.abort({ ticket, uploadId: session.uploadId });
  const encoded = Buffer.from(ticket.objectKey).toString("base64").replaceAll("+", "-").replaceAll("/", "_");
  for (const call of calls) assert.ok(call.url.startsWith(`${ticket.uploadUrl}/buckets/private-bucket/objects/${encoded}/uploads`));
  assert.equal(calls[1].headers["content-md5"], crypto.createHash("md5").update("abc").digest("hex"));
  assert.equal(JSON.parse(calls[3].body).mimeType, "application/octet-stream");
  assert.deepEqual(JSON.parse(calls[3].body).parts, [{ partNumber: 1, etag: "etag_1" }]);
});

test("invalid identity and excessive chunks fail before network access", async () => {
  let requests = 0;
  const api = transport(async () => { requests++; return Response.json({}); });
  for (const changed of [{ ...ticket, uploadUrl: "http://upload.invalid" }, { ...ticket, uploadUrl: "https://user:secret@upload.invalid" }, { ...ticket, objectKey: "../escape" }, { ...ticket, bucket: "../../other" }, { ...ticket, token: "bad\nheader" }]) await assert.rejects(api.initiate({ ticket: changed }), { code: "COLLAB_TRANSFER_INPUT_INVALID" });
  for (const partNumber of [0, 1.5, 10001]) await assert.rejects(api.uploadPart({ ticket, uploadId: "session", partNumber, bytes: Buffer.from("a") }), { code: "COLLAB_TRANSFER_INPUT_INVALID" });
  await assert.rejects(api.uploadPart({ ticket, uploadId: "session", partNumber: 1, bytes: Buffer.alloc(4 * 1024 ** 2 + 1) }), { code: "COLLAB_TRANSFER_INPUT_INVALID" });
  await assert.rejects(api.complete({ ticket, uploadId: "session", parts: [{ partNumber: 2, etag: "b" }, { partNumber: 1, etag: "a" }] }), { code: "COLLAB_TRANSFER_INPUT_INVALID" });
  assert.equal(requests, 0);
});

test("network and HTTP errors are bounded coded outcomes with no provider credentials", async () => {
  for (const [status, retryable] of [[401, false], [403, false], [404, false], [408, true], [429, true], [500, true], [614, false]]) {
    const api = transport(async () => ({ status, ok: false, body: { cancel: async () => {} } }));
    await assert.rejects(api.initiate({ ticket }), (error) => error.retryable === retryable && !error.message.includes(ticket.token));
  }
  await assert.rejects(transport(async () => { throw new Error(`https://upload.invalid/?token=${ticket.token}`); }).initiate({ ticket }), { code: "COLLAB_TRANSFER_RESPONSE_UNKNOWN", retryable: true });
});

test("malformed, excessive, mismatched or nonadvancing server projections are rejected", async () => {
  for (const value of [{ uploadId: "../escape", expireAt: 100 }, { uploadId: "session", expireAt: "bad" }, { data: "x".repeat(1024 * 1024) }]) await assert.rejects(transport(async () => Response.json(value)).initiate({ ticket }), { code: "COLLAB_TRANSFER_RESPONSE_INVALID" });
  for (const value of [
    { uploadId: "other", expireAt: 2_000_000_000, partNumberMarker: 0, parts: [] },
    { uploadId: "session", expireAt: 2_000_000_000, partNumberMarker: 1, parts: [] },
    { uploadId: "session", expireAt: 2_000_000_000, partNumberMarker: 0, parts: [{ partNumber: 2, etag: "b", size: 1 }, { partNumber: 1, etag: "a", size: 1 }] },
  ]) await assert.rejects(transport(async () => Response.json(value)).listParts({ ticket, uploadId: "session", marker: 1 }), { code: "COLLAB_TRANSFER_RESPONSE_INVALID" });
  await assert.rejects(transport(async () => Response.json({ key: "other-object", hash: "etag" })).complete({ ticket, uploadId: "session", parts: [{ partNumber: 1, etag: "etag" }] }), { code: "COLLAB_TRANSFER_RESPONSE_INVALID" });
});

test("real server ticket supplies the bound multipart bucket and rejects missing session identities", async () => {
  const store = createPrivateQiniuObjectStore({ config: { accessKey: "ak", secretKey: "sk", bucket: "private-bucket", privateBucket: true, privateBaseUrl: "https://private.invalid", uploadUrl: ticket.uploadUrl } });
  const issued = store.createUploadTicket({ objectKey: ticket.objectKey, ciphertextSize: 3 });
  assert.equal(issued.bucket, ticket.bucket);
  let calls = 0;
  const api = transport(async (url) => { calls++; assert.ok(url.includes("/buckets/private-bucket/")); return Response.json({ uploadId: "session", expireAt: 2_000_000_000 }); });
  await api.initiate({ ticket: issued });
  for (const bucket of [undefined, 123]) await assert.rejects(api.initiate({ ticket: { ...ticket, bucket } }), { code: "COLLAB_TRANSFER_INPUT_INVALID" });
  for (const action of ["uploadPart", "listParts", "complete", "abort"]) await assert.rejects(api[action]({ ticket, partNumber: 1, bytes: Buffer.from("a"), parts: [{ partNumber: 1, etag: "e" }] }), { code: "COLLAB_TRANSFER_INPUT_INVALID" });
  assert.equal(calls, 1);
});

test("a dropped completion response after success headers remains an unknown outcome", async () => {
  const api = transport(async () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError(`terminated ${ticket.token}`)); } })));
  await assert.rejects(api.complete({ ticket, uploadId: "session", parts: [{ partNumber: 1, etag: "e" }] }), (error) => error.code === "COLLAB_TRANSFER_RESPONSE_UNKNOWN" && error.retryable === true && !error.message.includes(ticket.token));
});
