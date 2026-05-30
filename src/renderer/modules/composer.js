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

function renderPromptSuggestions(sessionId, suggestions = []) {
  const bar = $("promptSuggestions");
  if (!bar) return;
  const activeId = store.get("activeSessionId");
  if (sessionId !== activeId || isSessionRunning(sessionId)) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }

  const items = (suggestions || [])
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item.prompt === "string") return item.prompt.trim();
      if (item && typeof item.text === "string") return item.text.trim();
      return "";
    })
    .filter(Boolean)
    .slice(0, 4);

  if (!items.length) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }

  bar.hidden = false;
  bar.replaceChildren();
  for (const text of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "prompt-suggestion-btn";
    btn.textContent = text.length > 80 ? `${text.slice(0, 77)}…` : text;
    btn.title = text;
    btn.addEventListener("click", () => {
      const input = $("promptInput");
      if (input) input.value = text;
      bar.hidden = true;
      bar.replaceChildren();
      input?.focus();
    });
    bar.appendChild(btn);
  }
}

export function clearPromptSuggestions() {
  renderPromptSuggestions(store.get("activeSessionId"), []);
}

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

  if (sessionId) renderPromptSuggestions(sessionId, []);
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
    const { forceEndTurnUi } = await import("./message.js");
    if (sessionId) forceEndTurnUi(sessionId);
    renderPromptSuggestions(sessionId, []);
    $("promptInput")?.focus();
  });

  window.assistantClient.onPromptSuggestions?.((payload) => {
    renderPromptSuggestions(payload?.sessionId, payload?.suggestions);
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
