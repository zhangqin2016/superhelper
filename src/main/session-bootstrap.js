"use strict";

const MAX_HISTORY_MESSAGES = 18;
const MAX_LEGACY_HISTORY_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 700;
const MAX_BOOTSTRAP_CHARS = 12_000;

function trimText(value, limit = MAX_MESSAGE_CHARS) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function roleLabel(role) {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  return String(role || "Message");
}

function messageText(message) {
  if (!message || typeof message !== "object") return "";
  const candidates = [
    message.content,
    message.text,
    message.message,
    message.record?.assistantText,
    message.record?.user?.text,
  ];
  for (const value of candidates) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  if (Array.isArray(message.contentBlocks)) {
    const text = message.contentBlocks
      .map((block) => block?.text || block?.content || "")
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) return text;
  }
  if (Array.isArray(message.parts)) {
    return message.parts
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text || part.content || "";
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function isOpenCodeBackedMessage(message) {
  if (!message || typeof message !== "object") return false;
  if (message.engineMessageId) return true;
  if (message.meta?.canonicalSource === "opencode") return true;
  if (message.record?.meta?.canonicalSource === "opencode") return true;
  if (message.record?.engineMessageId) return true;
  return false;
}

function formatMessages(messages = []) {
  return messages
    .map((message) => ({ message, text: messageText(message) }))
    .filter((entry) => entry.text)
    .slice(-MAX_HISTORY_MESSAGES)
    .map(({ message, text }) => {
      const failed = message.failed ? " (failed/incomplete)" : "";
      return `- ${roleLabel(message.role)}${failed}: ${trimText(text)}`;
    })
    .join("\n");
}

function splitLegacyAndEngineHistory(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const firstEngineIndex = list.findIndex((message) => message?.role === "assistant" && isOpenCodeBackedMessage(message));
  if (firstEngineIndex < 0) {
    return { legacyMessages: list, engineMessages: [], hasEngineHistory: false };
  }
  return {
    legacyMessages: list.slice(0, firstEngineIndex),
    engineMessages: list.slice(firstEngineIndex),
    hasEngineHistory: true,
  };
}

function hasUsableHistory(messages = []) {
  return messages.some((message) => message?.role && messageText(message));
}

function legacyContextHydrationTarget(session) {
  return String(session?.agentResumeId || "fresh-opencode-session");
}

function shouldHydrateLegacyContext({ session, messages, usedResume }) {
  const { legacyMessages, hasEngineHistory } = splitLegacyAndEngineHistory(messages);
  if (!hasEngineHistory && !usedResume) return false;
  if (!hasUsableHistory(legacyMessages)) return false;
  const target = legacyContextHydrationTarget(session);
  return session?.legacyContextHydratedAgentResumeId !== target;
}

function messagesForLegacyHydration(messages = []) {
  const { legacyMessages, engineMessages } = splitLegacyAndEngineHistory(messages);
  const selected = [];
  selected.push(...legacyMessages.slice(-MAX_LEGACY_HISTORY_MESSAGES));
  if (engineMessages.length > 0) selected.push(...engineMessages.slice(-6));
  return selected;
}

function buildSessionRehydratePrompt({ session, project, userText, summary = null }) {
  const history = formatMessages(session?.messages || []);
  const summaryText = require("./session-memory").formatSessionSummary(summary);
  if (!history && !summaryText) return "";

  const title = trimText(session?.title || require("./session-manager").defaultSessionTitle(), 120);
  const workspaceName = trimText(project?.name || "", 120);
  const workspacePath = trimText(project?.path || "", 300);
  const currentUserText = trimText(userText || "", 1_000);

  const parts = [
    "[Session Resume Notice]",
    "This is a new session resume: the original session could not be resumed or has no resume ID available.",
    "Treat the following content only as background to continue work. Do NOT repeat this notice, and do NOT respond to the \"resume notice\" itself.",
    "If a conclusion or completed item already exists in history, continue directly from it. Do NOT ask the user to re-explain context unless information is truly insufficient.",
    "",
    `Current Lily session: ${title}`,
  ];

  if (workspaceName || workspacePath) {
    parts.push(`Current workspace: ${workspaceName || "(unnamed)"}${workspacePath ? `\nWorkspace path: ${workspacePath}` : ""}`);
  }

  if (summaryText) {
    parts.push("", "Session scroll summary:", summaryText);
  }

  if (history) {
    parts.push("", "Recent session history:", history);
  }

  if (currentUserText) {
    parts.push("", "The actual question the user is sending:", currentUserText);
  }

  parts.push("", "[End resume notice]");

  const text = parts.join("\n");
  return text.length <= MAX_BOOTSTRAP_CHARS ? text : `${text.slice(0, MAX_BOOTSTRAP_CHARS - 1)}…`;
}

function shouldRehydrateSession({ coldStart, usedResume, session, userText, summary = null }) {
  if (!String(userText || "").trim()) return false;
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  if (shouldHydrateLegacyContext({ session, messages, usedResume })) return true;
  if (!coldStart || usedResume) return false;
  if (summary && typeof summary === "object") return true;
  return hasUsableHistory(messages);
}

function withSessionRehydratePrefix({ coldStart, usedResume, session, project, userText, summary = null }) {
  if (!shouldRehydrateSession({ coldStart, usedResume, session, userText, summary })) {
    return { text: userText, rehydrated: false, legacyContextHydrated: false };
  }
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const legacyContextHydrated = shouldHydrateLegacyContext({ session, messages, usedResume });
  const promptSession = legacyContextHydrated
    ? { ...session, messages: messagesForLegacyHydration(messages) }
    : session;
  const bootstrap = buildSessionRehydratePrompt({ session: promptSession, project, userText, summary });
  if (!bootstrap) return { text: userText, rehydrated: false, legacyContextHydrated: false };
  const { addLayersToEngineText } = require("./engine-message-layers");
  return {
    text: addLayersToEngineText(userText, {
      platformContext: bootstrap,
    }),
    rehydrated: true,
    legacyContextHydrated,
  };
}

module.exports = {
  buildSessionRehydratePrompt,
  messageText,
  messagesForLegacyHydration,
  shouldRehydrateSession,
  shouldHydrateLegacyContext,
  withSessionRehydratePrefix,
};
