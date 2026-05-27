/**
 * Composer: input handling, send flow, keyboard events.
 */

import store from "./state.js";
import { $ } from "./dom.js";
import { createMessage, beginAssistantTurn, finishActiveTurn, setBusyUI } from "./message.js";
import { renderFilePreview, clearPendingFiles } from "./file-handler.js";
import { promptSessionName } from "./name-prompt.js";

export async function sendPrompt() {
  const promptInput = $("promptInput");
  const text = promptInput?.value.trim() || "";
  const files = (store.get("pendingFiles") || []).map((f) => ({
    id: f.id, name: f.name, path: f.path,
    type: f.type, size: f.size, isImage: f.isImage,
  }));

  if (!text && files.length === 0) return;
  if (store.get("isBusy")) return;

  createMessage("user", text, files.length > 0 ? files : null);

  const bubble = beginAssistantTurn();
  bubble.classList.add("pending");

  if (promptInput) promptInput.value = "";
  clearPendingFiles();
  store.set("isBusy", true);
  setBusyUI(true);

  const result = await window.assistantClient.sendMessage(text, files);

  if (!result.ok) {
    bubble.classList.remove("pending");
    const { renderMarkdown } = await import("./markdown.js");
    renderMarkdown(bubble, result.error === "BUSY" ? "上一条消息还在处理中，请稍后再试。" : "消息发送失败。");
    store.set("isBusy", false);
    finishActiveTurn();
    setBusyUI(false);
  }
}

function shouldSendOnEnter(event) {
  if (event.key !== "Enter" || event.shiftKey) return false;
  // IME 选词/确认时按回车，不应触发发送
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

  // Attach button
  $("attachBtn")?.addEventListener("click", async () => {
    const result = await window.assistantClient.pickFiles();
    if (result.ok && result.files) {
      store.set("pendingFiles", [...(store.get("pendingFiles") || []), ...result.files]);
      renderFilePreview();
    }
  });

  // Interrupt
  $("interruptBtn")?.addEventListener("click", async () => {
    await window.assistantClient.interrupt();
    $("promptInput")?.focus();
  });

  // New chat (topbar) — create a new session in the active project
  $("newChatBtn")?.addEventListener("click", async () => {
    const projectId = store.get("activeProjectId");
    const result = await promptSessionName("新对话").then((title) => {
      if (!title) return null;
      return window.assistantClient.createSession(title, projectId);
    });
    if (!result?.ok) return;
    const sw = await window.assistantClient.switchSession(result.session.id);
    store.set("conversation", sw.ok ? (sw.conversation || []) : []);
    const { refreshState, updateTopbarTitles } = await import("./message.js");
    const { renderProjectTree } = await import("./project-tree.js");
    await refreshState();
    renderProjectTree();
    clearPendingFiles();
    messagesClear();
    createMessage("assistant", "新对话已开始，有什么想问的？");
    store.set("isBusy", false);
    updateTopbarTitles();
    $("promptInput")?.focus();
  });
}

function messagesClear() {
  const el = $("messages");
  if (el) el.textContent = "";
}
