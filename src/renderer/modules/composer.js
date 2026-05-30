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
import { t } from "../i18n/index.js";

function sendErrorMessage(result) {
  if (result.detail) return result.detail;
  const key = `send.error.${result.error}`;
  const mapped = t(key);
  return mapped === key ? t("send.error.GENERIC") : mapped;
}

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
    showToast(t("toast.needProject"), "warning");
    return;
  }
  if (!sessionId) {
    showToast(t("toast.needSession"), "warning");
    return;
  }
  if (sessionId && isSessionRunning(sessionId)) {
    showToast(t("toast.sessionBusy"), "warning");
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
    showToast(sendErrorMessage(result), "error");
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
      showToast(t("toast.needProject"), "warning");
      return;
    }
    const title = await promptSessionName(t("prompt.newSession"));
    if (!title) return;
    const result = await window.assistantClient.createSession(title, projectId);
    if (!result?.ok) return;
    const sw = await window.assistantClient.switchSession(result.session.id);
    await refreshState();
    const { expandProjectGroup, renderProjectTree } = await import("./project-tree.js");
    expandProjectGroup(projectId);
    renderProjectTree();
    clearPendingFiles();
    await applySessionSwitch(sw, result.session.id, projectId);
    $("promptInput")?.focus();
  });
}
