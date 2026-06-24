"use strict";

const MAX_MESSAGE_CHARS = 700;
const MAX_CONTEXT_CHARS = 4_000;

const TERSE_FOLLOWUP_RE =
  /^(?:[？?]+|继续|接着|然后呢?|为啥|为什么|怎么说|不对|错了|不是|这个不对|你看|再看|呢)$/i;

function trimText(value, limit = MAX_MESSAGE_CHARS) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function messageText(message) {
  try {
    return require("./session-bootstrap").messageText(message);
  } catch {
    return String(message?.content || message?.record?.assistantText || message?.record?.user?.text || "").trim();
  }
}

function isTerseFollowup(text = "") {
  const source = String(text || "").trim();
  if (!source) return false;
  if (TERSE_FOLLOWUP_RE.test(source)) return true;
  const compact = source.replace(/\s+/g, "");
  return compact.length <= 3 && /[？?!！。.]/.test(compact);
}

function formatRecentMessages(messages = []) {
  return messages
    .map((message) => {
      const text = trimText(messageText(message));
      if (!text) return "";
      const role = message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : "Message";
      const incomplete = message.failed || ["turn.failed", "turn.stalled", "turn.interrupted"].includes(message.record?.terminal)
        ? " (incomplete)"
        : "";
      return `- ${role}${incomplete}: ${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

function buildShortFollowupContext({ userText = "", messages = [], summary = null } = {}) {
  if (!isTerseFollowup(userText)) return "";
  const recentMessages = Array.isArray(messages) ? messages.slice(-8) : [];
  const recent = formatRecentMessages(recentMessages);
  const summaryText = summary ? require("./session-memory").formatSessionSummary(summary) : "";
  if (!recent && !summaryText) return "";

  const parts = [
    "[Short Follow-up Continuity]",
    "The user's current message is very short, so treat it as a follow-up to the immediately preceding task, not as a new standalone request.",
    "Use the most recent user intent, corrections, incomplete turn status, and assistant output below to infer what needs to continue or be corrected.",
    "If the previous answer was incomplete, continue from the missing final result instead of starting a different topic.",
    "If the user is challenging a prior answer, identify the exact mismatch and re-check the workspace before answering.",
    "The user's last substantive request and explicit corrections outrank any topic or subsystem invented by a previous assistant answer.",
    "Do not continue a substituted neighboring subsystem unless the user's own words or workspace evidence prove it belongs to the requested scope.",
  ];
  if (summaryText) parts.push("", "Session summary:", summaryText);
  if (recent) parts.push("", "Recent visible conversation:", recent);
  parts.push("", `Current short follow-up: ${trimText(userText, 200)}`, "[End short follow-up continuity]");
  const text = parts.join("\n");
  return text.length <= MAX_CONTEXT_CHARS ? text : `${text.slice(0, MAX_CONTEXT_CHARS - 1)}…`;
}

function withShortFollowupContext({ userText = "", engineText = "", messages = [], summary = null } = {}) {
  const context = buildShortFollowupContext({ userText, messages, summary });
  if (!context) return { text: engineText || userText, applied: false };
  const { addLayersToEngineText } = require("./engine-message-layers");
  return {
    text: addLayersToEngineText(engineText || userText, {
      platformContext: context,
    }),
    applied: true,
  };
}

module.exports = {
  buildShortFollowupContext,
  isTerseFollowup,
  withShortFollowupContext,
};
