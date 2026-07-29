"use strict";

const { DEFAULT_IMPORT_LIMITS } = require("./constants");

function safePathDepth(path) {
  const pointer = typeof path === "string" ? path : "";
  return pointer === "" ? 0 : pointer.split("/").length - 1;
}

function cardError(code, message, details = {}) {
  const safeDetails = { ...details };
  const path = safeDetails.path;
  delete safeDetails.path;
  return Object.assign(new Error(message), {
    code,
    ...safeDetails,
    pathDepth: safePathDepth(path),
  });
}

function limitError(limit, maximum, actual, path = "") {
  return cardError("CARD_LIMIT_EXCEEDED", "Character card data exceeds a parser limit", {
    limit,
    maximum,
    actual,
    path,
  });
}

function resolveImportLimits(overrides = {}) {
  const supplied = overrides || {};
  for (const key of Object.keys(supplied)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_IMPORT_LIMITS, key)) {
      throw new TypeError("Unknown character card parser limit");
    }
  }
  const resolved = { ...DEFAULT_IMPORT_LIMITS };
  for (const [key, ceiling] of Object.entries(DEFAULT_IMPORT_LIMITS)) {
    if (key === "version") {
      if (supplied[key] != null && supplied[key] !== ceiling) {
        throw new TypeError("Character card limit version cannot be overridden");
      }
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(supplied, key)) continue;
    const value = supplied[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("Invalid character card parser limit");
    }
    if (value > ceiling) throw limitError(key, ceiling, value);
    resolved[key] = value;
  }
  return resolved;
}

module.exports = {
  cardError,
  limitError,
  resolveImportLimits,
};
