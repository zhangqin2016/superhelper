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
  if (role === "user") return "用户";
  if (role === "assistant") return "助手";
  return String(role || "消息");
}

function formatMessages(messages = []) {
  return messages
    .filter((message) => message && typeof message.content === "string" && message.content.trim())
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => {
      const failed = message.failed ? "（失败/未完成）" : "";
      return `- ${roleLabel(message.role)}${failed}: ${trimText(message.content)}`;
    })
    .join("\n");
}

function buildSessionRehydratePrompt({ session, project, userText, summary = null }) {
  const history = formatMessages(session?.messages || []);
  const summaryText = require("./session-memory").formatSessionSummary(summary);
  if (!history && !summaryText) return "";

  const title = trimText(session?.title || "默认对话", 120);
  const workspaceName = trimText(project?.name || "", 120);
  const workspacePath = trimText(project?.path || "", 300);
  const currentUserText = trimText(userText || "", 1_000);

  const parts = [
    "【会话恢复说明】",
    "这是一次 Claude CLI 新会话恢复：原 Claude CLI 会话无法 resume 或没有可用 resume id。",
    "请把下面内容只当作继续当前工作的背景，不要复述这段说明，不要回答“恢复说明”本身。",
    "如果历史里已有结论或已完成事项，请直接在此基础上继续；不要要求用户重新解释上下文，除非信息确实不足。",
    "",
    `当前 Lily 会话：${title}`,
  ];

  if (workspaceName || workspacePath) {
    parts.push(`当前工作区：${workspaceName || "(未命名)"}${workspacePath ? `\n工作区路径：${workspacePath}` : ""}`);
  }

  if (summaryText) {
    parts.push("", "会话滚动摘要：", summaryText);
  }

  if (history) {
    parts.push("", "最近会话记录：", history);
  }

  if (currentUserText) {
    parts.push("", "用户本次真正要发送的问题：", currentUserText);
  }

  parts.push("", "【恢复说明结束】");

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
  return {
    text: `${bootstrap}\n\n${String(userText || "").trim()}`,
    rehydrated: true,
  };
}

module.exports = {
  buildSessionRehydratePrompt,
  shouldRehydrateSession,
  withSessionRehydratePrefix,
};
