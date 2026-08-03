"use strict";

const {
  BOOK_SCOPES,
  MERGE_STRATEGIES,
  normalizeConversationConfig,
} = require("./conversation-config");

function buildLibraryActivationConfig(current, {
  kind,
  revisionId,
  scope = "chat",
  mergeStrategy = "constant",
} = {}) {
  if (!(kind === "character" || kind === "persona" || kind === "worldBook")) {
    throw new TypeError("Unsupported library activation kind");
  }
  if (typeof revisionId !== "string" || !revisionId.trim()) {
    throw new TypeError("Library activation revisionId is required");
  }
  const normalized = normalizeConversationConfig({
    characterRevisionId: current?.characterRevisionId,
    personaRevisionId: current?.personaRevisionId,
    books: current?.books,
    greetingIndex: current?.greetingIndex,
    sceneId: current?.sceneId,
    groupId: current?.groupId,
  });
  if (kind === "worldBook" && (!BOOK_SCOPES.has(scope) || !MERGE_STRATEGIES.has(mergeStrategy))) {
    throw new TypeError("Invalid world book activation options");
  }
  if (kind === "character") {
    return normalizeConversationConfig({
      ...normalized,
      characterRevisionId: revisionId,
    });
  }
  if (kind === "persona") {
    return normalizeConversationConfig({
      ...normalized,
      personaRevisionId: revisionId,
    });
  }
  return normalizeConversationConfig({
    ...normalized,
    books: [
      ...normalized.books.filter((book) => book.scope !== scope),
      { scope, worldBookRevisionId: revisionId, mergeStrategy },
    ],
  });
}

module.exports = { buildLibraryActivationConfig };
