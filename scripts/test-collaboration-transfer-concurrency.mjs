import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
process.env.LILY_COLLAB_UPLOAD_CONCURRENCY = "4";
const require = createRequire(import.meta.url);
const { createTransferManifestStore } = require("../src/main/collaboration/transfer-manifest");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring");
const { decryptFile } = require("../src/main/collaboration/encrypted-container");
const { createTransferManager } = require("../src/main/collaboration/transfer-manager");
const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lily-transfer-concurrency-"));
try {
  const source = path.join(dir, "source.bin"); fs.writeFileSync(source, crypto.randomBytes(6 * 4 * 1024 ** 2 - 4096 + 21));
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys"), safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() } });
  const manifests = createTransferManifestStore({ rootPath: path.join(dir, "collaboration-transfer"), accountId: "alice", keyring });
  const remote = { parts: new Map(), puts: [], inFlight: 0, maxInFlight: 0, failOnce: 3, ciphertext: null, state: "uploading", metadata: null };
  const ticket = { bucket: "test", objectKey: `collaboration/${"a".repeat(64)}`, token: "UPLOAD_SECRET", uploadUrl: "https://upload.invalid" };
  const objectClient = {
    async init(input) { remote.metadata = input; return { objectId: "obj", state: "uploading", upload: ticket }; },
    async status() { return { objectId: "obj", state: remote.state, ciphertextSize: remote.metadata.ciphertextSize, ciphertextSha256: remote.metadata.ciphertextSha256, etag: remote.ciphertext ? "object-etag" : null, upload: ticket, provider: remote.ciphertext ? { state: "present", etag: "object-etag" } : { state: "missing" } }; },
    async complete(input) { assert.equal(crypto.createHash("sha256").update(remote.ciphertext).digest("hex"), input.ciphertextSha256); remote.state = "verified"; return { objectId: "obj", state: "verified" }; },
    async abort() { remote.state = "aborted"; return { objectId: "obj", state: "aborted" }; },
  };
  const multipart = {
    async initiate() { return { uploadId: "upload", expireAt: 2_000_000_000 }; },
    async listParts() { return { uploadId: "upload", marker: 0, expireAt: 2_000_000_000, parts: [...remote.parts].map(([partNumber, bytes]) => ({ partNumber, etag: `etag-${partNumber}`, size: bytes.length })) }; },
    async uploadPart({ partNumber, bytes }) {
      remote.inFlight++; remote.maxInFlight = Math.max(remote.maxInFlight, remote.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      remote.inFlight--;
      if (remote.failOnce === partNumber) { remote.failOnce = null; throw Object.assign(new Error("lost"), { code: "COLLAB_TRANSFER_RESPONSE_LOST" }); }
      remote.puts.push(partNumber); remote.parts.set(partNumber, Buffer.from(bytes));
      return { partNumber, etag: `etag-${partNumber}` };
    },
    async complete({ parts }) {
      assert.deepEqual(parts.map((p) => p.partNumber), [1, 2, 3, 4, 5, 6], "completion lists every part once, in order, regardless of upload order");
      remote.ciphertext = Buffer.concat(parts.map(({ partNumber }) => remote.parts.get(partNumber))); return { etag: "object-etag" };
    },
  };
  const options = { manifests, objectClient, multipart, deviceId: "device", assertAuthorized: () => {} };
  const api = createTransferManager(options);
  const prepared = await api.prepareUpload({ inputPath: source, conversationId: "conversation", scopeId: "team:org", purpose: "attachment", originalName: "source.bin", mimeType: "application/octet-stream" });
  let first;
  try { first = await api.resumeUpload(prepared.id); } catch (error) { first = { state: "threw", error: error.code || error.message }; }
  assert.ok(remote.maxInFlight > 1 && remote.maxInFlight <= 4, `parts were uploaded concurrently within the policy bound (max in flight ${remote.maxInFlight})`);
  assert.equal(remote.inFlight, 0, "no upload is left running once the attempt settles");
  assert.equal(remote.failOnce, null, "the lost response was actually injected");
  const attempts = remote.puts.length;
  const result = first.state === "verified" ? first : await createTransferManager(options).resumeUpload(prepared.id);
  assert.equal(result.state, "verified", `first attempt ${JSON.stringify(first)}`);
  assert.deepEqual([...remote.parts.keys()].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(remote.puts).size, remote.puts.length, "no part is uploaded twice across the lost response and the resume");
  assert.equal(remote.puts.length, 6, `exactly six part uploads succeeded (${attempts} before recovery)`);
  const output = path.join(dir, "restored.bin"), ciphertext = path.join(dir, "received.lilyenc");
  fs.writeFileSync(ciphertext, remote.ciphertext);
  await decryptFile({ inputPath: ciphertext, outputPath: output, key: Buffer.from(remote.metadata.dek, "base64") });
  assert.deepEqual(fs.readFileSync(output), fs.readFileSync(source), "concurrently uploaded parts reassemble to the authentic plaintext");
  console.log(`PASS transfer concurrency: ${remote.maxInFlight} parts in flight under a policy of 4, lost part response recovered inside the manager, single successful upload per part, authentic plaintext`);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
