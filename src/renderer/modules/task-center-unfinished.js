import { t, getLocale } from "../i18n/index.js";
import { showToast } from "./toast.js";
import { relativeTimeValue } from "./workspace-switcher-model.js";

/** Unfinished tasks (main: tasks:list-unfinished / tasks:resume) — the task
 *  center's "earlier sessions" section. Loaded at init, on panel open, after a
 *  resume, every 30s while the panel is open, and (throttled) when the session
 *  list refreshes. Facade missing or failing → the section stays as it was (or
 *  absent); nothing else in the task center depends on it.
 *
 *  The host (task-center.js) binds its rerender / navigation hooks once via
 *  bindUnfinishedTasksHost so this module never imports it back. */
export const TASK_CENTER_MAX_VISIBLE_ITEMS = 8;

const UNFINISHED_LIMIT = 20;
const UNFINISHED_REFRESH_MS = 30_000;
const UNFINISHED_LIST_THROTTLE_MS = 5_000;
// "unverified" is a finished answer without test/build evidence — main no longer
// lists it; kept out of the pill set so a stale main cannot revive it either.
const UNFINISHED_STATUSES = new Set(["outcome_unknown", "failed", "blocked", "waiting_user"]);

let host = {
  rerender() {},
  closePanel() {},
  async focusSession() {},
  findProjectIdForSession() { return ""; },
};
let unfinishedTasks = [];
let unfinishedLoading = null;
let unfinishedLoadedAt = 0;
let unfinishedTimer = null;

export function bindUnfinishedTasksHost(next = {}) {
  host = { ...host, ...next };
}

function normalizeUnfinishedTask(task) {
  if (!task?.sessionId || !task?.turnId) return null;
  const status = UNFINISHED_STATUSES.has(task.status) ? task.status : "outcome_unknown";
  return {
    sessionId: String(task.sessionId),
    turnId: String(task.turnId),
    taskId: String(task.taskId || ""),
    status,
    userText: String(task.userText || "").replace(/\s+/g, " ").trim().slice(0, 200),
    sessionTitle: String(task.sessionTitle || "") || t("taskCenter.untitledSession"),
    projectId: String(task.projectId || ""),
    projectName: String(task.projectName || "") || t("taskCenter.unknownWorkspace"),
    updatedAt: Number(task.updatedAt) || Number(task.createdAt) || 0,
    sessionMissing: Boolean(task.sessionMissing),
    resumable: Boolean(task.resumable) && !task.sessionMissing,
  };
}

export function getUnfinishedTasks() {
  return unfinishedTasks;
}

export function loadUnfinishedTasks() {
  const facade = window.assistantClient?.tasks;
  if (typeof facade?.listUnfinished !== "function") {
    if (unfinishedTasks.length) {
      unfinishedTasks = [];
      host.rerender();
    }
    return Promise.resolve(unfinishedTasks);
  }
  if (unfinishedLoading) return unfinishedLoading;
  unfinishedLoading = (async () => {
    try {
      const result = await facade.listUnfinished({ limit: UNFINISHED_LIMIT });
      if (result?.ok && Array.isArray(result.tasks)) {
        unfinishedTasks = result.tasks.map(normalizeUnfinishedTask).filter(Boolean);
      }
      // `ok:false` / thrown: keep the last known list rather than flicker it away.
    } catch {
      /* quiet — the section keeps its last state */
    } finally {
      unfinishedLoading = null;
      unfinishedLoadedAt = Date.now();
    }
    host.rerender();
    return unfinishedTasks;
  })();
  return unfinishedLoading;
}

export function maybeReloadUnfinished() {
  if (Date.now() - unfinishedLoadedAt < UNFINISHED_LIST_THROTTLE_MS) return;
  void loadUnfinishedTasks();
}

export function startUnfinishedTimer() {
  if (unfinishedTimer) return;
  unfinishedTimer = setInterval(() => void loadUnfinishedTasks(), UNFINISHED_REFRESH_MS);
}

export function stopUnfinishedTimer() {
  if (!unfinishedTimer) return;
  clearInterval(unfinishedTimer);
  unfinishedTimer = null;
}

function relativeTimeLabel(value) {
  const relative = relativeTimeValue(value);
  if (!relative) return "";
  try {
    return new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" }).format(relative.value, relative.unit);
  } catch {
    return "";
  }
}

function unfinishedStatusLabel(status) {
  return t(`taskCenter.unfinished.${status}`);
}

function unfinishedMetaText(task) {
  return [task.sessionTitle, task.projectName, relativeTimeLabel(task.updatedAt)]
    .filter(Boolean)
    .join(" · ");
}

async function resumeUnfinishedTask(task, button) {
  const facade = window.assistantClient?.tasks;
  if (typeof facade?.resume !== "function") return;
  button.disabled = true;
  let result = null;
  try {
    result = await facade.resume({ sessionId: task.sessionId, turnId: task.turnId });
  } catch {
    result = { ok: false, error: "RESUME_FAILED" };
  }
  if (result?.ok) {
    host.closePanel();
    showToast(t("taskCenter.resumed"), "success");
    void loadUnfinishedTasks();
    // Main already switched the active project/session; mirror it here so the
    // resumed conversation is what the user sees. Best-effort: a view glitch
    // must not undo the resume itself.
    try {
      const { applySessionSwitch } = await import("./session-chrome.js");
      const sessionId = result.sessionId || task.sessionId;
      const projectId = result.projectId || task.projectId || host.findProjectIdForSession(sessionId);
      await applySessionSwitch({ ok: true }, sessionId, projectId);
    } catch {
      /* the list refresh + toast already reflect the resume */
    }
    return;
  }
  button.disabled = false;
  const code = result?.error;
  if (code === "BUSY") {
    showToast(t("taskCenter.resumeBusy"), "warning");
  } else if (code === "ALREADY_RESUMED") {
    showToast(t("taskCenter.resumeAlready"), "info");
    void loadUnfinishedTasks();
  } else if (code === "SESSION_NOT_FOUND" || code === "TASK_NOT_FOUND") {
    showToast(t("taskCenter.resumeSessionMissing"), "error");
    void loadUnfinishedTasks();
  } else {
    showToast(t("taskCenter.resumeFailed"), "error");
  }
}

function renderUnfinishedRow(task) {
  const row = document.createElement("div");
  row.className = `task-center-task is-${task.status}`;
  row.dataset.sessionId = task.sessionId;
  row.dataset.turnId = task.turnId;

  const status = document.createElement("span");
  status.className = "task-center-task-status";
  status.textContent = unfinishedStatusLabel(task.status);

  const main = document.createElement("span");
  main.className = "task-center-task-main";
  const text = document.createElement("strong");
  text.className = "task-center-task-text";
  text.textContent = task.userText || t("taskCenter.untitledRequest");
  text.title = task.userText;
  const meta = document.createElement("span");
  meta.className = "task-center-task-meta";
  meta.textContent = unfinishedMetaText(task);
  main.append(text, meta);
  if (!task.sessionMissing) {
    main.classList.add("is-link");
    main.addEventListener("click", () => {
      void host.focusSession(task.sessionId);
      host.closePanel();
    });
  }

  const resume = document.createElement("button");
  resume.type = "button";
  resume.className = "task-center-task-resume";
  resume.textContent = t("taskCenter.resume");
  if (task.resumable) {
    resume.addEventListener("click", (event) => {
      event.stopPropagation();
      void resumeUnfinishedTask(task, resume);
    });
  } else {
    resume.disabled = true;
    resume.title = t(task.sessionMissing ? "taskCenter.resumeSessionMissing" : "taskCenter.resumeUnavailable");
  }

  row.append(status, main, resume);
  return row;
}

export function renderUnfinishedSection(tasks) {
  const section = document.createElement("section");
  section.className = "task-center-unfinished";
  section.setAttribute("aria-label", t("taskCenter.unfinishedTitle"));

  const head = document.createElement("header");
  head.className = "task-center-section-head";
  const title = document.createElement("strong");
  title.textContent = t("taskCenter.unfinishedTitle");
  const count = document.createElement("span");
  count.className = "task-center-section-count";
  count.textContent = String(tasks.length);
  head.append(title, count);
  section.append(head);

  if (!tasks.length) {
    const empty = document.createElement("p");
    empty.className = "task-center-empty";
    empty.textContent = t("taskCenter.unfinishedEmpty");
    section.append(empty);
    return section;
  }
  section.append(...tasks.slice(0, TASK_CENTER_MAX_VISIBLE_ITEMS).map(renderUnfinishedRow));
  return section;
}

export function unfinishedSignature(tasks) {
  return JSON.stringify(tasks.slice(0, TASK_CENTER_MAX_VISIBLE_ITEMS).map((task) => ({
    sessionId: task.sessionId,
    turnId: task.turnId,
    status: task.status,
    statusLabel: unfinishedStatusLabel(task.status),
    userText: task.userText,
    meta: unfinishedMetaText(task),
    resumable: task.resumable,
    sessionMissing: task.sessionMissing,
    total: tasks.length,
  })));
}
