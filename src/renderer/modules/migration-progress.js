// Non-blocking migration progress indicator. Shown only when there is a real
// backlog of legacy sessions to migrate (the main process gates by count); the
// app stays fully usable while it ticks. Auto-hides shortly after completion.

import { getLocale } from "../i18n/index.js";

function label(done, total) {
  const zh = getLocale() === "zh-CN";
  if (done >= total) return zh ? "历史会话优化完成" : "History optimized";
  return zh
    ? `正在优化历史会话… ${done}/${total}`
    : `Optimizing history… ${done}/${total}`;
}

let el = null;
let barFill = null;
let textNode = null;
let hideTimer = null;

function ensureEl() {
  if (el) return el;
  el = document.createElement("div");
  el.className = "migration-progress";
  el.setAttribute("role", "status");
  el.hidden = true;

  textNode = document.createElement("div");
  textNode.className = "migration-progress-text";

  const track = document.createElement("div");
  track.className = "migration-progress-track";
  barFill = document.createElement("div");
  barFill.className = "migration-progress-fill";
  track.appendChild(barFill);

  el.append(textNode, track);
  document.body.appendChild(el);
  return el;
}

function render({ phase, done, total }) {
  if (!total) return;
  ensureEl();
  textNode.textContent = label(done, total);
  barFill.style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
  el.hidden = false;
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (phase === "done" || done >= total) {
    barFill.style.width = "100%";
    hideTimer = setTimeout(() => {
      if (el) el.hidden = true;
    }, 2500);
  }
}

export function initMigrationProgress() {
  window.assistantClient.onMigrationProgress?.((payload) => {
    if (payload && Number.isFinite(payload.total)) render(payload);
  });
}
