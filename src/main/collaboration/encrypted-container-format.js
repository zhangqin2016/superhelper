"use strict";

// LILYENC1 wire contract (all integers unsigned, big-endian):
// header: 8-byte magic | u32 JSON byte length | canonical UTF-8 JSON
// data:   u8(1) | u32 index | u32 plaintext length | nonce[12] | ciphertext | tag[16]
// end:    u8(2) | u32 count | SHA256(header + complete data records)[32] | nonce[12] | tag[16]
// Every data tag authenticates header + its first 9 record bytes. The end tag
// authenticates header + its first 37 bytes with empty plaintext. This mandatory
// end record authenticates even empty files and prevents prefix/truncation attacks.
// The returned ciphertextSha256 hashes the ENTIRE container including the end
// record, for object-store verification; the end digest excludes itself.
const MAGIC = Buffer.from("LILYENC1", "ascii");
const CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_HEADER_BYTES = 4096;
const MAX_PLAINTEXT_BYTES = 1024 ** 4; // 1 TiB; bounds nonce tracking to 262145 entries.

function containerError(code, message) {
  return Object.assign(new Error(message), { code });
}
function invalid(message) { return containerError("LILYENC_FORMAT_INVALID", message); }

function normalizeFileName(value) {
  if (typeof value !== "string") throw invalid("A file name is required.");
  const name = value.normalize("NFC").replace(/[\\/\x00-\x1f\x7f]/g, "_").trim();
  if (!name || name === "." || name === ".." || Buffer.byteLength(name) > 255) throw invalid("Invalid file name.");
  return name;
}

function canonicalHeader(metadata) {
  if (!metadata || !Number.isSafeInteger(metadata.plaintextSize) || metadata.plaintextSize < 0 || metadata.plaintextSize > MAX_PLAINTEXT_BYTES) throw invalid("Invalid plaintext size.");
  if (typeof metadata.plaintextSha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.plaintextSha256)) throw invalid("Invalid plaintext SHA-256.");
  if (typeof metadata.contentType !== "string" || !/^[\x20-\x7e]{1,255}$/.test(metadata.contentType)) throw invalid("Invalid content type.");
  return {
    version: 1,
    algorithm: "AES-256-GCM",
    chunkSize: CHUNK_SIZE,
    plaintextSize: metadata.plaintextSize,
    plaintextSha256: metadata.plaintextSha256,
    contentType: metadata.contentType,
    fileName: normalizeFileName(metadata.fileName),
  };
}

function encodeHeader(metadata) {
  const header = canonicalHeader(metadata);
  const json = Buffer.from(JSON.stringify(header), "utf8");
  if (json.length > MAX_HEADER_BYTES) throw invalid("Oversized header.");
  const prefix = Buffer.alloc(12);
  MAGIC.copy(prefix); prefix.writeUInt32BE(json.length, 8);
  return { header, bytes: Buffer.concat([prefix, json]) };
}

function decodeHeader(prefix, json) {
  if (!prefix.subarray(0, 8).equals(MAGIC) || prefix.readUInt32BE(8) !== json.length) throw invalid("Invalid container magic or header length.");
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json)); }
  catch { throw invalid("Malformed header JSON."); }
  if (parsed?.version !== 1 || parsed?.algorithm !== "AES-256-GCM" || parsed?.chunkSize !== CHUNK_SIZE) throw invalid("Unsupported container version, algorithm, or chunk size.");
  const encoded = encodeHeader(parsed);
  if (!encoded.bytes.subarray(12).equals(json)) throw invalid("Header must use canonical fields and encoding.");
  return encoded;
}

module.exports = { MAGIC, CHUNK_SIZE, MAX_HEADER_BYTES, MAX_PLAINTEXT_BYTES, containerError, invalid, normalizeFileName, encodeHeader, decodeHeader };
