"use strict";

const { types: utilTypes } = require("node:util");

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validId(value) {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 512;
}

function isReadyCompositionSnapshot(snapshot) {
  if (!plain(snapshot) || snapshot.snapshotStatus !== "ready") return false;
  if (snapshot.mode === "character") return validId(snapshot.characterRevisionId);
  return snapshot.schemaVersion === 2
    && snapshot.mode === "native"
    && snapshot.characterRevisionId === null
    && (validId(snapshot.personaRevisionId) || snapshot.worldBookBindings?.length > 0);
}

module.exports = { isReadyCompositionSnapshot };
