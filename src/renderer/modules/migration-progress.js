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
  el.style.cssText =
    "position:fixed;bottom:16px;left:16px;z-index:9999;display:none;" +
    "min-width:220px;max-width:320px;padding:10px 12px;border-radius:10px;" +
    "background:rgba(23,26,33,.96);color:#e6e8ec;border:1px solid #2a2f3a;" +
    "box-shadow:0 6px 24px rgba(0,0,0,.35);font-size:12.5px;backdrop-filter:blur(4px);";

  textNode = document.createElement("div");
  textNode.style.cssText = "margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";

  const track = document.createElement("div");
  track.style.cssText = "height:4px;border-radius:3px;background:#2a2f3a;overflow:hidden;";
  barFill = document.createElement("div");
  barFill.style.cssText = "height:100%;width:0%;background:#5b9dff;border-radius:3px;transition:width .25s ease;";
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
  el.style.display = "block";
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (phase === "done" || done >= total) {
    barFill.style.width = "100%";
    hideTimer = setTimeout(() => {
      if (el) el.style.display = "none";
    }, 2500);
  }
}

export function initMigrationProgress() {
  window.assistantClient.onMigrationProgress?.((payload) => {
    if (payload && Number.isFinite(payload.total)) render(payload);
  });
}
