"use strict";

const script = require("../shared/script.mjs");

function normalizedText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function messageText(message = {}) {
  const candidates = [
    message.content,
    message.text,
    message.message,
    message.record?.user?.text,
    message.record?.assistantText,
  ];
  for (const value of candidates) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  if (Array.isArray(message.parts)) {
    return message.parts
      .map((part) => (typeof part === "string" ? part : part?.text || part?.content || ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

// The engine stores what Lily SENT: the user's text wrapped in lily_layer
// blocks (platform context, memory, the user_original_request anchor). Compare
// the user's own words, never the wrapper — otherwise every layered turn
// looks foreign to its own local record.
function unwrapEngineText(text) {
  const value = String(text || "");
  try {
    const layers = require("./engine-message-layers");
    if (!layers.hasLayeredEngineText(value)) return value;
    const original = layers.extractUserOriginalRequest(value);
    if (original) return original;
  } catch {
    /* fall through to a plain strip */
  }
  return value.replace(/<lily_layer\s+title="[^"]+">[\s\S]*?<\/lily_layer>/g, " ");
}

function userTexts(messages = []) {
  const { isPlatformAuthoredPromptText } = require("./internal-prompt-marker");
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === "user")
    .map(messageText)
    // Judged on the ORIGINAL text, before unwrapping: authorship is only
    // unambiguous while the tag is still attached. A prompt the platform sent
    // to itself reaches the engine as a user message but never appears in
    // Lily's own history, so counting it here compares two different things —
    // and a run of them pushes the real messages out of the comparison window
    // entirely, which reads as a mismatch and costs the session its resume.
    .filter((text) => !isPlatformAuthoredPromptText(text))
    .map(unwrapEngineText)
    .map(normalizedText)
    .filter(Boolean);
}

const CJK_PATTERN = script.EAST_ASIAN_CHAR_RE;

// Minimum length before a containment match counts. Latin text needs a few
// words; CJK carries a whole word per character, so "帮我优化" (4 chars) is
// already specific enough — the old flat 6-char floor made every short
// Chinese turn a false "history mismatch" and reset the engine session.
function containmentFloor(text) {
  return CJK_PATTERN.test(text) ? 2 : 6;
}

function textsOverlap(a = "", b = "") {
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (short.length >= containmentFloor(short) && long.includes(short)) return true;
  return false;
}

function classifyResumeContinuity({ localMessages = [], officialMessages = [] } = {}) {
  const localUsers = userTexts(localMessages);
  const officialUsers = userTexts(officialMessages);
  if (!officialUsers.length) return { ok: true, reason: "official_history_empty" };
  if (!localUsers.length) {
    return {
      ok: false,
      reason: "official_history_for_empty_local_session",
      officialUserSample: officialUsers.at(-1) || "",
    };
  }
  const localRecent = localUsers.slice(-8);
  const officialRecent = officialUsers.slice(-6);
  const matched = officialRecent.some((official) => localRecent.some((local) => textsOverlap(local, official)));
  if (matched) return { ok: true, reason: "recent_user_overlap" };
  return {
    ok: false,
    reason: "recent_user_history_mismatch",
    localUserSample: localRecent.at(-1) || "",
    officialUserSample: officialRecent.at(-1) || "",
  };
}

function withTimeout(promise, ms = 3000) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => resolve({ timedOut: true }), ms);
    }),
  ]);
}

async function verifyRunnerResumeContinuity({ runner, sessionManager, sessionId, timeoutMs = 3000 } = {}) {
  if (!runner?.getConversationPage || !sessionManager?.getConversation || !sessionId) {
    return { ok: true, reason: "missing_inputs" };
  }
  const page = await withTimeout(runner.getConversationPage({ limit: 12 }), timeoutMs);
  if (page?.timedOut) return { ok: true, reason: "official_history_timeout" };
  return classifyResumeContinuity({
    // The classifier compares the last 8 user texts; two pages of tail cover it.
    localMessages: await (sessionManager.getRecentConversationAsync || sessionManager.getRecentConversation || sessionManager.getConversation).call(sessionManager, sessionId, { limit: 40 }) || [],
    officialMessages: page?.conversation || [],
  });
}

module.exports = {
  classifyResumeContinuity,
  normalizedText,
  verifyRunnerResumeContinuity,
  withTimeout,
};
