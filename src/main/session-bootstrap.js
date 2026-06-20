"use strict";

const MAX_HISTORY_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 700;
const MAX_BOOTSTRAP_CHARS = 7_000;

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

function formatMessages(messages = []) {
  return messages
    .filter((message) => message && typeof message.content === "string" && message.content.trim())
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => {
      const failed = message.failed ? " (failed/incomplete)" : "";
      return `- ${roleLabel(message.role)}${failed}: ${trimText(message.content)}`;
    })
    .join("\n");
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
  if (!coldStart || usedResume) return false;
  if (!String(userText || "").trim()) return false;
  if (summary && typeof summary === "object") return true;
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  return messages.some((message) => message?.role && String(message.content || "").trim());
}

function withSessionRehydratePrefix({ coldStart, usedResume, session, project, userText, summary = null }) {
  if (!shouldRehydrateSession({ coldStart, usedResume, session, userText, summary })) {
    return { text: userText, rehydrated: false };
  }
  const bootstrap = buildSessionRehydratePrompt({ session, project, userText, summary });
  if (!bootstrap) return { text: userText, rehydrated: false };
  const { addLayersToEngineText } = require("./engine-message-layers");
  return {
    text: addLayersToEngineText(userText, {
      platformContext: bootstrap,
    }),
    rehydrated: true,
  };
}

module.exports = {
  buildSessionRehydratePrompt,
  shouldRehydrateSession,
  withSessionRehydratePrefix,
};
