"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { MAGIC, CHUNK_SIZE, MAX_HEADER_BYTES, MAX_PLAINTEXT_BYTES, containerError, invalid, encodeHeader, decodeHeader } = require("./encrypted-container-format");

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw containerError("LILYENC_KEY_INVALID", "An exact 32-byte DEK is required.");
}
function checkedKey(key) {
  assertKey(key);
  return Buffer.from(key);
}

// At most one upstream chunk and one requested frame are retained. Never trust
// wire lengths for allocation: the caller validates each fixed-size field first.
class ByteReader {
  constructor(input, maxInputChunk = CHUNK_SIZE) {
    this.iterator = input[Symbol.asyncIterator]();
    this.pending = Buffer.alloc(0);
    this.offset = 0;
    this.maxInputChunk = maxInputChunk;
  }
  async read(length, optional = false) {
    const result = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      if (this.offset === this.pending.length) {
        const next = await this.iterator.next();
        if (next.done) {
          if (optional && filled === 0) return null;
          throw invalid("Truncated container or plaintext stream.");
        }
        if (!Buffer.isBuffer(next.value) && !(next.value instanceof Uint8Array)) throw invalid("Input must be a byte stream.");
        if (next.value.length > this.maxInputChunk) throw containerError("LILYENC_INPUT_TOO_LARGE", "Input stream chunks exceed the bounded read limit.");
        this.pending = next.value;
        this.offset = 0;
        if (!this.pending.length) continue;
      }
      const amount = Math.min(length - filled, this.pending.length - this.offset);
      result.set(this.pending.subarray(this.offset, this.offset + amount), filled);
      filled += amount; this.offset += amount;
    }
    return result;
  }
  async end() { if (await this.read(1, true)) throw invalid("Unexpected trailing bytes."); }
  async close() { await this.iterator.return?.(); }
}

function claimNonce(seen, nonce) {
  if (!Buffer.isBuffer(nonce) || nonce.length !== 12) throw invalid("A nonce must be exactly 96 bits.");
  const id = nonce.toString("hex");
  if (seen.has(id)) throw containerError("LILYENC_NONCE_REUSE", "Repeated nonce in encrypted object.");
  seen.add(id);
  return Buffer.from(nonce);
}

function seal(key, nonce, aad, plaintext) {
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = cipher.update(plaintext);
  cipher.final();
  return { ciphertext, tag: cipher.getAuthTag() };
}

function open(key, nonce, aad, ciphertext, tag) {
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad); decipher.setAuthTag(tag);
    const plaintext = decipher.update(ciphertext);
    decipher.final();
    return plaintext;
  } catch { throw containerError("LILYENC_AUTH_FAILED", "Encrypted object authentication failed."); }
}

async function runStreamPipeline(input, transform, output) {
  const controller = new AbortController();
  // Function-stage pipelines can otherwise wait on source.next() after an
  // error-free output destroy(). Explicitly abort the complete owned pipeline.
  const onClose = () => {
    if (!output.writableFinished) controller.abort(output.errored || containerError("ERR_STREAM_PREMATURE_CLOSE", "Output closed before the container completed."));
  };
  output.once("close", onClose);
  try { await pipeline(input, transform, output, { signal: controller.signal }); }
  finally { output.off("close", onClose); }
}

// One session represents ONE object. The broker must issue a fresh DEK for each
// object; this module cannot detect reuse across processes/devices. nonceSource
// injection exists for fixed wire vectors; production encryptStream/encryptFile
// always use crypto.randomBytes. Even failed sessions cannot be retried/reused.
function createEncryptionSession({ key = crypto.randomBytes(32), nonceSource = crypto.randomBytes } = {}) {
  const secret = checkedKey(key);
  let used = false;
  return {
    async encrypt({ input, output, metadata } = {}) {
      if (used) throw containerError("LILYENC_SESSION_USED", "Encryption session has already been used.");
      used = true;
      let result;
      try {
        const { header, bytes: headerBytes } = encodeHeader(metadata);
        const seen = new Set();
        const payloadHash = crypto.createHash("sha256");
        const fullHash = crypto.createHash("sha256");
        const plainHash = crypto.createHash("sha256");
        let ciphertextSize = 0;
        function emit(data, payload = true) {
          if (payload) payloadHash.update(data);
          fullHash.update(data); ciphertextSize += data.length;
          return data;
        }
        async function* encode(source) {
          const reader = new ByteReader(source);
          try {
            yield emit(headerBytes);
            let remaining = header.plaintextSize;
            let count = 0;
            while (remaining > 0) {
              const length = Math.min(CHUNK_SIZE, remaining);
              const plaintext = await reader.read(length);
              plainHash.update(plaintext);
              const record = Buffer.alloc(9); record[0] = 1;
              record.writeUInt32BE(count, 1); record.writeUInt32BE(length, 5);
              const nonce = claimNonce(seen, nonceSource(12));
              const sealed = seal(secret, nonce, Buffer.concat([headerBytes, record]), plaintext);
              yield emit(record); yield emit(nonce); yield emit(sealed.ciphertext); yield emit(sealed.tag);
              remaining -= length; count++;
            }
            await reader.end();
            if (plainHash.digest("hex") !== header.plaintextSha256) throw invalid("Plaintext hash does not match declared metadata.");
            const trailer = Buffer.alloc(37); trailer[0] = 2; trailer.writeUInt32BE(count, 1);
            payloadHash.digest().copy(trailer, 5);
            const nonce = claimNonce(seen, nonceSource(12));
            const sealed = seal(secret, nonce, Buffer.concat([headerBytes, trailer]), Buffer.alloc(0));
            yield emit(trailer, false); yield emit(nonce, false); yield emit(sealed.tag, false);
            result = { key: Buffer.from(secret), metadata: header, chunkCount: count, ciphertextSize, ciphertextSha256: fullHash.digest("hex") };
          } finally { await reader.close(); }
        }
        await runStreamPipeline(input, encode, output);
        return result;
      } finally { secret.fill(0); }
    },
  };
}

async function encryptStream({ input, output, metadata, key } = {}) {
  return createEncryptionSession({ key }).encrypt({ input, output, metadata });
}

// Output is provisional until this promise fulfills: authenticated chunks alone
// do NOT prove the final container is complete. Use decryptFile for atomic publish.
// Both stream APIs own/end the supplied output; input chunks must be bounded.
async function decryptStream({ input, output, key } = {}) {
  const secret = checkedKey(key);
  let result;
  async function* decode(source) {
    const reader = new ByteReader(source, 2 * CHUNK_SIZE);
    try {
      const prefix = await reader.read(12);
      const length = prefix.readUInt32BE(8);
      if (!prefix.subarray(0, 8).equals(MAGIC) || length < 1 || length > MAX_HEADER_BYTES) throw invalid("Invalid magic or oversized header.");
      const { header, bytes: headerBytes } = decodeHeader(prefix, await reader.read(length));
      const seen = new Set();
      const payloadHash = crypto.createHash("sha256").update(headerBytes);
      const fullHash = crypto.createHash("sha256").update(headerBytes);
      const plainHash = crypto.createHash("sha256");
      let ciphertextSize = headerBytes.length;
      function track(data, payload = true) {
        if (payload) payloadHash.update(data);
        fullHash.update(data); ciphertextSize += data.length;
        return data;
      }
      let remaining = header.plaintextSize;
      let count = 0;
      while (remaining > 0) {
        const record = track(await reader.read(9));
        const size = record.readUInt32BE(5);
        if (record[0] !== 1 || record.readUInt32BE(1) !== count || size !== Math.min(CHUNK_SIZE, remaining)) throw invalid("Invalid chunk order or size.");
        const nonce = claimNonce(seen, track(await reader.read(12)));
        const ciphertext = track(await reader.read(size));
        const tag = track(await reader.read(16));
        const plaintext = open(secret, nonce, Buffer.concat([headerBytes, record]), ciphertext, tag);
        plainHash.update(plaintext);
        yield plaintext;
        remaining -= size; count++;
      }
      const trailer = track(await reader.read(37), false);
      if (trailer[0] !== 2 || trailer.readUInt32BE(1) !== count) throw invalid("Missing or invalid final chunk count.");
      const nonce = claimNonce(seen, track(await reader.read(12), false));
      const tag = track(await reader.read(16), false);
      open(secret, nonce, Buffer.concat([headerBytes, trailer]), Buffer.alloc(0), tag);
      if (!crypto.timingSafeEqual(payloadHash.digest(), trailer.subarray(5))) throw invalid("Ciphertext digest mismatch.");
      if (plainHash.digest("hex") !== header.plaintextSha256) throw invalid("Plaintext digest mismatch.");
      await reader.end();
      result = { metadata: header, chunkCount: count, ciphertextSize, ciphertextSha256: fullHash.digest("hex") };
    } finally { await reader.close(); }
  }
  try { await runStreamPipeline(input, decode, output); return result; }
  finally { secret.fill(0); }
}

// Paths must already be authorized by the main-process broker. Refuse symlink
// leaves AND ancestors; metadata fileName is never interpreted as an output path.
// These lstat checks are not an OS sandbox: the broker must own/protect transfer
// directories against concurrent ancestor renames (portable Node has no openat).
async function brokerPath(filePath, allowMissingLeaf = false) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw containerError("LILYENC_PATH_INVALID", "Broker paths must be absolute.");
  let normalized = path.resolve(filePath);
  // Verified, fixed macOS system aliases are not user-controlled path shortcuts.
  if (process.platform === "darwin") {
    for (const alias of ["/tmp", "/var"]) {
      if (normalized.startsWith(`${alias}/`) && await fs.promises.realpath(alias) === `/private${alias}`) normalized = `/private${normalized}`;
    }
  }
  const root = path.parse(normalized).root;
  const parts = normalized.slice(root.length).split(path.sep);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const leaf = index === parts.length - 1;
    let stat;
    try { stat = await fs.promises.lstat(current); }
    catch (error) { if (leaf && allowMissingLeaf && error.code === "ENOENT") return normalized; throw error; }
    if (stat.isSymbolicLink() || (!leaf && !stat.isDirectory()) || (leaf && !stat.isFile())) throw containerError("LILYENC_PATH_INVALID", "Broker paths cannot traverse symlinks or non-regular files.");
  }
  return normalized;
}

function fileInput(inputPath) {
  return fs.createReadStream(inputPath, { highWaterMark: 65536, flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) });
}

async function exclusiveOutput(outputPath, action) {
  // Never rename over an existing target. link() is atomic and fails with EEXIST
  // even when another writer creates the target after our preliminary check.
  try { await fs.promises.lstat(outputPath); throw Object.assign(new Error("Output already exists."), { code: "EEXIST" }); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const tempPath = path.join(path.dirname(outputPath), `.lilyenc-${crypto.randomUUID()}.tmp`);
  const handle = await fs.promises.open(tempPath, "wx", 0o600);
  const identity = await handle.stat();
  let closed = false;
  try {
    // Own the descriptor here, not in a WriteStream which pipeline.destroy()
    // can close independently. Handle partial OS writes without losing bytes.
    const output = new Writable({
      write(chunk, _encoding, callback) {
        (async () => {
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
            if (!bytesWritten) throw new Error("Output write made no progress.");
            offset += bytesWritten;
          }
        })().then(() => callback(), callback);
      },
    });
    const result = await action(output);
    await handle.sync(); await handle.close(); closed = true;
    await fs.promises.link(tempPath, outputPath);
    return result;
  } finally {
    if (!closed) await handle.close();
    // A path collision/open failure must never delete someone else's file.
    try {
      const current = await fs.promises.lstat(tempPath);
      if (current.dev === identity.dev && current.ino === identity.ino) await fs.promises.unlink(tempPath);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

async function encryptFile({ inputPath, outputPath, key, contentType = "application/octet-stream", fileName = path.basename(inputPath) } = {}) {
  if (key !== undefined) assertKey(key);
  inputPath = await brokerPath(inputPath);
  outputPath = await brokerPath(outputPath, true);
  const plainHash = crypto.createHash("sha256");
  let plaintextSize = 0;
  for await (const data of fileInput(inputPath)) {
    plaintextSize += data.length;
    if (plaintextSize > MAX_PLAINTEXT_BYTES) throw invalid("Plaintext exceeds the container size limit.");
    plainHash.update(data);
  }
  const metadata = { plaintextSize, plaintextSha256: plainHash.digest("hex"), contentType, fileName };
  encodeHeader(metadata); // Validate before opening the second input stream.
  // Two bounded passes; the second pass rechecks size/hash, detecting mutation.
  return exclusiveOutput(outputPath, (output) => encryptStream({ input: fileInput(inputPath), output, key, metadata }));
}

async function decryptFile({ inputPath, outputPath, key } = {}) {
  assertKey(key); // Reject before a ReadStream can open and emit an unowned error.
  inputPath = await brokerPath(inputPath);
  outputPath = await brokerPath(outputPath, true);
  return exclusiveOutput(outputPath, (output) => decryptStream({ input: fileInput(inputPath), output, key }));
}

module.exports = { createEncryptionSession, encryptStream, decryptStream, encryptFile, decryptFile };
