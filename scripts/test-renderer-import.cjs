#!/usr/bin/env node
"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

const root = path.join(__dirname, "..");
const capturedQuestionResponses = [];
const capturedRevealPaths = [];

ipcMain.handle("assistant:question-response", (_event, payload) => {
  capturedQuestionResponses.push(payload);
  return { ok: true };
});

ipcMain.handle("filetree:reveal", (_event, payload) => {
  capturedRevealPaths.push(`${payload?.sessionId || ""}:${payload?.filePath || ""}`);
  return { ok: true };
});

ipcMain.handle("apps:catalog", () => ({
  ok: true,
  json: {
    apps: [
      {
        id: "stock-starter",
        name: "Stock Starter",
        latestVersion: "1.0.0",
        category: "finance",
        appType: "dashboard",
        riskLevel: "medium",
        sizeBytes: 1024,
        summary: "A stock analysis workspace app",
        downloadUrl: "https://cdn.example.com/stock.zip",
        installed: false,
        requiredRuntimePacks: [],
        requiredSkillPackages: [],
        tags: [],
      },
      {
        id: "installed-app",
        name: "Installed App",
        latestVersion: "1.0.0",
        category: "finance",
        appType: "dashboard",
        riskLevel: "low",
        sizeBytes: 2048,
        summary: "An installed workspace app",
        installed: true,
        installedAvailable: true,
        installedPath: "/tmp/Lily Apps/Installed App",
        installedCount: 2,
        updateAvailable: false,
        requiredRuntimePacks: [],
        requiredSkillPackages: [],
        tags: [],
      },
    ],
  },
}));

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
    const skillSettingsPresetResult = await win.webContents.executeJavaScript(`(
      () => {
        const page = document.getElementById("settingsPageSkills");
        if (!page) throw new Error("skills settings page should exist");
        if (page.querySelector("#skillsPresetList, .skills-preset-list, .skills-preset-card")) {
          throw new Error("skills settings should not show capability pack preset cards");
        }
        return "skill-settings-no-preset-cards: ok";
      }
    )()`);
    console.log(skillSettingsPresetResult);
    const liveTurnQueueResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { createLiveTurnArticleShell, renderLiveTurnArticle } = await import("./modules/turn-view-renderer.js");
        const queueArea = document.getElementById("messageQueueArea");
        const composerRow = document.querySelector("#composer .composer-row");
        if (!queueArea || !composerRow || queueArea.compareDocumentPosition(composerRow) !== Node.DOCUMENT_POSITION_FOLLOWING) {
          throw new Error("message queue area should sit above the composer input row");
        }
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
        renderLiveTurnArticle(article, liveTurn, { sessionId: "session_multiselect_question_regression" });
        const selectedAfterRerender = Array.from(article.querySelectorAll(".assistant-question-option.is-selected"))
          .map((btn) => btn.textContent)
          .join(",");
        if (selectedAfterRerender !== "Fast,Careful") {
          throw new Error("question selections should survive live turn rerender: " + selectedAfterRerender);
        }
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
    const sealedTurnLayoutResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { liveTurnFromRecord, renderSealedTurnArticle } = await import("./modules/turn-view-renderer.js");
        const turn = liveTurnFromRecord({
          turnId: "turn_sealed_layout_regression",
          terminal: "turn.completed",
          assistantText: "先说过程。\\n\\n最终答案。",
          startedAt: 1000,
          endedAt: 5000,
          timeline: [
            { kind: "text", id: "text_1", ts: 1000, text: "先说过程。", status: "done" },
            { kind: "thinking", id: "think_1", startTs: 1100, ts: 2100, text: "分析中", status: "done" },
            { kind: "tool", id: "read_1", ts: 2200, name: "Read", input: { file_path: "a.md" }, status: "done" },
            { kind: "text", id: "text_2", ts: 3000, text: "最终答案。", status: "done" },
          ],
        });
        const article = renderSealedTurnArticle(turn, false);
        document.body.appendChild(article);
        const process = article.querySelector("[data-role='process']");
        const narrative = article.querySelector("[data-role='narrative']");
        if (!process || !narrative) throw new Error("sealed article missing core regions");
        const order = process.compareDocumentPosition(narrative);
        article.remove();
        if (!(order & Node.DOCUMENT_POSITION_FOLLOWING)) {
          throw new Error("sealed process details must render before the answer after reload");
        }
        return "sealed-turn-layout-regression: ok";
      }
    )()`);
    console.log(sealedTurnLayoutResult);
    const thinkingStackResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { liveTurnFromRecord, renderSealedTurnArticle } = await import("./modules/turn-view-renderer.js");
        const turn = liveTurnFromRecord({
          turnId: "turn_thinking_stack_regression",
          terminal: "turn.completed",
          assistantText: "完成。",
          startedAt: 1000,
          endedAt: 9000,
          timeline: [
            { kind: "thinking", id: "think_1", startTs: 1000, ts: 2000, text: "第一段思考", status: "done" },
            { kind: "thinking", id: "think_2", startTs: 2100, ts: 5100, text: "第二段思考", status: "done" },
            { kind: "thinking", id: "think_3", startTs: 5200, ts: 8200, text: "第三段思考", status: "done" },
            { kind: "text", id: "text_1", ts: 8300, text: "完成。", status: "done" },
          ],
        });
        const article = renderSealedTurnArticle(turn, false);
        document.body.appendChild(article);
        const process = article.querySelector("[data-role='process']");
        const stack = process?.querySelector(".assistant-process-thinking-stack");
        if (!stack) throw new Error("sealed multi-thinking turn should render one thinking stack");
        if (stack.open) throw new Error("sealed thinking stack should be collapsed by default");
        const topThinkingRows = Array.from(process.querySelector(".assistant-turn-timeline")?.children || [])
          .filter((el) => el.classList.contains("assistant-process-thinking-group"));
        article.remove();
        if (topThinkingRows.length !== 1 || topThinkingRows[0] !== stack) {
          throw new Error("sealed thinking entries should not flood the top-level process timeline");
        }
        return "thinking-stack-regression: ok";
      }
    )()`);
    console.log(thinkingStackResult);
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
        const pathShell = document.createElement("div");
        pathShell.dataset.sessionId = "session_markdown_reveal";
        document.body.appendChild(pathShell);
        const pathHost = document.createElement("div");
        pathHost.className = "markdown-body";
        pathShell.appendChild(pathHost);
        renderMarkdownWithCache(pathHost, "已生成文件：/tmp/lily-output/generated image.png");
        const localPathLink = pathHost.querySelector(".markdown-local-file-link[data-local-file-path]");
        if (!localPathLink || localPathLink.dataset.localFilePath !== "/tmp/lily-output/generated image.png") {
          throw new Error("plain local file paths should become reveal links: " + pathHost.innerHTML);
        }
        localPathLink.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
        renderMarkdownWithCache(pathHost, "[打开图片](file:///C:/Users/lily/generated-assets/image.png)");
        const windowsFileUrlLink = pathHost.querySelector(".markdown-local-file-link[data-local-file-path]");
        if (!windowsFileUrlLink || windowsFileUrlLink.dataset.localFilePath !== "file:///C:/Users/lily/generated-assets/image.png") {
          throw new Error("Windows file URLs should be passed to main as file URLs, got: " + pathHost.innerHTML);
        }
        windowsFileUrlLink.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
        renderMarkdownWithCache(pathHost, "已保存到：generated-assets/image-1-2026.png");
        const relativePathLink = pathHost.querySelector('.markdown-local-file-link[data-local-file-path="generated-assets/image-1-2026.png"]');
        if (relativePathLink) {
          throw new Error("relative generated-assets paths should not become reveal links: " + pathHost.innerHTML);
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
        pathShell.remove();
        rich.remove();
        return "markdown-rich-regression: ok";
      }
    )()`);
    console.log(markdownRichResult);
    if (!capturedRevealPaths.includes("session_markdown_reveal:/tmp/lily-output/generated image.png")) {
      throw new Error("local file path click should reveal in folder, got: " + capturedRevealPaths.join(","));
    }
    if (!capturedRevealPaths.includes("session_markdown_reveal:file:///C:/Users/lily/generated-assets/image.png")) {
      throw new Error("Windows file URL click should reveal via file URL, got: " + capturedRevealPaths.join(","));
    }
    if (capturedRevealPaths.some((path) => path.includes("generated-assets/image-1-2026.png"))) {
      throw new Error("relative generated path should not reveal, got: " + capturedRevealPaths.join(","));
    }
    const generatedMediaResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { appendToolPayloadDetail, parseGeneratedMedia } = await import("./modules/tool-payload-renderer.js");
        const output = '<generated_media type="image">\\n  <task_id>task_123</task_id>\\n  <file path="/tmp/generated image.png" bytes="1234" />\\n  <file path="generated-assets/image-1-2026.png" bytes="1234" />\\n</generated_media>';
        const parsed = parseGeneratedMedia(output);
        if (parsed.length !== 1 || parsed[0].type !== "image" || parsed[0].files[0].path !== "/tmp/generated image.png") {
          throw new Error("generated media parser did not extract image file");
        }
        const container = document.createElement("details");
        document.body.appendChild(container);
        const rendered = appendToolPayloadDetail(container, {
          name: "Bash",
          result: { content: output },
        }, { role: "result", sessionId: "session_media_reveal" });
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
        const absolutePath = [...container.querySelectorAll(".assistant-generated-media code")]
          .find((node) => node.textContent === "/tmp/generated image.png");
        if (!absolutePath || !absolutePath.classList.contains("is-clickable")) {
          throw new Error("absolute generated media path should be clickable");
        }
        absolutePath.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
        const relativePath = [...container.querySelectorAll(".assistant-generated-media code")]
          .find((node) => node.textContent === "generated-assets/image-1-2026.png");
        if (!relativePath) {
          throw new Error("relative generated media path should be rendered");
        }
        if (relativePath.classList.contains("is-clickable")) {
          throw new Error("relative generated media path should not be clickable");
        }
        container.remove();
        return "generated-media-preview-regression: ok";
      }
    )()`);
    console.log(generatedMediaResult);
    if (!capturedRevealPaths.includes("session_media_reveal:/tmp/generated image.png")) {
      throw new Error("absolute generated media path should reveal, got: " + capturedRevealPaths.join(","));
    }
    if (capturedRevealPaths.some((path) => path.includes("generated-assets/image-1-2026.png"))) {
      throw new Error("relative generated media path should not reveal, got: " + capturedRevealPaths.join(","));
    }
    const generatedFileImageResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { appendToolPayloadDetail } = await import("./modules/tool-payload-renderer.js");
        const container = document.createElement("details");
        document.body.appendChild(container);
        const rendered = appendToolPayloadDetail(container, {
          name: "Bash",
          result: { content: JSON.stringify({ ok: true, output: "/tmp/out/icon.svg" }) },
        }, { role: "result", sessionId: "session_generated_file_image" });
        const img = container.querySelector(".assistant-generated-file-preview img");
        if (!rendered || !img) {
          throw new Error("generated SVG output should render an image preview: " + container.innerHTML);
        }
        if (!String(img.getAttribute("src") || "").startsWith("file:///tmp/out/icon.svg")) {
          throw new Error("generated SVG preview should use a file URL: " + img.getAttribute("src"));
        }
        const path = container.querySelector(".assistant-generated-file-preview code.is-clickable");
        if (!path || path.textContent !== "/tmp/out/icon.svg") {
          throw new Error("generated SVG preview should keep a clickable reveal path");
        }
        path.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
        container.remove();
        return "generated-file-svg-preview-regression: ok";
      }
    )()`);
    console.log(generatedFileImageResult);
    if (!capturedRevealPaths.includes("session_generated_file_image:/tmp/out/icon.svg")) {
      throw new Error("generated SVG output path should reveal, got: " + capturedRevealPaths.join(","));
    }
    const workspaceAppInstallUxResult = await win.webContents.executeJavaScript(`(
      async () => {
        const { refreshWorkspaceApps } = await import("./modules/workspace-apps.js");
        const list = document.getElementById("workspaceAppsList");
        if (!list) throw new Error("workspace app list should exist");
        await refreshWorkspaceApps();
        const text = list.textContent || "";
        if (!text.includes("Create workspace") && !text.includes("创建工作空间")) {
          throw new Error("install action should be framed as creating a workspace");
        }
        if (!text.includes("/tmp/Lily Apps/Installed App")) {
          throw new Error("installed app card should show its workspace path");
        }
        if (!text.includes("Show in folder") && !text.includes("在文件夹中显示")) {
          throw new Error("installed app card should expose a reveal-in-folder action");
        }
        if (!text.includes("New workspace") && !text.includes("新建工作空间")) {
          throw new Error("installed app card should allow creating another workspace instance");
        }
        if (!text.includes("2 workspaces") && !text.includes("2 个工作空间")) {
          throw new Error("installed app card should show multiple workspace instances");
        }
        return "workspace-app-install-ux: ok";
      }
    )()`);
    console.log(workspaceAppInstallUxResult);
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
