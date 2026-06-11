/**
 * Composer — sends user messages to the active Claude session (stream-json).
 */

import store from "./state.js";
import { $ } from "./dom.js";
import { renderFilePreview, clearPendingFiles } from "./file-handler.js";
import { promptSessionName } from "./name-prompt.js";
import { showToast } from "./toast.js";
import { applySessionSwitch, refreshState } from "./session-chrome.js";
import { canSend, getTurnPhase, subscribeRuntime, getRuntimeSession, syncCommittedMessages } from "./session-runtime-store.js";
import { t } from "../i18n/index.js";
import { chooseDialog } from "./confirm-dialog.js";

function messageQueueArea() {
  return $("messageQueueArea");
}

export function renderMessageQueue(sessionId, items = []) {
  const area = messageQueueArea();
  if (!area) return;

  const activeId = store.get("activeSessionId");
  if (!activeId || sessionId !== activeId || !items.length) {
    if (!sessionId || sessionId === activeId) {
      area.hidden = true;
      area.replaceChildren();
    }
    return;
  }

  area.hidden = false;
  area.replaceChildren();

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "message-queue-item";

    const badge = document.createElement("span");
    badge.className = "message-queue-badge";
    badge.textContent = t("composer.queueBadge");
    row.appendChild(badge);

    const text = document.createElement("span");
    text.className = "message-queue-preview";
    const preview =
      item.preview ||
      item.text ||
      (item.hasFiles ? t("composer.queueAttachmentOnly") : t("composer.queueEmptyText"));
    text.textContent = preview;
    text.title = preview;
    row.appendChild(text);

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "message-queue-remove";
    rm.innerHTML = "&times;";
    rm.title = t("composer.cancelQueued");
    rm.setAttribute("aria-label", t("composer.cancelQueued"));
    rm.addEventListener("click", () => void cancelQueuedMessage(sessionId, item.id));
    row.appendChild(rm);

    area.appendChild(row);
  }
}

async function cancelQueuedMessage(sessionId, itemId) {
  if (!sessionId) return;
  try {
    const result = await window.assistantClient.cancelQueuedMessage(sessionId, itemId);
    if (!result?.ok) {
      showToast(t("toast.queueCancelFailed"), "warning");
      return;
    }
    showToast(t("toast.messageQueueCancelled"), "info");
  } catch (err) {
    showToast(err?.message || t("toast.queueCancelFailed"), "error");
  }
}

export function renderPromptSuggestions(sessionId, suggestions = []) {
  const bar = $("promptSuggestions");
  if (!bar) return;
  const activeId = store.get("activeSessionId");
  if (sessionId !== activeId || !canSend(sessionId)) {
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

export async function sendPrompt(opts = {}) {
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

  if (sessionId && getTurnPhase(sessionId) === "stopping") {
    showToast(t("toast.sessionStopping"), "warning");
    return;
  }
  if (!files.length) {
    const { hasPendingUserQuestion, respondPendingUserQuestionFromComposer, syncComposerForActiveSession } =
      await import("./message.js");
    if (hasPendingUserQuestion(sessionId)) {
      if (promptInput) promptInput.value = "";
      try {
        const result = await respondPendingUserQuestionFromComposer(sessionId, text);
        if (!result?.ok) {
          if (promptInput) promptInput.value = text;
          showToast(t("question.respondFailed"), "error");
          return;
        }
        syncComposerForActiveSession();
        promptInput?.focus();
        return;
      } catch (err) {
        if (promptInput) promptInput.value = text;
        showToast(err?.message || t("question.respondFailed"), "error");
        return;
      }
    }
  }
  // A send while the turn is running is a real decision: queue it for later
  // or interrupt the current answer and send now. Dismissing keeps the draft.
  const BUSY_PHASES = new Set(["starting", "streaming", "tool_running", "awaiting_user"]);
  let sendMode = "send";
  if (BUSY_PHASES.has(getTurnPhase(sessionId))) {
    sendMode = await chooseDialog({
      title: t("composer.busyChoiceTitle"),
      message: t("composer.busyChoiceMessage"),
      options: [
        { value: "queue", label: t("composer.busyChoiceQueue") },
        { value: "interrupt", label: t("composer.busyChoiceInterrupt"), danger: true },
      ],
    });
    if (!sendMode) return;
  }

  const displayFiles = files.map((f) => {
    const pending = (store.get("pendingFiles") || []).find((pf) => pf.id === f.id);
    return {
      name: f.name,
      isImage: f.isImage,
      thumbnail: f.isImage ? (pending?.thumbnail || null) : null,
    };
  });
  const savedText = text;
  const savedFiles = [...(store.get("pendingFiles") || [])];

  if (promptInput) promptInput.value = "";
  clearPendingFiles();

  let result;
  try {
    result = sendMode === "interrupt"
      ? await window.assistantClient.interruptAndSend(
          text,
          files,
          sessionId,
          displayFiles.length ? displayFiles : null,
        )
      : await window.assistantClient.sendMessage(
          text,
          files,
          sessionId,
          displayFiles.length ? displayFiles : null,
        );
  } catch (err) {
    if (promptInput && savedText) promptInput.value = savedText;
    if (savedFiles.length) {
      store.set("pendingFiles", savedFiles);
      renderFilePreview();
    }
    showToast(err?.message || t("send.error.GENERIC"), "error");
    return;
  }

  if (!result?.ok) {
    if (promptInput && savedText) promptInput.value = savedText;
    if (savedFiles.length) {
      store.set("pendingFiles", savedFiles);
      renderFilePreview();
    }
    showToast(sendErrorMessage(result), "error");
    return;
  }

  if (result.scheduledDraft && Array.isArray(result.conversation)) {
    syncCommittedMessages(sessionId, result.conversation);
    const { renderConversation, syncComposerForActiveSession } = await import("./message.js");
    renderConversation(sessionId, { force: true, forceScrollBottom: true });
    syncComposerForActiveSession();
    $("promptInput")?.focus();
    return;
  }

  if (result.priority) {
    showToast(t("toast.messagePriorityQueued"), "info");
  } else if (result.queued) {
    showToast(
      t("toast.messageQueued", { count: result.queueLength || 1 }),
      "info",
    );
  }

  if (sessionId) {
    renderPromptSuggestions(sessionId, []);
  }
  const { syncComposerForActiveSession } = await import("./message.js");
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
    // @-mention file completion: typing "@token" pops a workspace file list;
    // selecting inserts the relative path into the prompt.
    let mentionOpen = false;
    let mentionTimer = null;
    const mentionBox = document.createElement("div");
    mentionBox.className = "composer-mention-popover";
    mentionBox.hidden = true;
    if (promptInput.parentElement && !promptInput.parentElement.style.position) {
      promptInput.parentElement.style.position = "relative";
    }
    promptInput.parentElement?.appendChild(mentionBox);

    const activeProjectRoot = () => {
      const projectId = store.get("activeProjectId");
      const project = (store.get("projects") || []).find((p) => p.id === projectId);
      return project?.path || null;
    };
    const mentionTokenAtCaret = () => {
      const caret = promptInput.selectionStart ?? promptInput.value.length;
      const before = promptInput.value.slice(0, caret);
      const match = before.match(/(^|\s)@([\w\-./\\]*)$/);
      if (!match) return null;
      return { query: match[2], start: caret - match[2].length - 1, caret };
    };
    const closeMention = () => {
      mentionOpen = false;
      mentionBox.hidden = true;
      mentionBox.replaceChildren();
    };
    const refreshMention = async () => {
      const token = mentionTokenAtCaret();
      const root = activeProjectRoot();
      if (!token || !root) {
        closeMention();
        return;
      }
      const result = await window.assistantClient.searchFiles(root, token.query, 12);
      const files = result?.ok ? result.files || [] : [];
      if (!files.length) {
        closeMention();
        return;
      }
      mentionBox.replaceChildren();
      for (const file of files) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "composer-mention-item";
        item.textContent = file.relPath;
        // mousedown so the textarea keeps focus (click would blur first).
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          const value = promptInput.value;
          promptInput.value =
            `${value.slice(0, token.start)}@${file.relPath} ${value.slice(token.caret)}`;
          const pos = token.start + file.relPath.length + 2;
          promptInput.setSelectionRange(pos, pos);
          closeMention();
          promptInput.focus();
          promptInput.dispatchEvent(new Event("input", { bubbles: true }));
        });
        mentionBox.appendChild(item);
      }
      mentionBox.hidden = false;
      mentionOpen = true;
    };
    promptInput.addEventListener("input", () => {
      clearTimeout(mentionTimer);
      mentionTimer = setTimeout(() => void refreshMention(), 120);
    });
    promptInput.addEventListener("blur", () => setTimeout(closeMention, 150));

    // Esc in the composer: first closes the @-mention popover, then interrupts
    // the running turn (the status line advertises this). Scoped to the input
    // so dialog Escape handlers win.
    promptInput.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || imeComposing) return;
      if (mentionOpen) {
        e.preventDefault();
        closeMention();
        return;
      }
      const sessionId = store.get("activeSessionId");
      if (!sessionId) return;
      const phase = getTurnPhase(sessionId);
      if (!phase || phase === "idle") return;
      e.preventDefault();
      void window.assistantClient.interrupt(sessionId);
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
    await window.assistantClient.interrupt(sessionId);
    renderPromptSuggestions(sessionId, []);
    $("promptInput")?.focus();
  });

  subscribeRuntime(() => {
    const sid = store.get("activeSessionId");
    if (sid) renderPromptSuggestions(sid, getRuntimeSession(sid).promptSuggestions || []);
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
    if (!result?.ok) {
      showToast(
        result?.detail || sendErrorMessage(result) || t("toast.createSessionFailed"),
        "error",
      );
      return;
    }
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
