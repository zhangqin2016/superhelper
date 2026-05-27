/**
 * Composer: input handling, send flow, keyboard events.
 */

import store from "./state.js";
import { $ } from "./dom.js";
import { createMessage } from "./message.js";

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

  const bubble = createMessage("assistant", "");
  bubble.classList.add("pending");
  store.set("activeBubble", bubble);
  store.set("activeMarkdown", "");

  if (promptInput) promptInput.value = "";
  store.set("pendingFiles", []);
  updateFilePreview();
  store.set("isBusy", true);

  const result = await window.assistantClient.sendMessage(text, files);

  if (!result.ok) {
    bubble.classList.remove("pending");
    const { renderMarkdown } = await import("./markdown.js");
    renderMarkdown(bubble, result.error === "BUSY" ? "上一条消息还在处理中，请稍后再试。" : "消息发送失败。");
    store.set("isBusy", false);
    store.set("activeBubble", null);
    store.set("activeMarkdown", "");
  }
}

function updateFilePreview() {
  const area = $("filePreviewArea");
  const files = store.get("pendingFiles") || [];
  if (!area) return;
  area.textContent = "";
  if (files.length === 0) { area.hidden = true; return; }
  area.hidden = false;
  for (const f of files) {
    const chip = document.createElement("div");
    chip.className = "file-chip";
    chip.innerHTML = `<span>${f.name}</span>`;
    const rm = document.createElement("button");
    rm.className = "file-chip-remove";
    rm.textContent = "×";
    rm.addEventListener("click", () => {
      store.set("pendingFiles", (store.get("pendingFiles") || []).filter((x) => x.id !== f.id));
      updateFilePreview();
    });
    chip.appendChild(rm);
    area.appendChild(chip);
  }
}

export function initComposer() {
  const composer = $("composer");
  const promptInput = $("promptInput");

  if (composer) {
    composer.addEventListener("submit", (e) => { e.preventDefault(); sendPrompt(); });
  }

  if (promptInput) {
    promptInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
    });
  }

  // Attach button
  $("attachBtn")?.addEventListener("click", async () => {
    const result = await window.assistantClient.pickFiles();
    if (result.ok && result.files) {
      store.set("pendingFiles", [...(store.get("pendingFiles") || []), ...result.files]);
      updateFilePreview();
    }
  });

  // Interrupt
  $("interruptBtn")?.addEventListener("click", async () => {
    await window.assistantClient.interrupt();
    store.set("isBusy", false);
    $("promptInput")?.focus();
  });

  // New chat (topbar) — create a new session in the active project
  $("newChatBtn")?.addEventListener("click", async () => {
    const projectId = store.get("activeProjectId");
    const result = await window.assistantClient.createSession("新会话", projectId);
    if (result.ok) {
      await window.assistantClient.switchSession(result.session.id);
      const { refreshState, renderConversation } = await import("./message.js");
      const { renderProjectTree } = await import("./project-tree.js");
      await refreshState();
      renderProjectTree();
      messagesClear();
      createMessage("assistant", "新会话已开始。");
      store.set("isBusy", false);
      $("promptInput")?.focus();
    }
  });
}

function messagesClear() {
  const el = $("messages");
  if (el) el.textContent = "";
}
