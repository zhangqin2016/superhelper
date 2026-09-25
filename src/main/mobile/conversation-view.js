"use strict";

/**
 * What the phone shows of a session: the same conversation the desktop shows.
 *
 * The phone used to read the turn projection table directly, which is not what
 * the desktop renders. That table is sorted oldest-first, so asking it for 12
 * rows returned a long session's FIRST twelve turns — the phone showed a
 * conversation from days ago while today's work never appeared. It also skipped
 * everything the desktop's conversation source does to make history readable:
 * collapsing auto-resumed continuation turns, hiding injected engine prompts,
 * and taking a rich turn's answer from `record.assistantText` when `content`
 * is empty.
 *
 * So the phone now reads the desktop's own conversation source (the one the
 * chat view uses — see desktop-port.readConversation), and this module only
 * shapes that list for a small screen and a 256 KB relay frame. Pure.
 */

const { messageText } = require("../conversation-message-text");
const { orderCommittedMessages } = require("../../shared/committed-message-order.mjs");

const DEFAULT_LIMIT = 30;
const MAX_ARTIFACTS = 8;

// The turn's produced-file cards, as the desktop shows them — id, name, kind,
// size; never the desktop path (the phone asks by id, see file-send.js).
function artifactsOf(message) {
  const list = message?.artifacts || message?.record?.artifacts || [];
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && (a.artifactId || a.id) && a.display !== "compact")
    .slice(0, MAX_ARTIFACTS)
    .map((a) => ({
      artifactId: String(a.artifactId || a.id),
      name: String(a.fileName || a.name || String(a.relativePath || a.path || "").split(/[\\/]/).pop() || "文件").slice(0, 120),
      kind: String(a.kind || "file"),
      bytes: Number.isFinite(a.bytes) ? a.bytes : 0,
    }));
}
const MAX_TEXT_CHARS = 6000;
// The relay drops frames over 256 KB. Measured in UTF-8 BYTES, not characters:
// Chinese is three bytes a character, so a character budget overflowed it.
const MAX_TOTAL_BYTES = 180 * 1024;

function assistantStatus(message) {
  const meta = message?.record?.meta || message?.meta || {};
  if (meta.interrupted || message?.record?.terminal === "turn.interrupted") return "interrupted";
  if (meta.failed || message?.record?.terminal === "turn.failed") return "failed";
  if (meta.stalled || message?.record?.terminal === "turn.stalled") return "stalled";
  return "completed";
}

function timestampOf(message) {
  const value = message?.timestamp || message?.ts || message?.createdAt || "";
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Shape the desktop's visible conversation for the phone.
 * @param {object[]} conversation  as returned by getConversationPageFromSource
 * @returns {{ items: object[], truncated: boolean }}
 */
function mobileConversationView(conversation, { limit = DEFAULT_LIMIT, maxTextChars = MAX_TEXT_CHARS, maxTotalBytes = MAX_TOTAL_BYTES, runningTurnId = "" } = {}) {
  const visible = [];
  // In the order the desktop shows it (turns by time, question before answer).
  for (const message of orderCommittedMessages(Array.isArray(conversation) ? conversation : [])) {
    const role = message?.role;
    if (role !== "user" && role !== "assistant") continue; // tool/system rows are not conversation
    if (role === "assistant" && message?.meta?.superseded === true) continue;
    const full = messageText(message).trim();
    const files = Array.isArray(message?.files) ? message.files.length : 0;
    const artifacts = role === "assistant" ? artifactsOf(message) : [];
    if (!full && !files && !artifacts.length) continue;
    const text = full.length > maxTextChars ? `${full.slice(0, maxTextChars)}…` : full;
    visible.push({
      id: String(message.id || message.turnId || `${role}:${visible.length}`),
      role,
      text,
      turnId: message.turnId ? String(message.turnId) : "",
      ts: timestampOf(message),
      // The turn running right now has no terminal yet; history would call it
      // "stalled", which the phone would show as an error.
      ...(role === "assistant"
        ? { status: runningTurnId && message.turnId === runningTurnId ? "running" : assistantStatus(message) }
        : {}),
      ...(files ? { files } : {}),
      ...(artifacts.length ? { artifacts } : {}),
      ...(text.length < full.length ? { cut: true } : {}),
    });
  }
  // Newest last, like the desktop — and the newest are the ones that matter.
  let items = visible.slice(-Math.max(1, limit));
  const bytes = (item) => Buffer.byteLength(item.text, "utf8") + 96; // + per-item JSON overhead
  let total = items.reduce((sum, item) => sum + bytes(item), 0);
  while (items.length > 1 && total > maxTotalBytes) {
    total -= bytes(items[0]);
    items = items.slice(1);
  }
  return { items, truncated: items.length < visible.length };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_TEXT_CHARS,
  MAX_TOTAL_BYTES,
  mobileConversationView,
};
