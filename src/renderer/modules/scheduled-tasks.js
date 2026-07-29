import store from "./state.js";
import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import { t } from "../i18n/index.js";

let currentDraft = null;

const EXAMPLE_KEYS = {
  daily: "scheduled.exampleDaily",
  weekly: "scheduled.exampleWeekly",
  interval: "scheduled.exampleInterval",
};

function activeScope() {
  return {
    projectId: store.get("activeProjectId"),
    sessionId: store.get("activeSessionId"),
  };
}

function selectedTaskScopeMode() {
  return document.querySelector('input[name="scheduledTaskScope"]:checked')?.dataset.scheduledScope || "workspace";
}

function listFilterForScope() {
  const scope = activeScope();
  if (selectedTaskScopeMode() === "all") return { projectId: null, sessionId: null };
  return scope.projectId ? { projectId: scope.projectId, sessionId: null } : {};
}

function taskOwner(task) {
  for (const project of store.get("projects") || []) {
    const session = (project.sessions || []).find((item) => item.id === task.sessionId);
    if (session || project.id === task.projectId) {
      return {
        projectId: project.id,
        projectName: project.name || project.path?.split(/[/\\]/).filter(Boolean).pop() || t("taskCenter.unknownWorkspace"),
        sessionId: task.sessionId,
        sessionTitle: session?.title || t("taskCenter.untitledSession"),
      };
    }
  }
  return {
    projectId: task.projectId || "",
    projectName: t("taskCenter.unknownWorkspace"),
    sessionId: task.sessionId || "",
    sessionTitle: t("taskCenter.untitledSession"),
  };
}

function formatDateTime(value) {
  if (!value) return "-";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function setStatus(message, type = "info") {
  const el = $("scheduledTaskStatus");
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || "";
  el.dataset.type = type;
}

function canCreateFromInput() {
  const input = $("scheduledTaskPrompt");
  const scope = activeScope();
  return Boolean(input?.value.trim() && scope.projectId && scope.sessionId);
}

function updateCreateButton() {
  const createBtn = $("scheduledTaskCreateBtn");
  if (!createBtn) return;
  createBtn.disabled = !canCreateFromInput();
}

function renderDraft(draft) {
  const preview = $("scheduledTaskPreview");
  const createBtn = $("scheduledTaskCreateBtn");
  if (!preview || !createBtn) return;
  currentDraft = draft || null;
  updateCreateButton();
  if (!currentDraft) {
    preview.hidden = true;
    preview.replaceChildren();
    return;
  }

  preview.hidden = false;
  preview.replaceChildren();
  const rows = [
    [t("scheduled.previewTitle"), currentDraft.title],
    [t("scheduled.previewSchedule"), currentDraft.scheduleText],
    [t("scheduled.previewNextRun"), formatDateTime(currentDraft.nextRunAt)],
    [t("scheduled.previewScope"), t("scheduled.previewScopeValue")],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "scheduled-task-preview-row";
    const key = document.createElement("span");
    key.textContent = label;
    const val = document.createElement("strong");
    val.textContent = value;
    row.append(key, val);
    preview.appendChild(row);
  }
}

function actionErrorMessage(error) {
  if (error === "ALREADY_RUNNING") return t("scheduled.alreadyRunning");
  if (error === "TASK_ACTIVE") return t("scheduled.taskActive");
  if (error === "CAPACITY") return t("scheduled.schedulerBusy");
  return null;
}

async function parseDraft() {
  const input = $("scheduledTaskPrompt");
  const text = input?.value.trim() || "";
  const scope = activeScope();
  if (!scope.projectId || !scope.sessionId) {
    setStatus(t("scheduled.needScope"), "warning");
    renderDraft(null);
    return null;
  }
  if (!text) {
    setStatus(t("scheduled.needPrompt"), "warning");
    renderDraft(null);
    input?.focus();
    return null;
  }
  try {
    setStatus(t("scheduled.parseThinking"), "info");
    renderDraft(null);
    const result = await window.assistantClient.parseScheduledTaskDraft({
      text,
      ...scope,
    });
    if (!result?.ok) {
      const message = result?.error === "SCHEDULE_NOT_FOUND"
        ? t("scheduled.scheduleNotFound")
        : t("scheduled.parseFailed");
      setStatus(message, "warning");
      renderDraft(null);
      return null;
    }
    setStatus(t("scheduled.parseReady"), "success");
    renderDraft(result.draft);
    return result.draft;
  } catch (err) {
    setStatus(err?.message || t("scheduled.parseFailed"), "error");
    renderDraft(null);
    return null;
  }
}

async function createTask() {
  const input = $("scheduledTaskPrompt");
  const draft = await parseDraft();
  if (!draft) return;
  try {
    const result = await window.assistantClient.createScheduledTask({
      ...draft,
      prompt: input?.value.trim() || draft.prompt,
    });
    if (!result?.ok) {
      setStatus(actionErrorMessage(result.error) || t("scheduled.createFailed"), "error");
      return;
    }
    const composerInput = $("promptInput");
    if (composerInput && composerInput.value.trim() === (input?.value.trim() || "")) {
      composerInput.value = "";
    }
    input.value = "";
    renderDraft(null);
    setStatus(t("scheduled.created"), "success");
    showToast(t("scheduled.created"), "success");
    await refreshScheduledTaskList();
  } catch (err) {
    setStatus(err?.message || t("scheduled.createFailed"), "error");
  }
}

function renderTaskItem(task) {
  const owner = taskOwner(task);
  const item = document.createElement("article");
  item.className = "scheduled-task-item";
  item.dataset.taskId = task.id;
  item.dataset.sessionId = owner.sessionId;
  item.dataset.projectId = owner.projectId;

  const main = document.createElement("div");
  main.className = "scheduled-task-item-main";
  const title = document.createElement("strong");
  title.textContent = task.title || t("scheduled.untitled");
  const scopeLabel = document.createElement("div");
  scopeLabel.className = "scheduled-task-item-scope";
  scopeLabel.textContent = `${owner.projectName} / ${owner.sessionTitle}`;
  const meta = document.createElement("span");
  const active = task.status === "queued" || task.status === "running";
  const statusText = active
    ? (task.status === "queued" ? t("scheduled.queued") : t("scheduled.running"))
    : (task.enabled ? t("scheduled.enabled") : t("scheduled.paused"));
  meta.textContent = `${task.scheduleText || "-"} · ${statusText} · ${t("scheduled.nextRun")} ${formatDateTime(task.nextRunAt)}`;
  main.append(title, scopeLabel, meta);

  const actions = document.createElement("div");
  actions.className = "scheduled-task-item-actions";
  const open = document.createElement("button");
  open.type = "button";
  open.dataset.action = "open-session";
  open.textContent = t("scheduled.openSession");
  const run = document.createElement("button");
  run.type = "button";
  run.dataset.action = "run";
  run.disabled = active;
  run.textContent = t("scheduled.runNow");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.dataset.action = "toggle";
  toggle.dataset.enabled = task.enabled ? "1" : "0";
  toggle.disabled = active;
  toggle.textContent = task.enabled ? t("scheduled.pause") : t("scheduled.resume");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.action = "remove";
  remove.disabled = active;
  remove.textContent = t("scheduled.remove");
  actions.append(open, run, toggle, remove);

  item.append(main, actions);
  return item;
}

export async function refreshScheduledTaskList() {
  const list = $("scheduledTaskList");
  if (!list) return;
  const scope = listFilterForScope();
  list.replaceChildren();
  if (selectedTaskScopeMode() === "workspace" && !scope.projectId) {
    list.textContent = t("scheduled.needScope");
    return;
  }
  try {
    const result = await window.assistantClient.listScheduledTasks(scope);
    const tasks = result?.tasks || [];
    if (!tasks.length) {
      const empty = document.createElement("p");
      empty.className = "scheduled-task-empty";
      empty.textContent = t("scheduled.empty");
      list.appendChild(empty);
      return;
    }
    for (const task of tasks) list.appendChild(renderTaskItem(task));
  } catch (err) {
    list.textContent = err?.message || t("scheduled.listFailed");
  }
}

async function openTaskSession(item) {
  const sessionId = item?.dataset.sessionId || "";
  const projectId = item?.dataset.projectId || "";
  if (!sessionId) return;
  try {
    const sw = await window.assistantClient?.switchSession?.(sessionId);
    const { applySessionSwitch } = await import("./session-chrome.js");
    await applySessionSwitch(sw, sessionId, projectId);
    closeScheduledTaskModal();
  } catch (err) {
    showToast(err?.message || t("toast.switchSessionFailed"), "error");
  }
}

async function handleTaskAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const item = button.closest(".scheduled-task-item");
  if (button.dataset.action === "open-session") {
    await openTaskSession(item);
    return;
  }
  const taskId = item?.dataset.taskId;
  if (!taskId) return;
  button.disabled = true;
  try {
    const action = button.dataset.action;
    let result = null;
    if (action === "run") {
      result = await window.assistantClient.runScheduledTaskNow(taskId);
      if (result?.ok) showToast(t("scheduled.runQueued"), "info");
    } else if (action === "toggle") {
      const enabled = button.dataset.enabled !== "1";
      result = await window.assistantClient.setScheduledTaskEnabled(taskId, enabled);
    } else if (action === "remove") {
      result = await window.assistantClient.removeScheduledTask(taskId);
    }
    if (!result?.ok) showToast(actionErrorMessage(result?.error) || t("common.actionFailed"), "error");
    await refreshScheduledTaskList();
  } catch (err) {
    showToast(err?.message || t("common.actionFailed"), "error");
  } finally {
    button.disabled = false;
  }
}

async function openScheduledTaskModal() {
  const modal = $("scheduledTaskModal");
  const input = $("scheduledTaskPrompt");
  if (!modal || !input) return;
  const composerText = $("promptInput")?.value.trim() || "";
  input.value = composerText;
  modal.hidden = false;
  setStatus("", "info");
  renderDraft(null);
  updateCreateButton();
  await refreshScheduledTaskList();
  if (composerText) void parseDraft();
  input.focus();
}

function closeScheduledTaskModal() {
  const modal = $("scheduledTaskModal");
  if (!modal) return;
  modal.hidden = true;
  setStatus("", "info");
  renderDraft(null);
}

export function initScheduledTasks() {
  $("scheduledTaskPrompt")?.addEventListener("input", () => {
    renderDraft(null);
    setStatus("", "info");
    updateCreateButton();
  });
  for (const button of document.querySelectorAll("[data-scheduled-example]")) {
    const key = EXAMPLE_KEYS[button.dataset.scheduledExample];
    const text = t(key);
    button.textContent = text;
    button.addEventListener("click", () => {
      const input = $("scheduledTaskPrompt");
      if (!input) return;
      input.value = text;
      renderDraft(null);
      setStatus("", "info");
      updateCreateButton();
      input.focus();
      void parseDraft();
    });
  }
  $("scheduledTaskBtn")?.addEventListener("click", () => void openScheduledTaskModal());
  $("scheduledTaskCloseBtn")?.addEventListener("click", closeScheduledTaskModal);
  $("scheduledTaskParseBtn")?.addEventListener("click", () => void parseDraft());
  $("scheduledTaskCreateBtn")?.addEventListener("click", () => void createTask());
  $("scheduledTaskList")?.addEventListener("click", (event) => void handleTaskAction(event));
  for (const input of document.querySelectorAll('input[name="scheduledTaskScope"]')) {
    input.addEventListener("change", () => void refreshScheduledTaskList());
  }
  $("scheduledTaskModal")?.addEventListener("click", (event) => {
    if (event.target === $("scheduledTaskModal")) closeScheduledTaskModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("scheduledTaskModal")?.hidden) closeScheduledTaskModal();
  });
}
