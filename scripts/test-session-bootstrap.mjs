#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildSessionRehydratePrompt,
  messagesForLegacyHydration,
  shouldRehydrateSession,
  shouldHydrateLegacyContext,
  withSessionRehydratePrefix,
} = require("../src/main/session-bootstrap.js");

const session = {
  title: "默认对话",
  agentResumeId: "ses_existing",
  messages: [
    { role: "user", content: "帮我分析这个项目的自动更新方案" },
    { role: "assistant", content: "我们需要保留 Claude CLI 会话，失败时再恢复。" },
  ],
};
const project = {
  name: "lily-workbench",
  path: "/Users/example/lily-workbench",
};

if (shouldRehydrateSession({ coldStart: false, usedResume: false, session, userText: "继续" })) {
  throw new Error("active runner must not rehydrate");
}
if (!shouldRehydrateSession({ coldStart: true, usedResume: true, session, userText: "继续" })) {
  throw new Error("resume runner with unhydrated legacy history should rehydrate once");
}
if (shouldRehydrateSession({
  coldStart: true,
  usedResume: true,
  session: { ...session, legacyContextHydratedAgentResumeId: "ses_existing" },
  userText: "继续",
})) {
  throw new Error("resume runner with already hydrated legacy history must not rehydrate");
}
if (shouldRehydrateSession({ coldStart: true, usedResume: false, session: { messages: [] }, userText: "继续" })) {
  throw new Error("new empty session must not rehydrate");
}
if (!shouldRehydrateSession({ coldStart: true, usedResume: false, session, userText: "继续" })) {
  throw new Error("cold start without resume and existing history should rehydrate");
}

const prompt = buildSessionRehydratePrompt({ session, project, userText: "继续刚才的方案" });
if (
  !prompt.includes("[Session Resume Notice]") ||
  !prompt.includes("Current workspace: lily-workbench") ||
  !prompt.includes("Workspace path: /Users/example/lily-workbench") ||
  !prompt.includes("The actual question the user is sending:") ||
  !prompt.includes("继续刚才的方案")
) {
  throw new Error(`rehydrate prompt missing expected context: ${prompt}`);
}

const summaryPrompt = buildSessionRehydratePrompt({
  session: { title: "默认对话", messages: [] },
  project,
  userText: "继续",
  summary: {
    lastUserIntent: "重写前三章",
    lastAssistantResult: "已经完成第一章",
    pendingTask: "继续第二章",
    recentUserIntents: ["对比风格", "重写前三章"],
    recentFiles: ["第1章.md"],
  },
});
if (!summaryPrompt.includes("Session scroll summary") || !summaryPrompt.includes("继续第二章") || !summaryPrompt.includes("第1章.md")) {
  throw new Error(`summary rehydrate prompt missing expected context: ${summaryPrompt}`);
}
if (!shouldRehydrateSession({
  coldStart: true,
  usedResume: false,
  session: { messages: [] },
  summary: { lastUserIntent: "继续项目" },
  userText: "继续",
})) {
  throw new Error("summary alone should allow cold-start rehydrate");
}

const prefixed = withSessionRehydratePrefix({
  coldStart: true,
  usedResume: false,
  session,
  project,
  userText: "继续刚才的方案",
});
if (
  !prefixed.rehydrated ||
  !prefixed.text.includes("[End resume notice]") ||
  !prefixed.text.includes('title="platform_context"') ||
  !prefixed.text.includes('title="user_original_request"') ||
  !prefixed.text.includes("Highest priority") ||
  !prefixed.text.includes("继续刚才的方案")
) {
  throw new Error(`rehydrate prefix failed: ${JSON.stringify(prefixed)}`);
}

const mixedHistorySession = {
  title: "旧会话",
  agentResumeId: "ses_legacy_needs_context",
  messages: [
    { role: "user", content: "以前我说项目要做股票应用闭环" },
    { role: "assistant", content: "已经确定用 TradingAgents 改造成平台应用。" },
    { role: "user", content: "后来我又说不要让用户配置 key" },
    {
      role: "assistant",
      content: "新引擎回答过一轮",
      meta: { canonicalSource: "opencode", lilyStorageRole: "metadata" },
      record: { engineMessageId: "msg_engine_1" },
    },
    { role: "user", content: "继续" },
  ],
};
if (!shouldHydrateLegacyContext({
  session: mixedHistorySession,
  messages: mixedHistorySession.messages,
  usedResume: true,
})) {
  throw new Error("legacy history before first opencode turn should hydrate once");
}
const selected = messagesForLegacyHydration(mixedHistorySession.messages);
if (
  !selected.some((message) => message.content?.includes("股票应用闭环")) ||
  !selected.some((message) => message.content?.includes("新引擎回答过一轮"))
) {
  throw new Error(`legacy hydration selection missed expected context: ${JSON.stringify(selected)}`);
}
const legacyPrefixed = withSessionRehydratePrefix({
  coldStart: false,
  usedResume: true,
  session: mixedHistorySession,
  project,
  userText: "继续历史里的股票应用",
});
if (
  !legacyPrefixed.rehydrated ||
  !legacyPrefixed.legacyContextHydrated ||
  !legacyPrefixed.text.includes("股票应用闭环") ||
  !legacyPrefixed.text.includes("新引擎回答过一轮")
) {
  throw new Error(`legacy context rehydrate failed: ${JSON.stringify(legacyPrefixed)}`);
}
if (shouldHydrateLegacyContext({
  session: { ...mixedHistorySession, legacyContextHydratedAgentResumeId: "ses_legacy_needs_context" },
  messages: mixedHistorySession.messages,
  usedResume: true,
})) {
  throw new Error("legacy hydration marker should suppress duplicate context injection");
}

console.log("session-bootstrap: ok");
