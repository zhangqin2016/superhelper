"use strict";

/**
 * What a file's first bytes say it is, versus what its name claims.
 *
 * inspect_file reports `kind` from the extension alone, so a file named
 * report.docx that actually holds PDF bytes was reported as a Word document with
 * no warning, and only failed later inside the extractor with an opaque message.
 * Acceptance 2026-09-17 DEF-09.
 *
 * This is ADVISORY on purpose. `kind` stays extension-derived because it is
 * load-bearing for indexing, extraction routing and the binary guards; flipping
 * it on a signature mismatch would change behaviour repo-wide on a heuristic.
 * What changes is that the caller is TOLD, before it trusts the type.
 *
 * [gate: file-type-honesty]
 */

const fs = require("node:fs");

const HEADER_BYTES = 8;

// Container signatures only — formats whose first bytes are a hard commitment.
// A format without one simply has no opinion here.
const SIGNATURES = [
  { format: "pdf", bytes: Buffer.from("%PDF") },
  { format: "zip", bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]) },
  { format: "zip", bytes: Buffer.from([0x50, 0x4b, 0x05, 0x06]) },
  { format: "ole2", bytes: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]) },
  { format: "png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  { format: "jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff]) },
  { format: "gif", bytes: Buffer.from("GIF8") },
  { format: "rtf", bytes: Buffer.from("{\\rtf") },
];

// What each extension family MUST start with. Anything not listed is unchecked.
const EXPECTED_BY_EXTENSION = {
  ".pdf": ["pdf"],
  ".docx": ["zip"],
  ".xlsx": ["zip"],
  ".pptx": ["zip"],
  ".doc": ["ole2"],
  ".xls": ["ole2"],
  ".ppt": ["ole2"],
  ".png": ["png"],
  ".jpg": ["jpeg"],
  ".jpeg": ["jpeg"],
  ".gif": ["gif"],
};

function readHeader(filePath) {
  let handle = null;
  try {
    handle = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(HEADER_BYTES);
    const read = fs.readSync(handle, buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (handle !== null) {
      try { fs.closeSync(handle); } catch { /* best effort */ }
    }
  }
}

/** The format the bytes declare, or "" when they declare nothing. */
function detectFormat(filePath, { readHeaderImpl = readHeader } = {}) {
  let header = null;
  try {
    header = readHeaderImpl(filePath);
  } catch {
    // Reading the header is an enhancement. A probe that throws means "no
    // opinion", never an accusation.
    return "";
  }
  if (!header || !header.length) return "";
  for (const signature of SIGNATURES) {
    if (header.length >= signature.bytes.length && header.subarray(0, signature.bytes.length).equals(signature.bytes)) {
      return signature.format;
    }
  }
  return "";
}

/**
 * Advisory fields for inspectPath, or {} when there is nothing to say — which is
 * the answer for an unchecked extension, an unreadable file, and bytes that
 * declare no format at all.
 *
 * @returns {{ detectedFormat?: string, extensionMismatch?: boolean, warning?: string }}
 */
function signatureAdvisory(filePath, extension, options = {}) {
  const expected = EXPECTED_BY_EXTENSION[String(extension || "").toLowerCase()];
  if (!expected) return {};
  const detected = detectFormat(filePath, options);
  if (!detected) return {};
  if (expected.includes(detected)) return { detectedFormat: detected };
  return {
    detectedFormat: detected,
    extensionMismatch: true,
    warning: `Content does not match the file name: ${extension} should start with ${expected.join(" or ")} bytes, but this file is ${detected}. Treat the type as unverified.`,
  };
}

module.exports = {
  EXPECTED_BY_EXTENSION,
  SIGNATURES,
  detectFormat,
  signatureAdvisory,
};
