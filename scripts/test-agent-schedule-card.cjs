"use strict";
/**
 * A schedule the agent proposed shows its confirmation card UNDER the answer
 * it came with; a card from the pre-engine check still stands in for the
 * answer. Field case 2026-09-29: the model said a "自动执行" card would appear
 * and none did — it had no way to propose one.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");
const { exitAndRemove } = require("./electron-test-cleanup.cjs");

if (!app?.whenReady) { console.error("Run with Electron: electron scripts/test-agent-schedule-card.cjs"); process.exit(2); }
const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-schedule-card-"));
app.setPath("userData", path.join(dir, "userData"));
app.disableHardwareAcceleration();
let win;
const timer = setTimeout(() => { console.error("test-agent-schedule-card timed out"); exitAndRemove({ app, window: win, directory: dir, timer: null, code: 1 }); }, 40_000);
const mod = (name) => pathToFileURL(path.join(ROOT, "src/renderer/modules", name)).href;

app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { sandbox: false, contextIsolation: false } });
    win.webContents.on("console-message", (_e, level, msg) => { if (level >= 3 && !/No handler registered/.test(msg)) console.error("CONSOLE:", msg); });
    await win.loadFile(path.join(ROOT, "src/renderer/index.html"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await win.webContents.executeJavaScript(`(async () => { try {
      const store = await import(${JSON.stringify(mod("session-runtime-store.js"))});
      const message = await import(${JSON.stringify(mod("message.js"))});
      const draft = (source, originalText, title, scheduleText) => ({ status: "pending", ...(source ? { source } : {}), originalText,
        draft: { title, prompt: title, scheduleText, nextRunAt: "2026-09-30T10:05:00.000Z" } });
      const answer = "小米汽车 8 月交付超 30,000 台。已为你生成定时任务确认卡，确认后生效。";
      store.syncCommittedMessages("s_card", [
        { id: "u1", role: "user", content: "没五分钟查看小米汽车销量", turnId: "t1" },
        { id: "a1", role: "assistant", content: answer, turnId: "t1",
          record: { turnId: "t1", terminal: "turn.completed", assistantText: answer, startedAt: 1, endedAt: 2 },
          meta: { scheduledDraft: { ...draft("agent_tool", "没五分钟查看小米汽车销量", "小米汽车销量", "每 5 分钟"), withAnswer: true } } },
        { id: "u2", role: "user", content: "每天9点提醒我喝水", turnId: "t2" },
        { id: "a2", role: "assistant", content: "I understand this as an automated task. Please confirm to create it.", turnId: "t2",
          meta: { scheduledDraft: draft("", "每天9点提醒我喝水", "喝水提醒", "每天 09:00") } },
      ]);
      message.showSessionMessages("s_card");
      message.renderConversation("s_card", { force: true });
      await new Promise((r) => setTimeout(r, 200));
      const articles = [...document.querySelectorAll('article')];
      const byTurn = (turnId) => articles.find((a) => a.dataset.turnId === turnId && a.classList.contains("assistant-turn-article"));
      const agent = byTurn("t1"), local = byTurn("t2");
      return {
        agentText: agent?.textContent.includes("8 月交付超 30,000 台") || false,
        agentCard: Boolean(agent?.querySelector(".scheduled-draft-chat-card .button-primary")),
        cardAfterAnswer: agent ? agent.textContent.indexOf("30,000") < agent.textContent.indexOf("小米汽车销量") : false,
        localIsCard: Boolean(local?.classList.contains("scheduled-draft-article") && local.querySelector(".scheduled-draft-chat-card")),
        localHasNoAnswerBody: !local?.textContent.includes("I understand this as an automated task"),
      };
    } catch (error) { return { error: String(error?.stack || error) }; } })()`);
    const failures = [];
    if (result.error) failures.push(result.error);
    if (!result.agentText) failures.push("the agent's answer must still render");
    if (!result.agentCard) failures.push("an agent-proposed schedule shows its confirmation card with the answer");
    if (!result.cardAfterAnswer) failures.push("the card comes after the answer");
    if (!result.localIsCard) failures.push("a pre-engine draft still renders as the card article");
    if (!result.localHasNoAnswerBody) failures.push("a pre-engine card stands in for its placeholder text");
    if (failures.length) throw new Error(failures.join("\n") + "\n" + JSON.stringify(result));
    console.log("test-agent-schedule-card: ok");
    exitAndRemove({ app, window: win, directory: dir, timer, code: 0 });
  } catch (error) {
    console.error(error);
    exitAndRemove({ app, window: win, directory: dir, timer, code: 1 });
  }
});
