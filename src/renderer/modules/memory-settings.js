/**
 * Memory settings — review workspace learned memory and pending proposals.
 */

import { t } from "../i18n/index.js";
import { $ } from "./dom.js";
import { activeSession } from "./session-chrome.js";
import { confirmDialog } from "./confirm-dialog.js";
import { showToast } from "./toast.js";

function emptyRow(message) {
  const el = document.createElement("p");
  el.className = "settings-memory-empty";
  el.textContent = message;
  return el;
}

function actionButton(label, className = "") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `settings-action-btn settings-action-btn--compact ${className}`.trim();
  btn.textContent = label;
  return btn;
}

function memoryRow(text, meta = "") {
  const row = document.createElement("div");
  row.className = "settings-memory-row";
  const main = document.createElement("div");
  main.className = "settings-memory-main";
  const body = document.createElement("div");
  body.className = "settings-memory-text";
  body.textContent = text;
  main.appendChild(body);
  if (meta) {
    const sub = document.createElement("div");
    sub.className = "settings-memory-meta";
    sub.textContent = meta;
    main.appendChild(sub);
  }
  const actions = document.createElement("div");
  actions.className = "settings-memory-actions";
  row.append(main, actions);
  return { row, actions };
}

async function runAndRefresh(action, successKey) {
  try {
    const result = await action();
    if (!result?.ok) {
      showToast(t("settings.memoryActionFailed"), "error");
      return;
    }
    showToast(t(successKey), "success");
    await refreshMemorySettings();
  } catch {
    showToast(t("settings.memoryActionFailed"), "error");
  }
}

function renderLearned(listEl, sessionId, learned = []) {
  listEl.replaceChildren();
  if (!learned.length) {
    listEl.appendChild(emptyRow(t("settings.memoryEmptyLearned")));
    return;
  }
  for (const item of learned) {
    const { row, actions } = memoryRow(
      item.text || "",
      item.createdAt ? t("settings.memoryCreatedAt", { date: item.createdAt }) : "",
    );
    const remove = actionButton(t("settings.memoryRemove"), "settings-action-btn--danger");
    remove.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: t("settings.memoryRemoveTitle"),
        message: item.text || "",
        confirmText: t("settings.memoryRemove"),
        cancelText: t("prompt.cancel"),
        danger: true,
      });
      if (!ok) return;
      await runAndRefresh(
        () => window.assistantClient.removeLearnedMemory(sessionId, item.key),
        "settings.memoryRemoved",
      );
    });
    actions.appendChild(remove);
    listEl.appendChild(row);
  }
}

function renderProposals(listEl, sessionId, proposals = []) {
  listEl.replaceChildren();
  const pending = proposals.filter((item) => item.status === "proposed");
  if (!pending.length) {
    listEl.appendChild(emptyRow(t("settings.memoryEmptyProposals")));
    return;
  }
  for (const item of pending) {
    const { row, actions } = memoryRow(item.text || "", item.source || "");
    const approve = actionButton(t("settings.memoryApprove"), "settings-action-btn--primary");
    approve.addEventListener("click", () =>
      runAndRefresh(
        () => window.assistantClient.approveMemoryProposal(sessionId, item.key),
        "settings.memoryApproved",
      ),
    );
    const dismiss = actionButton(t("settings.memoryDismiss"));
    dismiss.addEventListener("click", () =>
      runAndRefresh(
        () => window.assistantClient.dismissMemoryProposal(sessionId, item.key),
        "settings.memoryDismissed",
      ),
    );
    actions.append(approve, dismiss);
    listEl.appendChild(row);
  }
}

function categoryLabel(kind) {
  const key = `settings.memoryCategory.${kind}`;
  const value = t(key);
  return value === key ? kind : value;
}

function renderCategories(listEl, sessionId, categories = [], preferences = {}) {
  listEl.replaceChildren();
  const disabled = new Set(preferences.disabledKinds || []);
  for (const kind of categories) {
    const label = document.createElement("label");
    label.className = "settings-memory-category-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !disabled.has(kind);
    const text = document.createElement("span");
    text.textContent = categoryLabel(kind);
    input.addEventListener("change", async () => {
      try {
        const result = await window.assistantClient.setMemoryCategoryEnabled(sessionId, kind, input.checked);
        if (!result?.ok) throw new Error(result?.error || "set category failed");
        showToast(t("settings.memoryCategorySaved"), "success");
      } catch {
        input.checked = !input.checked;
        showToast(t("settings.memoryActionFailed"), "error");
      }
    });
    label.append(input, text);
    listEl.appendChild(label);
  }
}

export async function refreshMemorySettings() {
  const learnedEl = $("memoryLearnedList");
  const proposalEl = $("memoryProposalList");
  const categoryEl = $("memoryCategoryList");
  if (!learnedEl || !proposalEl || !categoryEl) return;
  const sessionId = activeSession()?.id;
  if (!sessionId) {
    learnedEl.replaceChildren(emptyRow(t("settings.memoryNoSession")));
    proposalEl.replaceChildren(emptyRow(t("settings.memoryNoSession")));
    categoryEl.replaceChildren(emptyRow(t("settings.memoryNoSession")));
    return;
  }
  try {
    const result = await window.assistantClient.listMemory(sessionId);
    if (!result?.ok) throw new Error(result?.error || "list memory failed");
    renderCategories(categoryEl, sessionId, result.categories || [], result.preferences || {});
    renderLearned(learnedEl, sessionId, result.learned || []);
    renderProposals(proposalEl, sessionId, result.proposals || []);
  } catch {
    learnedEl.replaceChildren(emptyRow(t("settings.memoryLoadFailed")));
    proposalEl.replaceChildren(emptyRow(t("settings.memoryLoadFailed")));
    categoryEl.replaceChildren(emptyRow(t("settings.memoryLoadFailed")));
  }
}

export function initMemorySettings() {
  $("memoryExportBtn")?.addEventListener("click", async () => {
    const sessionId = activeSession()?.id;
    if (!sessionId) return;
    try {
      const result = await window.assistantClient.exportMemory(sessionId);
      if (!result?.ok) throw new Error(result?.error || "export failed");
      await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
      showToast(t("settings.memoryExported"), "success");
    } catch {
      showToast(t("settings.memoryExportFailed"), "error");
    }
  });

  $("memoryClearLearnedBtn")?.addEventListener("click", async () => {
    const sessionId = activeSession()?.id;
    if (!sessionId) return;
    const ok = await confirmDialog({
      title: t("settings.memoryClearTitle"),
      message: t("settings.memoryClearMessage"),
      confirmText: t("settings.memoryClear"),
      cancelText: t("prompt.cancel"),
      danger: true,
    });
    if (!ok) return;
    await runAndRefresh(
      () => window.assistantClient.clearLearnedMemory(sessionId),
      "settings.memoryCleared",
    );
  });
}
