#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { Readable, Writable, PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

assert.ok(fs.existsSync(new URL("../src/main/collaboration/encrypted-container.js", import.meta.url)), "LILYENC1 streaming implementation exists");
const require = createRequire(import.meta.url);
const { encryptStream, decryptStream, encryptFile, decryptFile, createEncryptionSession } = require("../src/main/collaboration/encrypted-container.js");
const { CHUNK_SIZE, MAX_HEADER_BYTES, MAX_PLAINTEXT_BYTES } = require("../src/main/collaboration/encrypted-container-format.js");
const hash = (data) => crypto.createHash("sha256").update(data).digest("hex");
const metadata = (data) => ({ plaintextSize: data.length, plaintextSha256: hash(data), contentType: "text/plain", fileName: "hello.txt" });
function sink() {
  const parts = [];
  return { output: new Writable({ write(data, _enc, cb) { parts.push(Buffer.from(data)); cb(); } }), bytes: () => Buffer.concat(parts) };
}
async function encrypt(data, options = {}) {
  const target = sink();
  const result = await encryptStream({ input: Readable.from([data]), output: target.output, metadata: metadata(data), ...options });
  return { bytes: target.bytes(), ...result };
}
async function decrypt(bytes, key) {
  const target = sink();
  const result = await decryptStream({ input: Readable.from((function* () { for (let i = 0; i < bytes.length; i += 65536) yield bytes.subarray(i, i + 65536); })()), output: target.output, key });
  return { bytes: target.bytes(), ...result };
}
function layout(bytes) {
  const headerEnd = 12 + bytes.readUInt32BE(8);
  const records = [];
  let offset = headerEnd;
  while (bytes[offset] === 1) {
    const length = 37 + bytes.readUInt32BE(offset + 5);
    records.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return { headerEnd, records, trailerOffset: offset };
}
const vector = JSON.parse(fs.readFileSync(new URL("../fixtures/collaboration/lilyenc1-vector.json", import.meta.url), "utf8"));
const fixedKey = Buffer.from(vector.keyHex, "hex");
let nonceIndex = 0;
const fixedSession = createEncryptionSession({ key: fixedKey, nonceSource: () => Buffer.from(vector.noncesHex[nonceIndex++], "hex") });
const fixedSink = sink();
const fixedResult = await fixedSession.encrypt({ input: Readable.from([Buffer.from(vector.plaintextHex, "hex")]), output: fixedSink.output, metadata: vector.metadata });
assert.equal(fixedSink.bytes().toString("hex"), vector.containerHex, "fixed independent wire vector must not drift");
assert.equal(fixedResult.ciphertextSha256, vector.ciphertextSha256);
assert.equal((await decrypt(fixedSink.bytes(), fixedKey)).bytes.toString("hex"), vector.plaintextHex);
await assert.rejects(fixedSession.encrypt({}), { code: "LILYENC_SESSION_USED" }, "a session/key is one-shot even for retries");

for (const size of [0, 1, CHUNK_SIZE, CHUNK_SIZE + 1]) {
  const data = Buffer.alloc(size, 0x61);
  const input = Readable.from((function* () { for (let i = 0; i < size; i += 65536) yield data.subarray(i, i + 65536); })());
  const encrypted = await encrypt(data, { input });
  const plain = await decrypt(encrypted.bytes, encrypted.key);
  assert.deepEqual(plain.bytes, data, `round-trip ${size} bytes`);
  assert.equal(plain.metadata.plaintextSha256, hash(data));
  assert.equal(encrypted.ciphertextSha256, hash(encrypted.bytes));
  assert.equal(layout(encrypted.bytes).records.length, Math.ceil(size / CHUNK_SIZE));
}
const sample = await encrypt(Buffer.from("secret"));
const second = await encrypt(Buffer.from("secret"));
assert.notDeepEqual(sample.key, second.key, "default encryption generates an independent DEK");
const explicitKey = crypto.randomBytes(32);
assert.deepEqual((await decrypt((await encrypt(Buffer.from("broker"), { key: explicitKey })).bytes, explicitKey)).bytes, Buffer.from("broker"));
assert.notDeepEqual(sample.bytes, second.bytes, "production output is randomized");
const { headerEnd, trailerOffset } = layout(sample.bytes);
for (const offset of [0, headerEnd + 9, headerEnd + 21, headerEnd + 27, trailerOffset + 1, trailerOffset + 5, trailerOffset + 37, sample.bytes.length - 1]) {
  const bad = Buffer.from(sample.bytes); bad[offset] ^= 1;
  await assert.rejects(decrypt(bad, sample.key), `tamper at byte ${offset} rejected`);
}
for (let cut = 0; cut < sample.bytes.length; cut++) await assert.rejects(decrypt(sample.bytes.subarray(0, cut), sample.key), `truncation at ${cut}`);
await assert.rejects(decrypt(Buffer.concat([sample.bytes, Buffer.from([0])]), sample.key), "trailing data rejected");
await assert.rejects(decrypt(sample.bytes, crypto.randomBytes(32)), "wrong key rejected");
await assert.rejects(decrypt(sample.bytes, Buffer.alloc(31)), "key size validated");
const empty = await encrypt(Buffer.alloc(0));
await assert.rejects(decrypt(empty.bytes, crypto.randomBytes(32)), "empty file still authenticates key/header/trailer");

function changedHeader(bytes, patch) {
  const end = 12 + bytes.readUInt32BE(8);
  const data = Buffer.from(JSON.stringify({ ...JSON.parse(bytes.subarray(12, end)), ...patch }));
  const prefix = Buffer.from(bytes.subarray(0, 12)); prefix.writeUInt32BE(data.length, 8);
  return Buffer.concat([prefix, data, bytes.subarray(end)]);
}
for (const patch of [{ version: 2 }, { algorithm: "AES-128-GCM" }, { chunkSize: CHUNK_SIZE + 1 }, { plaintextSize: MAX_PLAINTEXT_BYTES + 1 }, { plaintextSize: -1 }, { plaintextSha256: "0".repeat(64) }, { fileName: "other.txt" }, { fileName: "../bad" }]) {
  await assert.rejects(decrypt(changedHeader(sample.bytes, patch), sample.key), `header tamper ${JSON.stringify(patch)}`);
}
const oversized = Buffer.from(sample.bytes.subarray(0, 12)); oversized.writeUInt32BE(MAX_HEADER_BYTES + 1, 8);
await assert.rejects(decrypt(oversized, sample.key), { code: "LILYENC_FORMAT_INVALID" });
const oversizedChunk = Buffer.from(sample.bytes); oversizedChunk.writeUInt32BE(CHUNK_SIZE + 1, headerEnd + 5);
await assert.rejects(decrypt(oversizedChunk, sample.key), { code: "LILYENC_FORMAT_INVALID" });
const multi = await encrypt(Buffer.alloc(CHUNK_SIZE + 1), { input: Readable.from([Buffer.alloc(CHUNK_SIZE), Buffer.alloc(1)]) });
const parts = layout(multi.bytes);
const head = multi.bytes.subarray(0, parts.headerEnd); const tail = multi.bytes.subarray(parts.trailerOffset);
await assert.rejects(decrypt(Buffer.concat([head, parts.records[1], parts.records[0], tail]), multi.key), "reordered chunks rejected");
await assert.rejects(decrypt(Buffer.concat([head, parts.records[0], parts.records[0], tail]), multi.key), "duplicated chunks rejected");
const reusedNonce = Buffer.from(multi.bytes); parts.records[0].copy(reusedNonce, parts.headerEnd + parts.records[0].length + 9, 9, 21);
await assert.rejects(decrypt(reusedNonce, multi.key), { code: "LILYENC_NONCE_REUSE" });
const reuseSession = createEncryptionSession({ key: crypto.randomBytes(32), nonceSource: () => Buffer.alloc(12) });
await assert.rejects(reuseSession.encrypt({ input: Readable.from([Buffer.from("x")]), output: sink().output, metadata: metadata(Buffer.from("x")) }), { code: "LILYENC_NONCE_REUSE" }, "trailer cannot reuse data nonce");
await assert.rejects(encrypt(Buffer.from("x"), { metadata: { ...metadata(Buffer.from("x")), plaintextSha256: "0".repeat(64) } }), "incorrect caller plaintext hash rejected");
await assert.rejects(encrypt(Buffer.from("x"), { metadata: metadata(Buffer.from("xx")) }), "incorrect caller length rejected");
await assert.rejects(encrypt(Buffer.alloc(CHUNK_SIZE + 1)), { code: "LILYENC_INPUT_TOO_LARGE" }, "source chunks must also remain bounded");

// A live source may wait indefinitely for more bytes. Destination failure must
// abort that read, reject promptly, and release both streams without user input.
for (const mode of ["encrypt", "decrypt"]) {
  for (const failure of ["sync-error", "error", "close"]) {
    const input = new PassThrough();
    const output = new Writable({ write(_chunk, _encoding, callback) {
      if (failure === "sync-error") { callback(new Error("destination failed synchronously")); return; }
      setImmediate(() => failure === "error" ? callback(new Error("destination failed")) : output.destroy());
    } });
    const pending = mode === "encrypt"
      ? encryptStream({ input, output, metadata: metadata(Buffer.from("x")) })
      : decryptStream({ input, output, key: sample.key });
    if (mode === "decrypt") input.write(sample.bytes.subarray(0, trailerOffset));
    let timer;
    try {
      const outcome = await Promise.race([
        pending.then(() => "fulfilled", () => "rejected"),
        new Promise((resolve) => { timer = setTimeout(() => resolve("hung"), 1000); }),
      ]);
      assert.equal(outcome, "rejected", `${mode} must promptly reject on output ${failure} with input still open`);
      assert.equal(input.destroyed, true, `${mode} aborts owned input on output ${failure}`);
      assert.equal(output.destroyed, true);
    } finally { clearTimeout(timer); input.destroy(); output.destroy(); await pending.catch(() => {}); }
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lilyenc-test-"));
try {
  const sourcePath = path.join(dir, "source.txt"); fs.writeFileSync(sourcePath, "path broker content");
  const encryptedPath = path.join(dir, "encrypted"); const outputPath = path.join(dir, "decrypted");
  const result = await encryptFile({ inputPath: sourcePath, outputPath: encryptedPath });
  await decryptFile({ inputPath: encryptedPath, outputPath, key: result.key });
  const longName = path.join(dir, "x".repeat(220));
  await decryptFile({ inputPath: encryptedPath, outputPath: longName, key: result.key });
  assert.equal(fs.readFileSync(longName, "utf8"), "path broker content", "valid long output names must not overflow the temporary filename limit");
  assert.equal(fs.readFileSync(outputPath, "utf8"), "path broker content");
  if (process.platform !== "win32") assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
  await assert.rejects(decryptFile({ inputPath: encryptedPath, outputPath, key: result.key }), { code: "EEXIST" });
  await assert.rejects(encryptFile({ inputPath: sourcePath, outputPath: encryptedPath }), { code: "EEXIST" });
  assert.equal(fs.readFileSync(outputPath, "utf8"), "path broker content", "existing target never overwritten or deleted");
  const before = fs.readdirSync(dir).sort();
  await assert.rejects(decryptFile({ inputPath: encryptedPath, outputPath: path.join(dir, "wrong-key"), key: crypto.randomBytes(32) }));
  assert.deepEqual(fs.readdirSync(dir).sort(), before, "failure removes only its own exclusive temporary output");
  const damaged = fs.readFileSync(encryptedPath); damaged[damaged.length - 1] ^= 1;
  fs.writeFileSync(path.join(dir, "damaged"), damaged);
  await assert.rejects(decryptFile({ inputPath: path.join(dir, "damaged"), outputPath: path.join(dir, "not-published"), key: result.key }));
  assert.equal(fs.existsSync(path.join(dir, "not-published")), false, "late authentication failure never publishes partial plaintext");
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith(".tmp")), false);
  const originalUuid = crypto.randomUUID;
  try {
    const collisionPath = path.join(dir, "collision");
    const collisionTemp = path.join(dir, ".lilyenc-fixed.tmp");
    fs.writeFileSync(collisionTemp, "belongs to another transfer");
    crypto.randomUUID = () => "fixed";
    await assert.rejects(decryptFile({ inputPath: encryptedPath, outputPath: collisionPath, key: result.key }), { code: "EEXIST" });
    assert.equal(fs.readFileSync(collisionTemp, "utf8"), "belongs to another transfer");
    const racePath = path.join(dir, "race");
    crypto.randomUUID = () => { fs.writeFileSync(racePath, "concurrent owner"); return "race"; };
    await assert.rejects(decryptFile({ inputPath: encryptedPath, outputPath: racePath, key: result.key }), { code: "EEXIST" });
    assert.equal(fs.readFileSync(racePath, "utf8"), "concurrent owner", "atomic publication cannot overwrite a raced target");
  } finally { crypto.randomUUID = originalUuid; }
  const modulePath = fileURLToPath(new URL("../src/main/collaboration/encrypted-container.js", import.meta.url));
  const child = spawnSync(process.execPath, ["-e", `
    const { decryptFile } = require(${JSON.stringify(modulePath)});
    decryptFile({inputPath:${JSON.stringify(path.join(dir, "absent"))},outputPath:${JSON.stringify(path.join(dir, "invalid-key"))},key:Buffer.alloc(1)})
      .then(() => process.exitCode=2, e => { if(e.code !== "LILYENC_KEY_INVALID") process.exitCode=3; });
  `], { encoding: "utf8" });
  assert.equal(child.status, 0, `invalid key must not leak an unhandled input stream error: ${child.stderr}`);
  const safe = path.join(dir, "safe"); const outside = path.join(dir, "outside");
  fs.mkdirSync(safe); fs.mkdirSync(outside);
  const link = path.join(safe, "link"); fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  fs.copyFileSync(encryptedPath, path.join(outside, "encrypted"));
  fs.copyFileSync(sourcePath, path.join(outside, "source"));
  const sentinel = fs.readdirSync(outside).sort();
  await assert.rejects(decryptFile({ inputPath: encryptedPath, outputPath: path.join(link, "escaped"), key: result.key }), { code: "LILYENC_PATH_INVALID" });
  await assert.rejects(encryptFile({ inputPath: sourcePath, outputPath: path.join(link, "escaped") }), { code: "LILYENC_PATH_INVALID" });
  await assert.rejects(decryptFile({ inputPath: path.join(link, "encrypted"), outputPath: path.join(safe, "decoded"), key: result.key }), { code: "LILYENC_PATH_INVALID" });
  await assert.rejects(encryptFile({ inputPath: path.join(link, "source"), outputPath: path.join(safe, "encoded") }), { code: "LILYENC_PATH_INVALID" });
  assert.deepEqual(fs.readdirSync(outside).sort(), sentinel, "symlinked parents must not admit out-of-scope reads/writes");
  if (process.platform !== "win32") {
    const leaf = path.join(safe, "leaf"); fs.symlinkSync(encryptedPath, leaf);
    await assert.rejects(decryptFile({ inputPath: leaf, outputPath: path.join(safe, "decoded"), key: result.key }), { code: "LILYENC_PATH_INVALID" });
    await assert.rejects(decryptFile({ inputPath: encryptedPath, outputPath: leaf, key: result.key }), { code: "LILYENC_PATH_INVALID" });
  }
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

// One GiB passes directly through encryption and decryption, never a collected buffer.
// The default suite includes this regression; no sparse fixture or network is needed.
const size = 1024 ** 3; const block = Buffer.alloc(65536, 0x6d);
const expectedHash = crypto.createHash("sha256"); for (let n = 0; n < size / block.length; n++) expectedHash.update(block);
const largeMetadata = { plaintextSize: size, plaintextSha256: expectedHash.digest("hex"), contentType: "application/octet-stream", fileName: "large.bin" };
let peakRss = process.memoryUsage().rss; const startingRss = peakRss;
const monitor = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
const largeSource = Readable.from((async function* () { for (let n = 0; n < size / block.length; n++) { monitor(); yield block; } })());
const transport = new PassThrough({ highWaterMark: 65536 }); const largeKey = crypto.randomBytes(32);
let received = 0; const receivedHash = crypto.createHash("sha256");
const largeSink = new Writable({ write(chunk, _enc, cb) { received += chunk.length; receivedHash.update(chunk); monitor(); cb(); } });
await Promise.all([
  encryptStream({ input: largeSource, output: transport, metadata: largeMetadata, key: largeKey }),
  decryptStream({ input: transport, output: largeSink, key: largeKey }),
]);
assert.equal(received, size); assert.equal(receivedHash.digest("hex"), largeMetadata.plaintextSha256);
assert.ok(peakRss - startingRss < 256 * 1024 ** 2, `1GiB transfer RSS growth must stay <256MiB, observed ${(peakRss - startingRss) / 1024 ** 2}MiB`);
console.log(`collaboration encryption: ok; 1GiB round-trip; peak RSS ${(peakRss / 1024 ** 2).toFixed(1)}MiB, growth ${((peakRss - startingRss) / 1024 ** 2).toFixed(1)}MiB`);
