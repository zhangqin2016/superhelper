#!/usr/bin/env node
"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

const root = path.join(__dirname, "..");
const capturedQuestionResponses = [];

ipcMain.handle("assistant:question-response", (_event, payload) => {
  capturedQuestionResponses.push(payload);
  return { ok: true };
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(root, "src/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.webContents.on("console-message", (_e, _level, msg) => {
    if (String(msg).includes("does not provide an export")) {
      console.error("CONSOLE:", msg);
    }
  });
  await win.loadFile(path.join(root, "src/renderer/index.html"));
  await new Promise((r) => setTimeout(r, 1500));
  const result = await win.webContents.executeJavaScript(`(
    async () => {
      const results = [];
      for (const spec of [
        "./modules/engine-notice-policy.js",
        "./modules/tool-payload-renderer.js",
        "./modules/turn-view-renderer.js",
        "./modules/session-runtime-store.js",
        "./modules/message.js",
        "./modules/workbench-empty.js",
        "./app.js",
      ]) {
        try {
          await import(spec);
          results.push(spec + ": ok");
        } catch (e) {
          results.push(spec + ": FAIL " + e.message);
        }
      }
      return results.join("\\n");
    }
  )()`);
  console.log(result);
  if (result.includes("FAIL")) {
    app.exitCode = 1;
  } else {
    const liveTurnQueueResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { createLiveTurnArticleShell, renderLiveTurnArticle } = await import("./modules/turn-view-renderer.js");
        const liveTurn = {
          turnId: "turn_queue_regression",
          phase: "tool_running",
          assistantText: "正在处理",
          thinkingText: "",
          contentBlocks: [],
          processEvents: [],
          tools: new Map(),
          timeline: [],
          notices: [],
          permissions: new Map(),
          questions: new Map(),
          hooks: new Map(),
          startedAt: Date.now(),
        };
        const article = createLiveTurnArticleShell(liveTurn);
        renderLiveTurnArticle(article, liveTurn, {
          sessionId: "session_queue_regression",
          queue: [{ id: "queue_1", text: "这条待发送不能出现在任务正文里" }],
        });
        if (article.textContent.includes("这条待发送不能出现在任务正文里")) {
          throw new Error("queued messages leaked into live turn article");
        }
        if (article.querySelector("[data-role='queue']")) {
          throw new Error("live turn article should not own queue UI");
        }
        return "live-turn-queue-regression: ok";
      }
    )()`);
    console.log(liveTurnQueueResult);
    const liveTurnPreserveResult = await win.webContents.executeJavaScript(`(
      async () => {
        const store = (await import("./modules/state.js")).default;
        const { syncCommittedMessages, applyRuntimeEvent } = await import("./modules/session-runtime-store.js");
        const { showSessionMessages, renderConversation } = await import("./modules/message.js");
        const sessionId = "session_live_preserve_regression";
        store.set("activeSessionId", sessionId);
        syncCommittedMessages(sessionId, [
          { role: "user", content: "第一条历史消息", timestamp: "2026-01-01T00:00:00.000Z" },
        ]);
        showSessionMessages(sessionId);
        renderConversation(sessionId, { force: true });
        applyRuntimeEvent({
          sessionId,
          type: "turn.started",
          turnId: "turn_live_preserve_regression",
          ts: Date.now(),
          payload: { text: "正在跑的任务" },
        });
        renderConversation(sessionId);
        syncCommittedMessages(sessionId, [
          { role: "user", content: "第一条历史消息", timestamp: "2026-01-01T00:00:00.000Z" },
          { role: "user", content: "切回来后补进来的历史消息", timestamp: "2026-01-01T00:00:01.000Z" },
        ]);
        renderConversation(sessionId);
        const panel = document.querySelector(\`.session-messages[data-session-id="\${sessionId}"] .runtime-messages\`);
        const children = Array.from(panel?.children || []);
        const liveIndex = children.findIndex((el) => el.classList.contains("assistant-turn-article"));
        const lateIndex = children.findIndex((el) => el.textContent.includes("切回来后补进来的历史消息"));
        if (liveIndex < 0) throw new Error("live turn article was not preserved");
        if (lateIndex < 0) throw new Error("late committed message was not rendered");
        if (lateIndex > liveIndex) {
          throw new Error("late committed message rendered after live turn");
        }
        return "live-turn-preserve-regression: ok";
      }
    )()`);
    console.log(liveTurnPreserveResult);
    const initialConversationResult = await win.webContents.executeJavaScript(`(
      async () => {
        const store = (await import("./modules/state.js")).default;
        const { syncCommittedMessages } = await import("./modules/session-runtime-store.js");
        const { showSessionMessages, renderConversation, shouldPreserveSessionView } = await import("./modules/message.js");
        const sessionId = "session_initial_conversation_regression";
        store.set("activeSessionId", sessionId);
        showSessionMessages(sessionId);
        if (shouldPreserveSessionView(sessionId)) {
          throw new Error("empty session placeholder should not preserve the session view");
        }
        syncCommittedMessages(sessionId, [
          { role: "user", content: "默认会话首次加载的消息", timestamp: "2026-01-01T00:00:00.000Z" },
        ]);
        renderConversation(sessionId, { force: true, forceScrollBottom: true });
        const panel = document.querySelector(\`.session-messages[data-session-id="\${sessionId}"] .runtime-messages\`);
        if (!panel?.textContent.includes("默认会话首次加载的消息")) {
          throw new Error("initial conversation was not rendered");
        }
        return "initial-conversation-regression: ok";
      }
    )()`);
    console.log(initialConversationResult);
    const sameTurnCommittedResult = await win.webContents.executeJavaScript(`(
      async () => {
        const store = (await import("./modules/state.js")).default;
        const { syncCommittedMessages } = await import("./modules/session-runtime-store.js");
        const { showSessionMessages, renderConversation } = await import("./modules/message.js");
        const sessionId = "session_same_turn_committed_regression";
        store.set("activeSessionId", sessionId);
        showSessionMessages(sessionId);
        syncCommittedMessages(sessionId, [
          { role: "user", turnId: "turn_same_key", content: "同一轮用户问题", timestamp: "2026-01-01T00:00:00.000Z" },
          { role: "assistant", turnId: "turn_same_key", content: "同一轮助手回答", timestamp: "2026-01-01T00:00:01.000Z" },
        ]);
        renderConversation(sessionId, { force: true, forceScrollBottom: true });
        const panel = document.querySelector(\`.session-messages[data-session-id="\${sessionId}"] .runtime-messages\`);
        const text = panel?.textContent || "";
        if (!text.includes("同一轮用户问题") || !text.includes("同一轮助手回答")) {
          throw new Error("same-turn committed user and assistant messages must both render");
        }
        return "same-turn-committed-regression: ok";
      }
    )()`);
    console.log(sameTurnCommittedResult);
    const multiSelectQuestionResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { createLiveTurnArticleShell, renderLiveTurnArticle } = await import("./modules/turn-view-renderer.js");
        const liveTurn = {
          turnId: "turn_multiselect_question_regression",
          phase: "tool_running",
          assistantText: "",
          thinkingText: "",
          contentBlocks: [],
          processEvents: [],
          tools: new Map(),
          timeline: [],
          notices: [],
          permissions: new Map(),
          questions: new Map([
            ["req_question_multi", {
              requestId: "req_question_multi",
              questions: [{
                id: "mode",
                question: "Pick modes",
                multiSelect: true,
                options: [{ label: "Fast" }, { label: "Careful" }],
              }],
            }],
          ]),
          hooks: new Map(),
          startedAt: Date.now(),
        };
        const article = createLiveTurnArticleShell(liveTurn);
        document.body.appendChild(article);
        renderLiveTurnArticle(article, liveTurn, { sessionId: "session_multiselect_question_regression" });
        const optionButtons = Array.from(article.querySelectorAll(".assistant-question-option"));
        if (optionButtons.length !== 2) throw new Error("multi-select options did not render");
        optionButtons[0].click();
        optionButtons[1].click();
        await new Promise((resolve) => setTimeout(resolve, 30));
        const submit = article.querySelector(".assistant-prompt-actions .assistant-action-btn");
        if (!submit) throw new Error("multi-select question should render an explicit submit action");
        submit.click();
        await new Promise((resolve) => setTimeout(resolve, 30));
        article.remove();
        return "multi-select-question-regression: ok";
      }
    )()`);
    console.log(multiSelectQuestionResult);
    const markdownRichResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { renderMarkdown, renderMarkdownWithCache } = await import("./modules/markdown.js");
        const fence = String.fromCharCode(96).repeat(3);
        const host = document.createElement("div");
        host.className = "markdown-body";
        document.body.appendChild(host);
        renderMarkdownWithCache(host, [
          fence + "js",
          "console.log('copy me')",
          fence,
          "- [x] 已完成",
        ].join("\\n"));
        if (!host.querySelector(".markdown-code-copy")) {
          throw new Error("code blocks should render a copy action");
        }
        if (!host.querySelector(".markdown-task-list-item")) {
          throw new Error("task list items should receive rich markdown styling");
        }
        const rich = document.createElement("div");
        rich.className = "markdown-body";
        document.body.appendChild(rich);
        await renderMarkdown(rich, [
          "$$E=mc^2$$",
          fence + "mermaid",
          "graph TD",
          "A-->B",
          fence,
        ].join("\\n"));
        if (!rich.querySelector(".katex")) {
          throw new Error("KaTeX math should render in async markdown: " + rich.innerHTML);
        }
        if (!rich.querySelector(".markdown-mermaid svg")) {
          throw new Error("Mermaid blocks should render to SVG: " + rich.innerHTML);
        }
        host.remove();
        rich.remove();
        return "markdown-rich-regression: ok";
      }
    )()`);
    console.log(markdownRichResult);
    const generatedMediaResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { appendToolPayloadDetail, parseGeneratedMedia } = await import("./modules/tool-payload-renderer.js");
        const output = '<generated_media type="image">\\n  <task_id>task_123</task_id>\\n  <file path="/tmp/generated image.png" bytes="1234" />\\n</generated_media>';
        const parsed = parseGeneratedMedia(output);
        if (parsed.length !== 1 || parsed[0].type !== "image" || parsed[0].files[0].path !== "/tmp/generated image.png") {
          throw new Error("generated media parser did not extract image file");
        }
        const container = document.createElement("details");
        document.body.appendChild(container);
        const rendered = appendToolPayloadDetail(container, {
          name: "Bash",
          result: { content: output },
        }, { role: "result" });
        const img = container.querySelector(".assistant-generated-media img");
        if (!rendered || !img) {
          throw new Error("generated media result did not render image preview");
        }
        if (!String(img.getAttribute("src") || "").startsWith("file:///tmp/generated")) {
          throw new Error("generated media preview should use a file URL: " + img.getAttribute("src"));
        }
        if (container.textContent.includes("<generated_media")) {
          throw new Error("raw generated_media XML should not be shown to the user");
        }
        container.remove();
        return "generated-media-preview-regression: ok";
      }
    )()`);
    console.log(generatedMediaResult);
    if (capturedQuestionResponses.length !== 1) {
      throw new Error(`multi-select should submit exactly once, got ${capturedQuestionResponses.length}`);
    }
    const questionPayload = capturedQuestionResponses[0];
    if (questionPayload.requestId !== "req_question_multi") {
      throw new Error(`wrong request id submitted: ${questionPayload.requestId}`);
    }
    if (!Array.isArray(questionPayload.answers?.mode) || questionPayload.answers.mode.join(",") !== "Fast,Careful") {
      throw new Error(`multi-select answers should submit an array: ${JSON.stringify(questionPayload.answers)}`);
    }
    if (questionPayload.response !== "Fast\nCareful") {
      throw new Error(`multi-select response summary should include selected values: ${questionPayload.response}`);
    }
    console.log("test-renderer-import: ok");
  }
  app.quit();
});
