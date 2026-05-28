/**
 * Composer — sends user messages to the active Claude session (stream-json).
 */

import store from "./state.js";
import { $ } from "./dom.js";
import { renderFilePreview, clearPendingFiles } from "./file-handler.js";
import { promptSessionName } from "./name-prompt.js";
import { showToast } from "./toast.js";
import { applySessionSwitch, refreshState } from "./session-chrome.js";
import { isSessionRunning, setSessionRunning } from "./session-busy.js";

export async function sendPrompt() {
  const promptInput = $("promptInput");
  const text = promptInput?.value.trim() || "";
  const files = (store.get("pendingFiles") || []).map((f) => ({
    id: f.id, name: f.name, path: f.path,
    type: f.type, size: f.size, isImage: f.isImage,
  }));

  if (!text && files.length === 0) return;

  const sessionId = store.get("activeSessionId");
  if (!(store.get("projects") || []).length) {
    showToast("请先添加工作空间文件夹。", "warning");
    return;
  }
  if (!sessionId) {
    showToast("请先新建对话。", "warning");
    return;
  }
  if (sessionId && isSessionRunning(sessionId)) {
    showToast("当前对话还在处理上一条消息，请稍后再试。", "warning");
    return;
  }
  const displayFiles = files.map((f) => ({
    name: f.name,
    isImage: f.isImage,
  }));
  const savedText = text;
  const savedFiles = [...(store.get("pendingFiles") || [])];

  if (promptInput) promptInput.value = "";
  clearPendingFiles();

  const { createMessage, removeLastUserMessage, syncComposerForActiveSession } =
    await import("./message.js");
  if (sessionId) {
    createMessage(
      sessionId,
      "user",
      savedText,
      displayFiles.length ? displayFiles : null,
    );
  }

  const result = await window.assistantClient.sendMessage(text, files);

  if (!result.ok) {
    if (sessionId) removeLastUserMessage(sessionId);
    if (promptInput && savedText) promptInput.value = savedText;
    if (savedFiles.length) {
      store.set("pendingFiles", savedFiles);
      renderFilePreview();
    }
    const msg =
      result.detail ||
      (result.error === "NO_CLI"
        ? "内置助手引擎未就绪。请完全退出后重新打开应用。"
        : result.error === "NO_PROJECT"
          ? "该对话所属的文件夹已不存在，请在左侧重新选择文件夹或新建对话。"
          : result.error === "INVALID_WORKDIR"
            ? "工作目录不存在，请检查左侧文件夹路径是否有效。"
            : result.error === "BUSY"
              ? "上一条消息还在处理中，请稍后再试。"
              : result.error === "RUNNER_ERROR"
                ? "助手进程启动失败，请重启应用后再试。"
                : "发送失败。");
    showToast(msg, "error");
    return;
  }

  if (sessionId) setSessionRunning(sessionId, true);
  syncComposerForActiveSession();

  $("promptInput")?.focus();
}

function shouldSendOnEnter(event) {
  if (event.key !== "Enter" || event.shiftKey) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  return true;
}

export function initComposer() {
  const composer = $("composer");
  const promptInput = $("promptInput");
  let imeComposing = false;

  if (composer) {
    composer.addEventListener("submit", (e) => { e.preventDefault(); sendPrompt(); });
  }

  if (promptInput) {
    promptInput.placeholder = "有什么想问的？";
    promptInput.addEventListener("compositionstart", () => {
      imeComposing = true;
    });
    promptInput.addEventListener("compositionend", () => {
      imeComposing = false;
    });
    promptInput.addEventListener("keydown", (e) => {
      if (imeComposing || !shouldSendOnEnter(e)) return;
      e.preventDefault();
      sendPrompt();
    });
  }

  $("attachBtn")?.addEventListener("click", async () => {
    const result = await window.assistantClient.pickFiles();
    if (result.ok && result.files) {
      store.set("pendingFiles", [...(store.get("pendingFiles") || []), ...result.files]);
      renderFilePreview();
    }
  });

  $("interruptBtn")?.addEventListener("click", async () => {
    const sessionId = store.get("activeSessionId");
    await window.assistantClient.interrupt();
    if (sessionId) setSessionRunning(sessionId, false);
    const { syncComposerForActiveSession } = await import("./message.js");
    syncComposerForActiveSession();
    $("promptInput")?.focus();
  });

  $("newChatBtn")?.addEventListener("click", async () => {
    const projectId = store.get("activeProjectId");
    if (!projectId) {
      showToast("请先添加工作空间文件夹。", "warning");
      return;
    }
    const title = await promptSessionName("新对话");
    if (!title) return;
    const result = await window.assistantClient.createSession(title, projectId);
    if (!result?.ok) return;
    const sw = await window.assistantClient.switchSession(result.session.id);
    await refreshState();
    const { renderProjectTree } = await import("./project-tree.js");
    renderProjectTree();
    clearPendingFiles();
    await applySessionSwitch(sw, result.session.id, projectId);
    $("promptInput")?.focus();
  });
}
