"use strict";

const { decodeJsonBuffer, decodeJsonDocument } = require("./bounded-json");
const {
  DEFAULT_IMPORT_LIMITS,
  MAX_CHARACTER_TEXT_FIELD_BYTES,
} = require("./constants");
const { cardError, limitError, resolveImportLimits } = require("./import-limits");
const { JsonPointerStack, pointerForField } = require("./json-pointer");

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const MAX_ARRAY_INDEX = 0xffff_fffe;

function arrayIndexForKey(key) {
  if (typeof key !== "string") return null;
  const index = Number(key);
  return Number.isInteger(index)
    && index >= 0
    && index <= MAX_ARRAY_INDEX
    && String(index) === key
    ? index
    : null;
}

function assertPlainData(value, overrides = {}) {
  const limits = resolveImportLimits(overrides);
  const ancestors = new Set();
  const pointer = new JsonPointerStack();
  const counts = {
    objects: 0, members: 0, arrays: 0, strings: 0, keys: 0,
    totalStringChars: 0, totalKeyChars: 0,
    totalStringBytes: 0, totalKeyBytes: 0,
  };
  const bump = (counter, limit, amount = 1) => {
    counts[counter] += amount;
    if (counts[counter] > limits[limit]) {
      throw limitError(limit, limits[limit], counts[counter], pointer.toString());
    }
  };
  const visit = (input, depth) => {
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) {
        throw cardError("CARD_JSON_INVALID", "Plain data contains a non-finite number", {
          path: pointer.toString(),
        });
      }
      return input;
    }
    if (typeof input === "string") {
      const chars = [...input].length;
      const bytes = Buffer.byteLength(input, "utf8");
      if (bytes > limits.maxStringBytes) {
        throw limitError("maxStringBytes", limits.maxStringBytes, bytes, pointer.toString());
      }
      if (chars > limits.maxStringChars) {
        throw limitError("maxStringChars", limits.maxStringChars, chars, pointer.toString());
      }
      bump("strings", "maxStrings");
      bump("totalStringChars", "maxTotalStringChars", chars);
      bump("totalStringBytes", "maxTotalStringBytes", bytes);
      return input;
    }
    if (!input || typeof input !== "object") {
      throw cardError("CARD_JSON_INVALID", "Value is not plain JSON data", {
        path: pointer.toString(),
      });
    }
    if (depth > limits.maxDepth) {
      throw cardError("CARD_DEPTH_EXCEEDED", "Plain data is too deeply nested", {
        limit: "maxDepth",
        maximum: limits.maxDepth,
        actual: depth,
        path: pointer.toString(),
      });
    }
    if (ancestors.has(input)) {
      throw cardError("CARD_JSON_INVALID", "Plain data must not contain cycles", {
        path: pointer.toString(),
      });
    }
    ancestors.add(input);
    const output = Array.isArray(input)
      ? visitArray(input, depth)
      : visitObject(input, depth);
    ancestors.delete(input);
    return output;
  };
  const visitArray = (input, depth) => {
    bump("arrays", "maxArrays");
    if (input.length > limits.maxArrayLength) {
      throw limitError(
        "maxArrayLength",
        limits.maxArrayLength,
        input.length,
        pointer.toString(),
      );
    }
    const descriptors = new Map();
    for (const key of Reflect.ownKeys(input)) {
      if (key === "length") continue;
      const index = arrayIndexForKey(key);
      const descriptor = index === null ? null : Object.getOwnPropertyDescriptor(input, key);
      if (
        index === null
        || index >= input.length
        || !descriptor?.enumerable
        || !Object.prototype.hasOwnProperty.call(descriptor, "value")
      ) {
        throw cardError("CARD_JSON_INVALID", "Array contains a non-JSON property", {
          path: pointer.toString(),
        });
      }
      descriptors.set(index, descriptor);
    }
    const output = [];
    for (let index = 0; index < input.length; index += 1) {
      pointer.push(index);
      const descriptor = descriptors.get(index);
      if (!descriptor) {
        throw cardError("CARD_JSON_INVALID", "Plain arrays must not contain holes", {
          path: pointer.toString(),
        });
      }
      output.push(visit(descriptor.value, depth + 1));
      pointer.pop();
    }
    return output;
  };
  const visitObject = (input, depth) => {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw cardError("CARD_JSON_INVALID", "Value is not a plain object", {
        path: pointer.toString(),
      });
    }
    bump("objects", "maxObjects");
    const output = Object.create(null);
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string") {
        throw cardError("CARD_JSON_INVALID", "Plain data contains a symbol key", {
          path: pointer.toString(),
        });
      }
      pointer.push(key);
      if (DANGEROUS_KEYS.has(key)) {
        throw cardError("CARD_DANGEROUS_KEY", "Plain data contains a dangerous key", {
          path: pointer.toString(),
        });
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        throw cardError("CARD_JSON_INVALID", "Plain properties must be enumerable values", {
          path: pointer.toString(),
        });
      }
      const chars = [...key].length;
      const bytes = Buffer.byteLength(key, "utf8");
      if (bytes > limits.maxKeyBytes) {
        throw limitError("maxKeyBytes", limits.maxKeyBytes, bytes, pointer.toString());
      }
      if (chars > limits.maxKeyChars) {
        throw limitError("maxKeyChars", limits.maxKeyChars, chars, pointer.toString());
      }
      bump("keys", "maxKeys");
      bump("members", "maxMembers");
      bump("totalKeyChars", "maxTotalKeyChars", chars);
      bump("totalKeyBytes", "maxTotalKeyBytes", bytes);
      output[key] = visit(descriptor.value, depth + 1);
      pointer.pop();
    }
    return output;
  };
  return visit(value, 1);
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownValue(object, key) {
  if (!object || typeof object !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor?.enumerable && Object.prototype.hasOwnProperty.call(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function normalizePreservedLexemes(entries) {
  if (!Array.isArray(entries)) {
    throw cardError("CARD_JSON_INVALID", "Preserved numeric lexemes must be an array", {
      path: "",
    });
  }
  if (entries.length > DEFAULT_IMPORT_LIMITS.maxNumberLexemes) {
    throw limitError(
      "maxNumberLexemes",
      DEFAULT_IMPORT_LIMITS.maxNumberLexemes,
      entries.length,
      "",
    );
  }
  const arrayKeys = Reflect.ownKeys(entries);
  if (
    arrayKeys.length !== entries.length + 1
    || arrayKeys.some((key) => key !== "length" && (
      arrayIndexForKey(key) === null || arrayIndexForKey(key) >= entries.length
    ))
  ) {
    throw cardError("CARD_JSON_INVALID", "Preserved numeric lexeme array is invalid", {
      path: "",
    });
  }
  let pathBytes = 0;
  let lexemeBytes = 0;
  const lexemes = Object.create(null);
  let previousPointer = null;
  for (let index = 0; index < entries.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(entries, String(index));
    const entry = descriptor?.enumerable
      && Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? descriptor.value
      : null;
    const keys = plainObject(entry) ? Reflect.ownKeys(entry) : [];
    const pointer = ownValue(entry, "pointer");
    const lexeme = ownValue(entry, "lexeme");
    if (
      keys.length !== 2
      || !keys.includes("pointer")
      || !keys.includes("lexeme")
      || typeof pointer !== "string"
      || typeof lexeme !== "string"
      || (pointer !== "" && !pointer.startsWith("/"))
      || !NUMBER_PATTERN.test(lexeme)
      || (previousPointer !== null && pointer <= previousPointer)
    ) {
      throw cardError("CARD_JSON_INVALID", "Preserved numeric lexeme entry is invalid", {
        path: typeof pointer === "string" ? pointer : "",
      });
    }
    pathBytes += Buffer.byteLength(pointer, "utf8");
    lexemeBytes += Buffer.byteLength(lexeme, "utf8");
    lexemes[pointer] = lexeme;
    previousPointer = pointer;
  }
  if (pathBytes > DEFAULT_IMPORT_LIMITS.maxNumberLexemePathBytes) {
    throw limitError(
      "maxNumberLexemePathBytes",
      DEFAULT_IMPORT_LIMITS.maxNumberLexemePathBytes,
      pathBytes,
      "",
    );
  }
  if (lexemeBytes > DEFAULT_IMPORT_LIMITS.maxJsonBytes) {
    throw limitError(
      "maxJsonBytes",
      DEFAULT_IMPORT_LIMITS.maxJsonBytes,
      lexemeBytes,
      "",
    );
  }
  return lexemes;
}

function serializeStable(value, pointer, lexemes, used) {
  const current = pointer.toString();
  if (lexemes && Object.prototype.hasOwnProperty.call(lexemes, current)) {
    if (value !== null && typeof value !== "number") {
      throw cardError("CARD_JSON_INVALID", "Numeric lexeme metadata path is not numeric", {
        path: current,
      });
    }
    used.add(current);
    return lexemes[current];
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => {
      pointer.push(index);
      const json = serializeStable(item, pointer, lexemes, used);
      pointer.pop();
      return json;
    }).join(",")}]`;
  }
  const entries = [];
  for (const key of Object.keys(value).sort()) {
    pointer.push(key);
    entries.push(`${JSON.stringify(key)}:${serializeStable(value[key], pointer, lexemes, used)}`);
    pointer.pop();
  }
  return `{${entries.join(",")}}`;
}

function stableJson(value) {
  if (arguments.length !== 1) {
    throw new TypeError("stableJson accepts exactly one plain-data value");
  }
  const normalized = assertPlainData(value);
  const used = new Set();
  return serializeStable(normalized, new JsonPointerStack(), null, used);
}

function serializePreservedJson(preserved) {
  if (!plainObject(preserved)) {
    throw cardError("CARD_JSON_INVALID", "Preserved character document is invalid", { path: "" });
  }
  const keys = Reflect.ownKeys(preserved);
  const schemaVersion = ownValue(preserved, "schemaVersion");
  const data = ownValue(preserved, "data");
  const entries = ownValue(preserved, "numberLexemes");
  if (
    keys.length !== 3
    || !keys.includes("schemaVersion")
    || !keys.includes("data")
    || !keys.includes("numberLexemes")
    || schemaVersion !== 1
  ) {
    throw cardError("CARD_JSON_INVALID", "Preserved character document is invalid", { path: "" });
  }
  const normalized = assertPlainData(data);
  const lexemes = normalizePreservedLexemes(entries);
  const used = new Set();
  const json = serializeStable(normalized, new JsonPointerStack(), lexemes, used);
  if (used.size !== Object.keys(lexemes).length) {
    throw cardError("CARD_JSON_INVALID", "Numeric lexeme metadata contains an unknown path", {
      path: "",
    });
  }
  return json;
}

function cloneInert(value, overrides = {}) {
  return assertPlainData(value, overrides);
}

function normalizeString(value, maxChars, field) {
  if (typeof value !== "string") return null;
  const chars = [...value].length;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_CHARACTER_TEXT_FIELD_BYTES) {
    throw limitError(
      "maxStringBytes",
      MAX_CHARACTER_TEXT_FIELD_BYTES,
      bytes,
      pointerForField(field),
    );
  }
  if (chars > maxChars) {
    throw limitError("maxChars", maxChars, chars, pointerForField(field));
  }
  return value;
}

function normalizeStringArray(value, overrides, field) {
  if (!Array.isArray(value)) return [];
  const limits = resolveImportLimits(overrides);
  const pointer = pointerForField(field);
  if (value.length > limits.maxArrayLength) {
    throw limitError("maxArrayLength", limits.maxArrayLength, value.length, pointer);
  }
  const result = [];
  let totalChars = 0;
  let totalBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== "string") continue;
    const chars = [...value[index]].length;
    const bytes = Buffer.byteLength(value[index], "utf8");
    if (bytes > limits.maxStringBytes) {
      throw limitError("maxStringBytes", limits.maxStringBytes, bytes, `${pointer}/${index}`);
    }
    if (chars > limits.maxStringChars) {
      throw limitError("maxStringChars", limits.maxStringChars, chars, `${pointer}/${index}`);
    }
    totalChars += chars;
    totalBytes += bytes;
    if (totalChars > limits.maxTotalStringChars) {
      throw limitError(
        "maxTotalStringChars",
        limits.maxTotalStringChars,
        totalChars,
        pointer,
      );
    }
    if (totalBytes > limits.maxTotalStringBytes) {
      throw limitError(
        "maxTotalStringBytes",
        limits.maxTotalStringBytes,
        totalBytes,
        pointer,
      );
    }
    result.push(value[index]);
  }
  return result;
}

module.exports = {
  assertPlainData,
  cardError,
  cloneInert,
  decodeJsonBuffer,
  decodeJsonDocument,
  normalizeString,
  normalizeStringArray,
  serializePreservedJson,
  stableJson,
};
