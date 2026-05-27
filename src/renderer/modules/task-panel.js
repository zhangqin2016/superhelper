/**
 * Task progress panel (right panel) — displays running/recent CLI tasks.
 */

import store from "./state.js";
import { $ } from "./dom.js";

let taskIdCounter = 0;

export function addTask(title, description = "") {
  const tasks = store.get("tasks") || [];
  const task = {
    id: `task-${++taskIdCounter}`,
    title,
    description,
    status: "running",
    startTime: Date.now(),
  };
  tasks.unshift(task);
  if (tasks.length > 50) tasks.length = 50;
  store.set("tasks", tasks);
  renderTasks();
  return task.id;
}

export function updateTask(taskId, updates) {
  const tasks = store.get("tasks") || [];
  const task = tasks.find((t) => t.id === taskId);
  if (task) {
    Object.assign(task, updates);
    store.set("tasks", tasks);
    renderTasks();
  }
}

export function clearDoneTasks() {
  const tasks = (store.get("tasks") || []).filter((t) => t.status === "running");
  store.set("tasks", tasks);
  renderTasks();
}

export function renderTasks() {
  const panel = $("taskPanel");
  if (!panel) return;

  const tasks = store.get("tasks") || [];
  if (tasks.length === 0) {
    panel.innerHTML = '<div class="task-empty">暂无运行中的任务</div>';
    return;
  }

  panel.textContent = "";
  for (const task of tasks) {
    const card = document.createElement("div");
    card.className = "task-card";
    card.innerHTML = `
      <div class="task-card-header">
        <span class="task-card-title">${escapeHtml(task.title)}</span>
        <span class="task-card-status ${task.status}">${statusLabel(task.status)}</span>
      </div>
      <div class="task-card-meta">${elapsed(task.startTime)}</div>
    `;
    panel.appendChild(card);
  }
}

function statusLabel(s) {
  const map = { running: "运行中", done: "已完成", failed: "失败", pending: "待确认" };
  return map[s] || s;
}

function elapsed(startTime) {
  const sec = Math.floor((Date.now() - startTime) / 1000);
  if (sec < 60) return `${sec}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分${sec % 60}秒`;
  return `${Math.floor(sec / 3600)}时${Math.floor((sec % 3600) / 60)}分`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
