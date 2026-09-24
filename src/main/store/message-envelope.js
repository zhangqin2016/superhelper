"use strict";

/**
 * The stored form of one message: gzipped JSON.
 *
 * Shared by the store that writes envelopes and the read module that inflates
 * them, so there is one definition of the wire format rather than two.
 */

const zlib = require("node:zlib");
// A timeline tool entry is stored as a reference to its twin in record.tools
// and read back whole, so every reader of a stored record sees what it always
// did (shared/timeline-tool-refs).
const { dehydrateMessage, rehydrateMessage } = require("../../shared/timeline-tool-refs.mjs");

function pack(envelope) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(dehydrateMessage(envelope)), "utf8"));
}

function unpack(blob) {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  return rehydrateMessage(JSON.parse(zlib.gunzipSync(buf).toString("utf8")));
}

module.exports = { pack, unpack };
