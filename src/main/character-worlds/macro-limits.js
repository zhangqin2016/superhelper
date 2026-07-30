"use strict";

const { types } = require("node:util");
const { DEFAULT_MACRO_LIMITS } = require("./constants");

function resolveMacroLimits(overrides) {
  const source = overrides && typeof overrides === "object" ? overrides : {};
  if (types.isProxy(source)) {
    return { limits: DEFAULT_MACRO_LIMITS, ok: false };
  }

  const resolved = {};
  for (const [key, hardLimit] of Object.entries(DEFAULT_MACRO_LIMITS)) {
    if (key === "version") {
      resolved[key] = hardLimit;
      continue;
    }
    const candidate = Object.getOwnPropertyDescriptor(source, key);
    resolved[key] = candidate
      && "value" in candidate
      && Number.isSafeInteger(candidate.value)
      && candidate.value >= 0
      ? Math.min(hardLimit, candidate.value)
      : hardLimit;
  }
  resolved.maxInputBytes = Math.min(resolved.maxInputBytes, resolved.maxOutputBytes);
  return { limits: Object.freeze(resolved), ok: true };
}

module.exports = {
  resolveMacroLimits,
};
