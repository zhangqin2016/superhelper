"use strict";

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

function userTexts(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === "user")
    .map(messageText)
    .map(normalizedText)
    .filter(Boolean);
}

function textsOverlap(a = "", b = "") {
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (short.length >= 6 && long.includes(short)) return true;
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
    localMessages: sessionManager.getConversation(sessionId) || [],
    officialMessages: page?.conversation || [],
  });
}

module.exports = {
  classifyResumeContinuity,
  normalizedText,
  verifyRunnerResumeContinuity,
  withTimeout,
};
