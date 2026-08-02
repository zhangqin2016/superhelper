"use strict";

const { types: utilTypes } = require("node:util");

const CONFIG_KEYS = new Set([
  "characterRevisionId",
  "personaRevisionId",
  "books",
  "greetingIndex",
  "sceneId",
  "groupId",
]);
const BOOK_KEYS = new Set(["scope", "worldBookRevisionId", "mergeStrategy"]);
const BOOK_SCOPES = new Set(["chat", "persona", "character", "global"]);
const MERGE_STRATEGIES = new Set(["constant", "keyed"]);
const MAX_ID_BYTES = 512;

function invalid() {
  return new TypeError("conversation_config_invalid");
}

function plainData(value, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw invalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function optionalId(value) {
  if (value == null || value === "") return null;
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > MAX_ID_BYTES
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw invalid();
  return value;
}

function normalizeBook(value) {
  const book = plainData(value, BOOK_KEYS);
  const scope = book.scope;
  const worldBookRevisionId = optionalId(book.worldBookRevisionId);
  const mergeStrategy = book.mergeStrategy == null ? "constant" : book.mergeStrategy;
  if (!BOOK_SCOPES.has(scope) || !worldBookRevisionId || !MERGE_STRATEGIES.has(mergeStrategy)) {
    throw invalid();
  }
  return Object.freeze({ scope, worldBookRevisionId, mergeStrategy });
}

function dedupeBooks(values = []) {
  if (!Array.isArray(values) || values.length > BOOK_SCOPES.size) throw invalid();
  const byScope = new Map();
  for (const value of values) {
    const book = normalizeBook(value);
    const current = byScope.get(book.scope);
    if (current) {
      if (
        current.worldBookRevisionId !== book.worldBookRevisionId
        || current.mergeStrategy !== book.mergeStrategy
      ) throw invalid();
      continue;
    }
    byScope.set(book.scope, book);
  }
  return Object.freeze([...byScope.values()]);
}

function normalizeConversationConfig(value = {}) {
  const config = plainData(value, CONFIG_KEYS);
  const characterRevisionId = optionalId(config.characterRevisionId);
  const personaRevisionId = optionalId(config.personaRevisionId);
  const books = dedupeBooks(config.books || []);
  const greetingIndex = characterRevisionId
    && Number.isSafeInteger(config.greetingIndex)
    && config.greetingIndex >= 0
    ? config.greetingIndex
    : null;
  const sceneId = characterRevisionId ? optionalId(config.sceneId) : null;
  const groupId = characterRevisionId ? optionalId(config.groupId) : null;
  return Object.freeze({
    characterRevisionId,
    personaRevisionId,
    books,
    greetingIndex,
    sceneId,
    groupId,
  });
}

function emptyConversationConfig() {
  return normalizeConversationConfig({});
}

function configMode(config) {
  return normalizeConversationConfig(config).characterRevisionId ? "character" : "native";
}

module.exports = {
  BOOK_SCOPES,
  MERGE_STRATEGIES,
  configMode,
  dedupeBooks,
  emptyConversationConfig,
  normalizeConversationConfig,
};
