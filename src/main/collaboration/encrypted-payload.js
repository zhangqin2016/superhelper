"use strict";

/** Parse the persisted envelope before handing it to the account keyring. */
function parseEncryptedPayload(value) {
  try { return JSON.parse(value); } catch { throw new Error("collaboration store: encrypted payload is invalid"); }
}

module.exports = { parseEncryptedPayload };
