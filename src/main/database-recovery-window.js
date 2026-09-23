"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const { DatabaseRecoveryFlow } = require("./database-recovery-flow");

async function openDatabaseRecoveryWindow({ service, locale, allowRestore = true, confirm, admitAction = "inspect" } = {}) {
  const { app, BrowserWindow, ipcMain, dialog } = require("electron");
  locale ||= require("./locale-settings").getLocale();
  if (!["zh-CN", "en", "ar"].includes(locale)) locale = "en";
  const dictionary = require(`../renderer/i18n/locales/${locale}.json`);
  const strings = Object.fromEntries(Object.entries(dictionary)
    .filter(([key]) => key.startsWith("databaseRecovery."))
    .map(([key, value]) => [key.slice("databaseRecovery.".length), value]));
  const zh = locale === "zh-CN";
  const ar = locale === "ar";
  const window = new BrowserWindow({
    width: 680, height: 570, minWidth: 480, minHeight: 490, show: false,
    title: "Lily Workbench", backgroundColor: "#f7f8fa", autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../recovery-preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const channel = "app:database-recovery";
  let disposed = false;
  const publicState = () => ({
    phase: flow.state.phase, reason: flow.state.reason, busy: flow.state.busy,
    allowRestore, version: app.getVersion(), locale, strings,
    candidates: flow.state.candidates.map(({ id, createdAt, messageCount, sessionCount, sourceKind }) =>
      ({ id, createdAt, messageCount, sessionCount, sourceKind })),
  });
  const flow = new DatabaseRecoveryFlow({
    service, allowRestore, admitAction,
    confirm: confirm || (async candidate => {
      const sourceLabel = candidate.sourceKind === "auto_backup"
        ? (zh ? "自动备份" : ar ? "نسخة احتياطية تلقائية" : "Automatic backup")
        : (zh ? "历史恢复副本（数据截止时间未知）" : ar ? "نسخة تاريخية (تاريخ البيانات غير معروف)" : "Historical recovery copy (data cutoff unknown)");
      const snapshotTime = candidate.createdAt ? new Date(candidate.createdAt).toLocaleString(locale) : "—";
      const result = await dialog.showMessageBox(window, {
        type: "warning", defaultId: 0, cancelId: 0, noLink: true,
        buttons: zh ? ["取消", "保留原数据并恢复"] : ar ? ["إلغاء", "الاحتفاظ بالأصل والاستعادة"] : ["Cancel", "Preserve original and restore"],
        message: zh ? "恢复此副本？较新的记录可能不在其中。" : ar ? "استعادة هذه النسخة؟ قد لا تتضمن أحدث السجلات." : "Restore this snapshot? Newer records may be missing.",
        detail: `${sourceLabel} · ${snapshotTime} · ${candidate.messageCount} ${zh ? "条消息" : ar ? "رسالة" : "messages"}\n\n${zh ? "原数据库及配套日志会保留。无法确认损失了多少条记录。附件与工作空间文件不会回滚；历史任务不会自动重跑。" : ar ? "سيتم الاحتفاظ بقاعدة البيانات الأصلية وملفات السجل. عدد السجلات المفقودة غير معروف. لن تتم استعادة المرفقات أو ملفات مساحة العمل ولن تُستأنف المهام تلقائيًا." : "The original database and journals will be retained. The number of missing records is unknown. Attachments and workspace files are not rolled back; previous tasks will not run automatically."}`,
      });
      return result.response === 1;
    }),
    onHealthy: state => { window.hide(); resolveReady(state); },
    onChange: () => {
      if (window.isDestroyed()) return;
      window.webContents.send(channel, publicState());
      if (flow.state.phase === "blocked" || flow.state.phase === "restored") window.show();
    },
  });
  const handler = async (event, action, id) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      return { ok: false, reason: "forbidden" };
    }
    if (action === "state") return publicState();
    if (action === "exit") { app.quit(); return {}; }
    if (action === "restart" && !allowRestore && !flow.state.busy) { app.relaunch(); app.quit(); return {}; }
    if (action === "export") {
      const result = await dialog.showSaveDialog(window, {
        defaultPath: "lily-recovery-diagnostics.json", filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
      try {
        // Metadata only: never export conversations, user paths, API keys or files.
        const { strings: _strings, ...metadata } = publicState();
        await fs.writeFile(result.filePath, JSON.stringify({ ...metadata, platform: process.platform, at: new Date().toISOString() }, null, 2), { flag: "w", mode: 0o600 });
        return { ok: true };
      } catch (error) {
        // Data the user may need back. "export_failed" alone cannot be acted
        // on; the cause can.
        require("./diagnostics/swallowed-failure").recordSwallowedFailure("database export", error);
        return { ok: false, reason: "export_failed" };
      }
    }
    await flow.act(action, id);
    return publicState();
  };
  ipcMain.handle(channel, handler);
  const showTimer = setTimeout(() => { if (!window.isDestroyed() && !flow.admitted) window.show(); }, 800);
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(showTimer);
    flow.close();
    ipcMain.removeHandler(channel);
    resolveReady(null);
  };
  window.on("closed", () => {
    const userClosed = !disposed;
    cleanup();
    if (userClosed) app.quit();
  });
  await window.loadFile(path.join(__dirname, "../renderer/recovery/index.html"));
  if (allowRestore) void flow.act(admitAction);
  else window.show();
  return { window, ready, flow, dispose() { cleanup(); if (!window.isDestroyed()) window.destroy(); } };
}

module.exports = { openDatabaseRecoveryWindow };
