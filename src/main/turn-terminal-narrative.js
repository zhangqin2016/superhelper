"use strict";

const TODO_TOOL_NAMES = new Set(["todowrite"]);
const MIN_SUBSTANTIVE_CHARS = 400;

function isTodoToolEntry(entry = {}) {
  return entry?.kind === "tool" &&
    TODO_TOOL_NAMES.has(String(entry.name || "").trim().toLowerCase());
}

function looksLikeSubstantiveDelivery(text = "") {
  const value = String(text || "").trim();
  if (value.length >= MIN_SUBSTANTIVE_CHARS) return true;
  const hasHeading = /(^|\n)#{1,6}\s+\S/.test(value);
  const hasTable = /(^|\n)\|.+\|\s*\n\|?\s*:?-{3,}/.test(value);
  const hasFence = /(^|\n)(`{3,}|~{3,})[^\n]*\n/.test(value);
  return hasHeading && (hasTable || hasFence || value.length >= 240);
}

function joinMarkdownBlocks(...values) {
  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Preserve a substantial delivery that was followed only by TodoWrite
 * bookkeeping and a final acknowledgement.
 *
 * Unknown/malformed structures keep the existing terminal-normalized answer.
 */
function promoteTerminalNarrative(timeline = [], assistant = "") {
  const originalAssistant = String(assistant || "").trim();
  if (!Array.isArray(timeline) || timeline.length < 3) {
    return { assistant: originalAssistant, timeline, promoted: false };
  }

  const textIndexes = [];
  for (let index = 0; index < timeline.length; index += 1) {
    if (timeline[index]?.kind === "text" && String(timeline[index].text || "").trim()) {
      textIndexes.push(index);
    }
  }
  if (textIndexes.length < 2) {
    return { assistant: originalAssistant, timeline, promoted: false };
  }

  const lastTextIndex = textIndexes[textIndexes.length - 1];
  const deliveryIndex = textIndexes[textIndexes.length - 2];
  const between = timeline.slice(deliveryIndex + 1, lastTextIndex);
  const tools = between.filter((entry) => entry?.kind === "tool");
  const hasUnsupportedEntry = between.some((entry) => (
    entry?.kind === "text" ||
    (entry?.kind === "tool" && !isTodoToolEntry(entry))
  ));
  if (!tools.length || hasUnsupportedEntry || !tools.every(isTodoToolEntry)) {
    return { assistant: originalAssistant, timeline, promoted: false };
  }

  const deliveryText = String(timeline[deliveryIndex]?.text || "").trim();
  const closingText = String(timeline[lastTextIndex]?.text || "").trim();
  if (!looksLikeSubstantiveDelivery(deliveryText) || !closingText) {
    return { assistant: originalAssistant, timeline, promoted: false };
  }

  const promotedText = joinMarkdownBlocks(deliveryText, closingText);
  const nextTimeline = timeline.map((entry) => ({ ...entry }));
  nextTimeline[lastTextIndex] = {
    ...nextTimeline[lastTextIndex],
    text: promotedText,
  };
  nextTimeline.splice(deliveryIndex, 1);
  return {
    assistant: promotedText,
    timeline: nextTimeline,
    promoted: true,
  };
}

module.exports = {
  isTodoToolEntry,
  joinMarkdownBlocks,
  looksLikeSubstantiveDelivery,
  promoteTerminalNarrative,
};
