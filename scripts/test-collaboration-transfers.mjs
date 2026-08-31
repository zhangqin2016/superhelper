import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createTransferManifestStore } = require("../src/main/collaboration/transfer-manifest");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring");
const { decryptFile } = require("../src/main/collaboration/encrypted-container");
let createTransferManager;
try { ({ createTransferManager } = require("../src/main/collaboration/transfer-manager")); } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
const unknown = () => Object.assign(new Error("secret URL must not escape"), { code: "COLLAB_RESPONSE_UNKNOWN", retryable: true });
function fixture(t) {
  assert.equal(typeof createTransferManager, "function", "a recoverable main-only transfer manager is required");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "collab-manager-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source.txt"); fs.writeFileSync(source, Buffer.alloc(4 * 1024 ** 2 + 21, 42));
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys"), safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() } });
  const manifests = createTransferManifestStore({ rootPath: path.join(dir, "collaboration-transfer"), accountId: "alice", keyring });
  const remote = { initCalls: [], completeCalls: [], parts: new Map(), uploads: 0, puts: [], state: "uploading", drop: "", authorized: true, ciphertext: null };
  const ticket = { bucket: "test", objectKey: `collaboration/${"a".repeat(64)}`, token: "UPLOAD_SECRET", uploadUrl: "https://upload.invalid" };
  const objectClient = {
    async init(input) {
      remote.initCalls.push(input);
      if (remote.metadata) assert.deepEqual(input, remote.metadata, "init recovery retains the same immutable intent and DEK");
      remote.metadata = input;
      if (remote.drop === "init") { remote.drop = ""; throw unknown(); }
      return { objectId: "obj", state: "uploading", upload: ticket };
    },
    async status() {
      if (!remote.authorized) throw Object.assign(new Error("revoked"), { code: "COLLAB_OBJECT_UNAVAILABLE" });
      return { objectId: "obj", state: remote.state, ciphertextSize: remote.metadata.ciphertextSize, ciphertextSha256: remote.metadata.ciphertextSha256,
        etag: remote.ciphertext ? "object-etag" : null, upload: ticket, provider: remote.ciphertext ? { state: "present", etag: "object-etag" } : { state: "missing" } };
    },
    async complete(input) {
      remote.completeCalls.push(input);
      assert.equal(crypto.createHash("sha256").update(remote.ciphertext).digest("hex"), input.ciphertextSha256);
      assert.equal(remote.ciphertext.length, input.ciphertextSize);
      remote.state = "verified";
      if (remote.drop === "complete") { remote.drop = ""; throw unknown(); }
      return { objectId: "obj", state: "verified" };
    },
    async abort() { remote.state = "aborted"; return { objectId: "obj", state: "aborted" }; },
  };
  const multipart = {
    async initiate() { remote.uploads++; return { uploadId: "upload", expireAt: 2_000_000_000 }; },
    async listParts() { return { uploadId: "upload", marker: 0, expireAt: 2_000_000_000, parts: [...remote.parts].map(([partNumber, bytes]) => ({ partNumber, etag: `etag-${partNumber}`, size: bytes.length })) }; },
    async uploadPart({ partNumber, bytes }) {
      remote.puts.push(partNumber); remote.parts.set(partNumber, Buffer.from(bytes));
      if (remote.drop === "part") { remote.drop = ""; throw unknown(); }
      return { partNumber, etag: `etag-${partNumber}` };
    },
    async complete({ parts }) {
      remote.ciphertext = Buffer.concat(parts.map(({ partNumber }) => remote.parts.get(partNumber)));
      if (remote.drop === "providerComplete") { remote.drop = ""; throw unknown(); }
      return { etag: "object-etag" };
    },
  };
  const options = { manifests, objectClient, multipart, deviceId: "device", assertAuthorized: () => {
    if (!remote.authorized) throw Object.assign(new Error("revoked"), { code: "COLLAB_ACCESS_REVOKED" });
  } };
  const manager = () => createTransferManager(options);
  const prepare = (api) => api.prepareUpload({ inputPath: source, conversationId: "conversation", scopeId: "team:org", purpose: "attachment", originalName: "source.txt", mimeType: "text/plain" });
  return { dir, source, keyring, manifests, remote, objectClient, multipart, options, manager, prepare };
}

test("encrypt/upload/verify retains bounded parts, private credentials and authentic plaintext", async (t) => {
  const f = fixture(t), api = f.manager(), prepared = await f.prepare(api);
  assert.equal(prepared.state, "prepared");
  assert.equal(f.remote.initCalls.length, 0, "preparing never silently sends or uploads");
  const result = await api.resumeUpload(prepared.id);
  assert.equal(result.state, "verified"); assert.equal(result.objectId, "obj");
  assert.deepEqual(f.remote.puts, [1, 2]);
  assert.ok([...f.remote.parts.values()].every((part) => part.length <= 4 * 1024 ** 2));
  for (const view of [prepared, result, ...api.list().transfers]) assert.doesNotMatch(JSON.stringify(view), /UPLOAD_SECRET|dek|sourcePath|inputPath|ciphertextSha256/);
  const output = path.join(f.dir, "restored.txt"), ciphertext = path.join(f.dir, "received.lilyenc");
  fs.writeFileSync(ciphertext, f.remote.ciphertext);
  await decryptFile({ inputPath: ciphertext, outputPath: output, key: Buffer.from(f.remote.metadata.dek, "base64") });
  assert.deepEqual(fs.readFileSync(output), fs.readFileSync(f.source));
});

for (const point of ["init", "part", "providerComplete", "complete"]) test(`restart after ${point} response loss preserves identity and committed progress`, async (t) => {
  const f = fixture(t), first = f.manager(), prepared = await f.prepare(first);
  const ids = f.manifests.read(prepared.id).commandIds;
  f.remote.drop = point;
  const interrupted = await first.resumeUpload(prepared.id);
  assert.equal(interrupted.state, "paused"); assert.equal(interrupted.retryable, true);
  first.stop();
  const second = f.manager(), result = await second.resumeUpload(prepared.id);
  assert.equal(result.state, "verified");
  assert.deepEqual(f.manifests.read(prepared.id).commandIds, ids);
  assert.ok(f.remote.initCalls.every((call) => call.clientCommandId === ids.init));
  assert.ok(f.remote.completeCalls.every((call) => call.clientCommandId === ids.complete));
  assert.equal(f.remote.uploads, 1, "recovery does not create an unnecessary second upload session");
  assert.deepEqual(f.remote.puts, [1, 2], "provider-confirmed parts are not uploaded twice after losing their ACK");
});

test("a changed staged ciphertext fails before any upload and never becomes verified", async (t) => {
  const f = fixture(t), api = f.manager(), prepared = await f.prepare(api);
  fs.appendFileSync(path.join(f.manifests.directory(prepared.id), "ciphertext.lilyenc"), "tampered");
  const result = await api.resumeUpload(prepared.id);
  assert.equal(result.ok, false); assert.equal(result.code, "COLLAB_TRANSFER_INTEGRITY_FAILED");
  assert.equal(f.remote.initCalls.length, 0);
});

test("a changed device cannot replay an unknown upload under a new receipt identity", async (t) => {
  const f = fixture(t), first = f.manager(), prepared = await f.prepare(first);
  f.remote.drop = "init";
  assert.equal((await first.resumeUpload(prepared.id)).state, "paused");
  first.stop();
  const before = f.manifests.read(prepared.id);
  f.options.deviceId = "replacement-device";
  const second = f.manager(), result = await second.resumeUpload(prepared.id);
  assert.equal(result.code, "COLLAB_TRANSFER_DEVICE_CHANGED");
  assert.equal(f.remote.initCalls.length, 1, "the second device must not dispatch the original init identity");
  assert.deepEqual(f.manifests.read(prepared.id), before, "identity mismatch preserves the original recovery evidence");
  assert.equal(second.list().transfers[0].code, "COLLAB_TRANSFER_DEVICE_CHANGED");
});

test("legacy upload without a device identity remains inspectable but cannot be adopted", async (t) => {
  const f = fixture(t), first = f.manager(), prepared = await f.prepare(first);
  const item = f.manifests.read(prepared.id), { deviceId: _device, ...legacy } = item.checkpoint;
  f.manifests.update({ id: item.id, expectedRevision: item.revision, checkpoint: legacy });
  const before = f.manifests.read(item.id);
  first.stop();
  const second = f.manager();
  assert.equal((await second.resumeUpload(item.id)).code, "COLLAB_TRANSFER_DEVICE_CHANGED");
  assert.equal(second.list().transfers[0].id, item.id);
  assert.deepEqual(f.manifests.read(item.id), before);
  assert.equal(f.remote.initCalls.length, 0);
});

test("revocation and stopped continuations cannot resume or publish transfer progress", async (t) => {
  const f = fixture(t), api = f.manager(), prepared = await f.prepare(api);
  f.remote.authorized = false;
  assert.equal((await api.resumeUpload(prepared.id)).ok, false);
  assert.equal(f.remote.initCalls.length, 0);
  f.remote.authorized = true;
  let release;
  const original = f.objectClient.init;
  f.objectClient.init = async (input) => { await new Promise((resolve) => { release = resolve; }); return original(input); };
  const pending = api.resumeUpload(prepared.id);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const before = f.manifests.read(prepared.id);
  api.stop(); release();
  assert.equal((await pending).code, "COLLABORATION_STOPPED");
  assert.deepEqual(f.manifests.read(prepared.id), before, "late callbacks cannot write a closed/account-switched transfer");
});

test("cancel fences an in-flight init and remains cancelled after restart without duplicate dispatch", async (t) => {
  const f = fixture(t), api = f.manager(), prepared = await f.prepare(api);
  let release;
  const original = f.objectClient.init;
  f.objectClient.init = async (input) => { await new Promise((resolve) => { release = resolve; }); return original(input); };
  const pending = api.resumeUpload(prepared.id);
  assert.equal(api.resumeUpload(prepared.id), pending, "double click shares one in-flight operation");
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof api.cancel, "function");
  assert.equal((await api.cancel(prepared.id)).state, "cancelled");
  release();
  assert.equal((await pending).code, "COLLAB_TRANSFER_CANCELLED");
  assert.equal(f.remote.uploads, 0);
  api.stop();
  const restarted = f.manager();
  assert.equal((await restarted.resumeUpload(prepared.id)).code, "COLLAB_TRANSFER_CANCELLED");
  assert.equal(f.manifests.read(prepared.id).checkpoint.state, "cancelled");
  assert.equal(restarted.list().transfers[0].state, "cancelled");
});

async function downloadFixture(t) {
  const f = fixture(t), upload = f.manager();
  assert.equal((await upload.resumeUpload((await f.prepare(upload)).id)).state, "verified");
  let tickets = 0;
  const ranges = [];
  f.objectClient.downloadTicket = async () => {
    tickets++;
    if (!f.remote.authorized) throw Object.assign(new Error("revoked"), { code: "COLLAB_ACCESS_REVOKED" });
    return { objectId: "obj", url: `https://private.invalid/object?token=DOWNLOAD_SECRET_${tickets}`, expiresAt: new Date(Date.now() + 300000).toISOString(),
      dek: f.remote.metadata.dek, ciphertextSize: f.remote.ciphertext.length, ciphertextSha256: f.remote.metadata.ciphertextSha256 };
  };
  f.options.fetchImpl = async (url, options) => {
    assert.equal(options.redirect, "error"); assert.ok(options.signal);
    assert.ok(url.startsWith("https://private.invalid/"));
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.range); assert.ok(match);
    const start = Number(match[1]), end = Number(match[2]); ranges.push(start);
    assert.ok(end - start + 1 <= 4 * 1024 ** 2);
    if (f.remote.drop === "expired") { f.remote.drop = ""; return new Response(null, { status: 403 }); }
    const bytes = f.remote.ciphertext.subarray(start, end + 1);
    const headers = { "content-range": `bytes ${start}-${end}/${f.remote.ciphertext.length}`, "content-length": String(bytes.length) };
    if (f.remote.drop === "download") {
      f.remote.drop = ""; let pulls = 0;
      return new Response(new ReadableStream({ pull(controller) { if (pulls++ === 0) controller.enqueue(bytes.subarray(0, 1024)); else controller.error(new Error("secret read failure")); } }, { highWaterMark: 0 }), { status: 206, headers });
    }
    return new Response(bytes, { status: 206, headers });
  };
  const manager = () => createTransferManager(f.options);
  const prepareDownload = (api) => api.prepareDownload({ objectId: "obj", conversationId: "conversation", scopeId: "team:org", purpose: "attachment" });
  return { ...f, manager, prepareDownload, ranges, tickets: () => tickets };
}

test("download refreshes an expired URL, verifies ciphertext and publishes only authenticated plaintext", async (t) => {
  const f = await downloadFixture(t), api = f.manager();
  assert.equal(typeof api.prepareDownload, "function");
  const prepared = f.prepareDownload(api);
  assert.equal(f.tickets(), 0);
  await assert.rejects(api.verifiedFile(prepared.id));
  f.remote.drop = "expired";
  const result = await api.resumeDownload(prepared.id);
  assert.equal(result.state, "ready"); assert.equal(f.tickets(), 2);
  assert.deepEqual(fs.readFileSync(await api.verifiedFile(prepared.id)), fs.readFileSync(f.source));
  assert.doesNotMatch(JSON.stringify(result), /DOWNLOAD_SECRET|dek|path/i);
  assert.doesNotMatch(fs.readFileSync(path.join(f.manifests.directory(prepared.id), "manifest.json"), "utf8"), /DOWNLOAD_SECRET/);
});

test("partial download survives restart and resumes from owned file length", async (t) => {
  const f = await downloadFixture(t), api = f.manager();
  assert.equal(typeof api.prepareDownload, "function");
  const prepared = f.prepareDownload(api);
  f.remote.drop = "download";
  assert.equal((await api.resumeDownload(prepared.id)).state, "paused");
  api.stop();
  const next = f.manager();
  assert.equal((await next.resumeDownload(prepared.id)).state, "ready");
  assert.deepEqual(f.ranges.slice(0, 2), [0, 1024]);
  assert.deepEqual(fs.readFileSync(await next.verifiedFile(prepared.id)), fs.readFileSync(f.source));
});

for (const fault of ["ciphertext", "key"]) test(`invalid ${fault} never exposes a verified download`, async (t) => {
  const f = await downloadFixture(t), api = f.manager();
  assert.equal(typeof api.prepareDownload, "function");
  const prepared = f.prepareDownload(api);
  if (fault === "ciphertext") f.remote.ciphertext[300] ^= 1;
  else f.remote.metadata.dek = Buffer.alloc(32, 99).toString("base64");
  const rejected = await api.resumeDownload(prepared.id);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, fault === "ciphertext" ? "COLLAB_TRANSFER_INTEGRITY_FAILED" : "LILYENC_AUTH_FAILED");
  assert.ok(f.ranges.length > 0, "the actual payload, not an unrelated setup failure, must be rejected");
  await assert.rejects(api.verifiedFile(prepared.id));
  assert.equal(fs.existsSync(path.join(f.manifests.directory(prepared.id), "plaintext.verified")), false);
  assert.equal(fs.existsSync(path.join(f.manifests.directory(prepared.id), "ciphertext.part")), false, "failed authentication removes only the owned corrupt partial file");
});

for (const action of ["stop", "cancel", "revoke"]) test(`${action} after disk read prevents the next multipart dispatch`, async (t) => {
  const f = fixture(t), api = f.manager(), prepared = await f.prepare(api);
  const originalOpen = fs.promises.open;
  t.after(() => { fs.promises.open = originalOpen; });
  let triggered = false;
  fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args), read = handle.read.bind(handle);
    if (String(args[0]).endsWith("ciphertext.lilyenc")) handle.read = async (...values) => {
      const result = await read(...values);
      if (!triggered && values[0].length > 65536) {
        triggered = true;
        if (action === "stop") api.stop();
        else if (action === "cancel") await api.cancel(prepared.id);
        else f.remote.authorized = false;
      }
      return result;
    };
    return handle;
  };
  const result = await api.resumeUpload(prepared.id);
  assert.equal(result.ok, false); assert.equal(triggered, true);
  assert.deepEqual(f.remote.puts, [], "disk awaits cannot lend stale authority to the following network dispatch");
});

for (const action of ["stop", "revoke"]) test(`cancel response after ${action} cannot publish the old scope`, async (t) => {
  const f = fixture(t), api = f.manager(), prepared = await f.prepare(api);
  f.remote.drop = "part"; await api.resumeUpload(prepared.id);
  let release; f.objectClient.abort = () => new Promise((resolve) => { release = resolve; });
  const pending = api.cancel(prepared.id);
  assert.equal(typeof release, "function");
  if (action === "stop") api.stop(); else f.remote.authorized = false;
  release({ objectId: "obj", state: "aborted" });
  const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.conversationId, undefined); assert.equal(result.originalName, undefined);
});

test("cancelling a download never aborts the sender's shared object", async (t) => {
  const f = await downloadFixture(t), api = f.manager(), prepared = f.prepareDownload(api);
  let aborts = 0; f.objectClient.abort = async () => { aborts++; };
  assert.equal((await api.cancel(prepared.id)).state, "cancelled");
  assert.equal(aborts, 0);
});

for (const point of ["providerComplete", "complete"]) test(`${point} recovery trusts authorized server state before requiring staged ciphertext`, async (t) => {
  const f = fixture(t), api = f.manager(), prepared = await f.prepare(api);
  f.remote.drop = point; assert.equal((await api.resumeUpload(prepared.id)).state, "paused");
  fs.unlinkSync(path.join(f.manifests.directory(prepared.id), "ciphertext.lilyenc"));
  api.stop();
  assert.equal((await f.manager().resumeUpload(prepared.id)).state, "verified");
  assert.equal(f.remote.uploads, 1);
});
