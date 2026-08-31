import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createCollaborationClient } = require("../../src/main/collaboration/client");
const { createTransferManager } = require("../../src/main/collaboration/transfer-manager");
const { createTransferManifestStore } = require("../../src/main/collaboration/transfer-manifest");
const { LocalCollaborationKeyring } = require("../../src/main/collaboration/local-keyring");
const { createQiniuMultipartTransport } = require("../../src/main/collaboration/multipart-transport");

/** Real desktop client/crypto/disk -> signed Fastify routes -> real PostgreSQL.
 * Only the external object-storage provider is simulated; no domain stubs.
 */
export async function verifyTransferHttp({ app, keys, createAccessToken, stableStringify, sha256, uploaded, sensitive, conversationId, dropAck, pool }) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "collab-transfer-http-")));
  const source = path.join(directory, "handoff.txt"); fs.writeFileSync(source, Buffer.alloc(4 * 1024 ** 2 + 123, 71));
  const sessions = new Map(), puts = [];
  let providerLost = false, downloadLost = false, expired = false, starts = 0;
  const downloads = [];
  const failBody = (bytes) => { let step = 0; return new ReadableStream({ pull(controller) {
    if (bytes && step++ === 0) controller.enqueue(bytes.subarray(0, 1024)); else controller.error(new Error("simulated connection reset"));
  } }, { highWaterMark: 0 }); };
  const fetchImpl = async (url, options) => {
    const target = new URL(url);
    assert.equal(options.redirect, "error");
    if (target.hostname === "private.invalid") {
      sensitive.add(url);
      const row = uploaded.get(target.pathname.slice(1)); assert.ok(row?.bytes);
      if (expired) { expired = false; return new Response(null, { status: 403 }); }
      const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.range); assert.ok(match);
      const start = Number(match[1]), end = Number(match[2]); downloads.push(start);
      const bytes = row.bytes.subarray(start, end + 1);
      const headers = { "content-range": `bytes ${start}-${end}/${row.bytes.length}`, "content-length": String(bytes.length) };
      if (downloadLost) { downloadLost = false; return new Response(failBody(bytes), { status: 206, headers }); }
      return new Response(bytes, { status: 206, headers });
    }
    assert.equal(target.hostname, "upload.invalid");
    const match = /^\/buckets\/test-private-bucket\/objects\/([^/]+)\/uploads(?:\/([^/]+))?(?:\/(\d+))?$/.exec(target.pathname); assert.ok(match);
    const key = Buffer.from(match[1], "base64url").toString();
    const credential = options.headers.authorization.slice("UpToken ".length); sensitive.add(credential);
    const policy = JSON.parse(Buffer.from(credential.split(":")[2], "base64url"));
    assert.equal(policy.scope, `test-private-bucket:${key}`); assert.equal(policy.insertOnly, 1);
    const uploadId = match[2], number = Number(match[3]);
    if (!uploadId) { starts++; const id = crypto.randomUUID(); sessions.set(id, { key, parts: new Map() }); return Response.json({ uploadId: id, expireAt: 2_000_000_000 }); }
    const session = sessions.get(uploadId);
    if (!session) return new Response(null, { status: 404 });
    assert.equal(session.key, key);
    if (options.method === "PUT") {
      const bytes = Buffer.from(options.body); puts.push(number); session.parts.set(number, bytes);
      const md5 = crypto.createHash("md5").update(bytes).digest("hex"); assert.equal(options.headers["content-md5"], md5);
      return Response.json({ etag: `part-${number}`, md5 });
    }
    if (options.method === "GET") return Response.json({ uploadId, expireAt: 2_000_000_000, partNumberMarker: 0,
      parts: [...session.parts].map(([partNumber, bytes]) => ({ partNumber, etag: `part-${partNumber}`, size: bytes.length })) });
    const body = JSON.parse(options.body);
    assert.equal(body.mimeType, "application/octet-stream");
    const bytes = Buffer.concat(body.parts.map(({ partNumber }) => session.parts.get(partNumber)));
    assert.equal(bytes.length, policy.fsizeMin); assert.equal(bytes.length, policy.fsizeLimit);
    uploaded.set(key, { bytes, size: bytes.length, hash: crypto.createHash("sha256").update(bytes).digest("hex") });
    sessions.delete(uploadId);
    if (providerLost) { providerLost = false; return new Response(failBody()); }
    return Response.json({ key, hash: "fake-etag" });
  };
  function desktop(userId) {
    const deviceId = `device-${userId}`;
    const client = createCollaborationClient({ expectedAccountId: userId,
      accountManager: { accountStatus: () => ({ loggedIn: true, user: { id: userId } }), accessTokenForService: async () => {
        const token = createAccessToken({ userId, deviceId, sessionId: `session-${userId}` }); sensitive.add(token); return { ok: true, accessToken: token };
      } },
      signDeviceRequest: async ({ path: pathname, method, body }) => {
        const timestamp = new Date().toISOString(), nonce = crypto.randomUUID(), bodyHash = sha256(stableStringify(body));
        const signature = crypto.sign(null, Buffer.from(stableStringify({ method, pathname, timestamp, nonce, bodyHash })), keys.get(userId).privateKey).toString("base64url");
        return { "x-lily-device-id": deviceId, "x-lily-timestamp": timestamp, "x-lily-nonce": nonce, "x-lily-body-sha256": bodyHash, "x-lily-signature": signature };
      },
      request: async ({ path: url, method, body, headers }) => {
        const response = await app.inject({ method, url, payload: body, headers }), json = response.json();
        if (json.result?.dek) sensitive.add(json.result.dek);
        return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json };
      },
    });
    const keyring = new LocalCollaborationKeyring({ filePath: path.join(directory, `${userId}-keys`), safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() } });
    const manifests = createTransferManifestStore({ rootPath: path.join(directory, "collaboration-transfer"), accountId: userId, keyring });
    const manager = () => createTransferManager({ manifests, objectClient: client.objects, multipart: createQiniuMultipartTransport({ fetchImpl }), deviceId, assertAuthorized: () => {}, fetchImpl });
    return { client, manifests, manager, deviceId };
  }
  try {
    const sender = desktop("a"); let sending = sender.manager();
    const prepared = await sending.prepareUpload({ inputPath: source, conversationId, scopeId: "team:org", purpose: "attachment", mimeType: "text/plain", originalName: "handoff.txt" });
    dropAck("/api/collaboration/v1/objects/init");
    assert.equal((await sending.resumeUpload(prepared.id)).state, "paused"); sending.stop(); sending = sender.manager();
    providerLost = true;
    assert.equal((await sending.resumeUpload(prepared.id)).state, "paused"); sending.stop(); sending = sender.manager();
    const journal = sender.manifests.read(prepared.id);
    dropAck(`/api/collaboration/v1/objects/${journal.checkpoint.objectId}/complete`);
    assert.equal((await sending.resumeUpload(prepared.id)).state, "paused"); sending.stop(); sending = sender.manager();
    assert.equal((await sending.resumeUpload(prepared.id)).state, "verified");
    assert.equal(starts, 1); assert.deepEqual(puts, [1, 2]);
    for (const action of ["init", "complete"]) assert.equal((await pool.query("select count(*)::int n from command_receipts where client_command_id=$1", [journal.commandIds[action]])).rows[0].n, 1);
    const message = await sender.client.submitMessage({ action: "send", deviceId: sender.deviceId, clientCommandId: journal.commandIds.send, conversationId, attachmentIds: [journal.checkpoint.objectId], attachmentPurpose: "attachment" });
    assert.ok(message.result.message.id);
    const recipient = desktop("b"); let receiving = recipient.manager();
    const inbound = receiving.prepareDownload({ objectId: journal.checkpoint.objectId, conversationId, scopeId: "team:org", purpose: "attachment" });
    expired = true; downloadLost = true;
    assert.equal((await receiving.resumeDownload(inbound.id)).state, "paused"); receiving.stop(); receiving = recipient.manager();
    assert.equal((await receiving.resumeDownload(inbound.id)).state, "ready");
    assert.deepEqual(downloads.slice(0, 2), [0, 1024]);
    assert.deepEqual(fs.readFileSync(await receiving.verifiedFile(inbound.id)), fs.readFileSync(source));
    sending.stop(); receiving.stop(); sender.client.stop(); recipient.client.stop();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
