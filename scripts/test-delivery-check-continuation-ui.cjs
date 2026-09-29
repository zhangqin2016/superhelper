"use strict";
/**
 * A delivery-check round reads as part of the answer it checks: no second
 * "Lily" speaker, a quiet 交付检查 divider, the answer itself untouched, and
 * the internal prompt never shown. Field case 2026-09-30: the check ran as a
 * second full answer under the first, both saying "已完成…". History comes
 * from the real reader (opencode-conversation-source) — a check recorded the
 * old way (superseding the answer) included; the live round too.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");
const { exitAndRemove } = require("./electron-test-cleanup.cjs");

if (!app?.whenReady) { console.error("Run with Electron: electron scripts/test-delivery-check-continuation-ui.cjs"); process.exit(2); }
const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-check-ui-"));
app.setPath("userData", path.join(dir, "userData"));
app.disableHardwareAcceleration();
let win;
const timer = setTimeout(() => { console.error("test-delivery-check-continuation-ui timed out"); exitAndRemove({ app, window: win, directory: dir, timer: null, code: 1 }); }, 40_000);
const mod = (name) => pathToFileURL(path.join(ROOT, "src/renderer/modules", name)).href;
const { getConversationPageFromSource } = require("../src/main/opencode-conversation-source.js");

async function storedHistory() {
  // The prompt as rounds before the tag stored it (no <lily_internal_prompt>).
  const prompt = "[系统文档交付续检] 这是对刚生成文件的一次内部续接，不是让你从头重做原任务。\n请继续完成当前文档的交付验收。\n待验文件：\n- /w/output/04-报告.docx\n必须完成：\n1. 先调用 lily_capability_status";
  const at = (ms) => new Date(Date.parse("2026-09-30T01:47:48Z") + ms).toISOString();
  const record = (turnId, text, meta = {}) => ({ turnId, assistantText: text, startedAt: 1, endedAt: 2, durationMs: 445000, meta: { terminal: "turn.completed", ...meta } });
  const first = "已完成。交付物：04-中国新能源汽车市场分析报告.docx、06-市场数据看板.html。来源：中汽协、乘联分会。";
  const check = "已补做视觉检查：docx 6 页逐页查看，未发现溢出或乱码。";
  const host = [
    { id: "u1", role: "user", content: "生成个超级复杂的任务", turnId: "t1", timestamp: at(0) },
    // Recorded the old way: the check superseded the answer.
    { id: "a1", role: "assistant", content: first, turnId: "t1", timestamp: at(445000), record: record("t1", first), meta: { superseded: true, supersededByTurnId: "t2" } },
    { id: "a2", role: "assistant", content: check, turnId: "t2", timestamp: at(551000), record: record("t2", check) },
  ];
  const projections = [
    { id: "projection:t2:user", role: "user", content: prompt, turnId: "t2", timestamp: at(446000), meta: { projected: true } },
  ];
  const ctx = { sessionManager: {
    findById: () => ({ id: "s_check", projectId: "p1", agentResumeId: "" }),
    getConversationPageAsync: async () => ({ ok: true, conversation: host.map((m) => ({ ...m })), hasMore: false, total: host.length }),
    getProjectedConversation: () => projections,
  }, runnerPool: { get: () => null } };
  return (await getConversationPageFromSource(ctx, "s_check", {})).conversation;
}

app.whenReady().then(async () => {
  try {
    const conversation = await storedHistory();
    win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { sandbox: false, contextIsolation: false } });
    win.webContents.on("console-message", (_e, level, msg) => { if (level >= 3 && !/No handler registered/.test(msg)) console.error("CONSOLE:", msg); });
    await win.loadFile(path.join(ROOT, "src/renderer/index.html"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await win.webContents.executeJavaScript(`(async () => { try {
      const store = await import(${JSON.stringify(mod("session-runtime-store.js"))});
      const message = await import(${JSON.stringify(mod("message.js"))});
      store.syncCommittedMessages("s_check", ${JSON.stringify(conversation)});
      message.showSessionMessages("s_check");
      message.renderConversation("s_check", { force: true });
      await new Promise((r) => setTimeout(r, 200));
      const article = (turnId) => [...document.querySelectorAll("article.assistant-turn-article")].find((a) => a.dataset.turnId === turnId);
      const shown = (el) => Boolean(el) && getComputedStyle(el).display !== "none";
      const first = article("t1"), check = article("t2");
      const sealed = {
        firstText: first?.textContent.includes("来源：中汽协") || false,
        firstSpeaker: shown(first?.querySelector(".assistant-turn-speaker")),
        firstIsContinuation: first?.classList.contains("is-continuation") || false,
        checkIsContinuation: check?.classList.contains("is-continuation") || false,
        checkSpeaker: shown(check?.querySelector(".assistant-turn-speaker")),
        label: check ? getComputedStyle(check, "::before").content : "",
        promptShown: [...document.querySelectorAll(".runtime-user-message")].some((el) => el.textContent.includes("系统文档交付续检")),
        order: first && check ? Boolean(first.compareDocumentPosition(check) & Node.DOCUMENT_POSITION_FOLLOWING) : false,
      };
      store.applyRuntimeEvent({ id: "l1", type: "turn.started", sessionId: "s_check", turnId: "t3", seq: 1, ts: Date.now(), source: "test", payload: { text: "", continuesTurnId: "t2" } });
      store.applyRuntimeEvent({ id: "l2", type: "assistant.delta", sessionId: "s_check", turnId: "t3", seq: 2, ts: Date.now(), source: "test", payload: { text: "正在复查第 3 页…" } });
      message.renderConversation("s_check", { force: true });
      await new Promise((r) => setTimeout(r, 200));
      const live = article("t3");
      return { sealed, liveIsContinuation: live?.classList.contains("is-continuation") || false, liveSpeaker: shown(live?.querySelector(".assistant-turn-speaker")) };
    } catch (error) { return { error: String(error?.stack || error) }; } })()`);
    const failures = [];
    const s = result.sealed || {};
    if (result.error) failures.push(result.error);
    if (!s.firstText) failures.push("the answer the check continues is shown whole (a check recorded as superseding it included)");
    if (!s.firstSpeaker || s.firstIsContinuation) failures.push("the answer keeps its speaker");
    if (!s.checkIsContinuation || s.checkSpeaker) failures.push("the check has no second speaker");
    if (!/交付检查|Delivery check|فحص التسليم/.test(s.label || "")) failures.push(`the check is labelled (got ${s.label})`);
    if (s.promptShown) failures.push("the internal check prompt is never shown");
    if (!s.order) failures.push("the check follows the answer");
    if (!result.liveIsContinuation || result.liveSpeaker) failures.push("a running check is drawn as a continuation too");
    const shot = process.env.LILY_UI_SHOT;
    if (shot) fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
    if (failures.length) throw new Error(failures.join("\n") + "\n" + JSON.stringify(result));
    console.log("test-delivery-check-continuation-ui: ok");
    exitAndRemove({ app, window: win, directory: dir, timer, code: 0 });
  } catch (error) {
    console.error(error);
    exitAndRemove({ app, window: win, directory: dir, timer, code: 1 });
  }
});
