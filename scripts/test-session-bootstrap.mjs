#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildSessionRehydratePrompt,
  shouldRehydrateSession,
  withSessionRehydratePrefix,
} = require("../src/main/session-bootstrap.js");

const session = {
  title: "默认对话",
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
if (shouldRehydrateSession({ coldStart: true, usedResume: true, session, userText: "继续" })) {
  throw new Error("resume runner must not rehydrate");
}
if (shouldRehydrateSession({ coldStart: true, usedResume: false, session: { messages: [] }, userText: "继续" })) {
  throw new Error("new empty session must not rehydrate");
}
if (!shouldRehydrateSession({ coldStart: true, usedResume: false, session, userText: "继续" })) {
  throw new Error("cold start without resume and existing history should rehydrate");
}

const prompt = buildSessionRehydratePrompt({ session, project, userText: "继续刚才的方案" });
if (!prompt.includes("Claude CLI 新会话恢复") || !prompt.includes("lily-workbench") || !prompt.includes("继续刚才的方案")) {
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
if (!summaryPrompt.includes("会话滚动摘要") || !summaryPrompt.includes("继续第二章") || !summaryPrompt.includes("第1章.md")) {
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
if (!prefixed.rehydrated || !prefixed.text.includes("【恢复说明结束】") || !prefixed.text.endsWith("继续刚才的方案")) {
  throw new Error(`rehydrate prefix failed: ${JSON.stringify(prefixed)}`);
}

console.log("session-bootstrap: ok");
