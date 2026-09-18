"use strict";

/**
 * The stored form of one message: gzipped JSON.
 *
 * Shared by the store that writes envelopes and the read module that inflates
 * them, so there is one definition of the wire format rather than two.
 */

const zlib = require("node:zlib");

function pack(envelope) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(envelope), "utf8"));
}

function unpack(blob) {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  return JSON.parse(zlib.gunzipSync(buf).toString("utf8"));
}

module.exports = { pack, unpack };
