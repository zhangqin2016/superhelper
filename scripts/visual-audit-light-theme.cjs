#!/usr/bin/env node
"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "tmp", "visual-audit", "light-theme");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writePng(name, image) {
  const filePath = path.join(outDir, name);
  fs.writeFileSync(filePath, image.toPNG());
  return filePath;
}

function registerNoopHandlers() {
  const handle = (channel, fn) => {
    try {
      ipcMain.handle(channel, fn);
    } catch {
      // Test harness may already have registered it in reused Electron runs.
    }
  };
  handle("notifications:get", () => ({ ok: true, notifications: [] }));
  handle("app:get-locale", () => ({ ok: true, locale: "zh-CN" }));
  handle("app:get-version", () => ({ ok: true, version: "0.0.0-visual" }));
  handle("app:get-icon-url", () => ({ ok: true, url: "" }));
  handle("assistant:feature-flags", () => ({ ok: true, flags: {} }));
  handle("app:get-policy", () => ({ ok: true, policy: {} }));
  handle("media-providers:list", () => ({ ok: true, providers: [] }));
  handle("web-credentials:list", () => ({ ok: true, credentials: [] }));
  handle("session:get-skills", () => ({ ok: true, skills: [] }));
  handle("session:get-permission", () => ({ ok: true, permission: "default" }));
  handle("updates:get-state", () => ({ ok: true, state: { phase: "idle" } }));
  handle("updates:get-settings", () => ({ ok: true, settings: { autoCheck: true } }));
  handle("updates:check", () => ({ ok: true, hasUpdate: false }));
  handle("updates:kick-check", () => ({ ok: true }));
  handle("state:full", () => ({ ok: true, state: {} }));
  handle("account:get-state", () => ({ ok: true, account: null }));
  handle("license:get-state", () => ({ ok: true, license: null }));
  handle("workspace-apps:list", () => ({ ok: true, apps: [] }));
  handle("runtime-packs:list", () => ({ ok: true, packs: [] }));
  handle("mail-accounts:list", () => ({ ok: true, accounts: [] }));
  handle("mobile-pairing:poll-pending", () => ({ ok: true, grants: [] }));
  handle("mobile-pairing:status", () => ({ ok: true, bridged: false }));
  handle("models:list", () => ({ ok: true, presets: [], activePresetId: "" }));
  handle("permissions:list", () => ({ ok: true, modes: [], currentMode: "" }));
  handle("search:list", () => ({ ok: true, providers: [], activeProviderId: "" }));
  handle("skills:list", () => ({ ok: true, groups: [], skills: [] }));
  handle("skills:get-preset-guide", () => ({ ok: true, guide: null }));
  handle("apps:catalog", () => ({
    ok: true,
    json: {
      publisher: "visual-audit",
      updatedAt: "2026-07-13T00:00:00.000Z",
      apps: [
        {
          id: "disabled-workspace-open",
          name: "股票投研 Starter",
          latestVersion: "1.0.6",
          category: "finance",
          appType: "workspace",
          riskLevel: "medium",
          sizeBytes: 71408026,
          summary: "安装股票投研示范工作区，结合联网研究、Excel 分析和报告生成。",
          installed: true,
          installedAvailable: false,
          installedPath: "/Users/zhangqin/Lily Apps/gupiao/daily-stock-research",
          requiredSkillPackages: ["lily-research-synthesis", "lily-excel-data-analysis"],
        },
        {
          id: "enabled-workspace-open",
          name: "网页系统学习",
          latestVersion: "1.0.23",
          category: "business",
          appType: "connector",
          riskLevel: "high",
          sizeBytes: 5120,
          summary: "学习 OA、ERP、CRM 和后台系统，生成页面地图、动作清单和操作手册。",
          installed: true,
          installedAvailable: true,
          installedPath: "/Users/zhangqin/Lily Apps/anjaz/web-system-learning",
          requiredSkillPackages: ["lily-web-system-learning"],
        },
      ],
    },
  }));
  handle("skills:check-updates", () => ({ ok: true, updates: [] }));
  handle("license:status", () => ({ ok: true, license: null }));
  handle("runtime-packs:location", () => ({ ok: true, locations: [] }));
  handle("assistant:memory:list", () => ({ ok: true, memories: [] }));
  handle("usage:get-summary", () => ({ ok: true, summary: null }));
  handle("account:status", () => ({ ok: true, account: null }));
}

app.whenReady().then(async () => {
  ensureDir(outDir);
  registerNoopHandlers();

  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 980,
    backgroundColor: "#f4f6f8",
    webPreferences: {
      preload: path.join(root, "src/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await win.loadFile(path.join(root, "src/renderer/index.html"));
  await win.webContents.executeJavaScript(`localStorage.setItem("lily.themeMode", "light"); location.reload();`);
  await new Promise((resolve) => setTimeout(resolve, 1200));

  await win.webContents.executeJavaScript(`(
    async () => {
      const store = (await import("./modules/state.js")).default;
      const { syncCommittedMessages } = await import("./modules/session-runtime-store.js");
      const { showSessionMessages, renderConversation } = await import("./modules/message.js");
      const { renderProjectTree } = await import("./modules/project-tree.js");

      const sessionId = "visual_audit_light_session";
      store.set("activeProjectId", "visual_audit_project");
      store.set("activeSessionId", sessionId);
      store.set("projects", [{
        id: "visual_audit_project",
        name: "Lily Workbench",
        path: ${JSON.stringify(root)},
        sessions: [
          { id: sessionId, name: "浅色主题质感审查", status: "idle", updatedAt: new Date().toISOString() },
          { id: "visual_audit_older", name: "文档整理与审阅", status: "done", updatedAt: new Date(Date.now() - 86400000).toISOString() },
        ],
      }]);
      renderProjectTree();
      syncCommittedMessages(sessionId, [
        {
          id: "m1",
          role: "user",
          turnId: "t1",
          content: "检查这个浅色主题：侧栏、聊天正文、工具卡和设置面板需要高级、克制、不能泛黄。",
          timestamp: "2026-07-13T10:00:00.000Z",
        },
        {
          id: "m2",
          role: "assistant",
          turnId: "t1",
          content: "## 设计审查结论\\n\\n- 背景应是冷中性 porcelain，而不是米色纸张。\\n- 卡片边界要轻，但 hover 要有清晰反馈。\\n- 代码块、工具状态、设置表单需要在浅色下保持层级。\\n\\n    const palette = { body: '#f4f6f8', surface: '#ffffff' };\\n\\n下一步会检查高频界面的视觉一致性。",
          timestamp: "2026-07-13T10:00:15.000Z",
        },
        {
          id: "m3",
          role: "user",
          turnId: "t2",
          content: "继续优化到顶级质感。",
          timestamp: "2026-07-13T10:03:00.000Z",
        },
        {
          id: "m4",
          role: "assistant",
          turnId: "t2",
          content: "已进入第二轮：重点看整体壳层、输入区、设置页和状态组件是否一致。浅色主题现在应该更像专业工作台，而不是旧纸张或廉价模板。",
          timestamp: "2026-07-13T10:03:20.000Z",
        },
      ]);
      showSessionMessages(sessionId);
      renderConversation(sessionId, { force: true, forceScrollBottom: true });
      document.getElementById("projectTitle").textContent = "浅色主题质感审查";
      document.getElementById("sessionMeta").textContent = "设计 QA · 浅色模式";
      document.getElementById("sessionStatus").hidden = false;
      document.getElementById("sessionStatus").textContent = "已就绪";
      document.getElementById("promptInput").value = "继续检查设置页、工具卡、代码块和输入框层级";
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return true;
    }
  )()`);

  const mainShot = await win.webContents.capturePage();
  const mainPath = writePng("main-chat.png", mainShot);

  await win.webContents.executeJavaScript(`(
    async () => {
      const { openSettingsPage } = await import("./modules/settings-panel.js");
      openSettingsPage("general");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return true;
    }
  )()`);
  const settingsShot = await win.webContents.capturePage();
  const settingsPath = writePng("settings-general.png", settingsShot);

  await win.webContents.executeJavaScript(`(
    async () => {
      const { openSettingsPage } = await import("./modules/settings-panel.js");
      openSettingsPage("apps");
      await new Promise((resolve) => setTimeout(resolve, 250));
      return true;
    }
  )()`);
  const workspaceButtonStyles = await win.webContents.executeJavaScript(`(
    () => {
      const button = Array.from(document.querySelectorAll(".workspace-app-card-actions .settings-action-btn--primary"))
        .find((item) => item.textContent.trim() === "打开工作空间");
      if (!button) return null;
      const style = getComputedStyle(button);
      return {
        text: button.textContent.trim(),
        disabled: button.disabled,
        className: button.className,
        borderColor: style.borderColor,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        color: style.color,
        opacity: style.opacity,
        outlineColor: style.outlineColor,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
      };
    }
  )()`);
  const appsShot = await win.webContents.capturePage();
  const appsPath = writePng("settings-apps.png", appsShot);

  await win.webContents.executeJavaScript(`(
    async () => {
      const { openSettingsPage } = await import("./modules/settings-panel.js");
      openSettingsPage("mobile");
      const button = document.getElementById("mobilePairStartBtn");
      if (button) button.disabled = true;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return true;
    }
  )()`);
  const mobilePairButtonStyles = await win.webContents.executeJavaScript(`(
    () => {
      const button = document.getElementById("mobilePairStartBtn");
      if (!button) return null;
      const style = getComputedStyle(button);
      return {
        text: button.textContent.trim(),
        disabled: button.disabled,
        className: button.className,
        borderColor: style.borderColor,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        color: style.color,
        opacity: style.opacity,
        outlineColor: style.outlineColor,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
      };
    }
  )()`);

  await win.setSize(390, 820);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const mobileShot = await win.webContents.capturePage();
  const mobilePath = writePng("mobile-settings.png", mobileShot);

  console.log(JSON.stringify({ mainPath, settingsPath, appsPath, mobilePath, workspaceButtonStyles, mobilePairButtonStyles }, null, 2));
  await win.close();
  app.quit();
}).catch((err) => {
  console.error(err);
  app.quit();
  process.exitCode = 1;
});
