// Non-blocking indicator for one-time startup maintenance: the legacy session
// import, and the artifact backfill a schema bump triggers. Shown only when
// there is a real backlog (the main process gates by count); the app stays
// fully usable while it ticks, and it auto-hides shortly after completion.
//
// The backfill reports here because of what its silence cost: a customer saw a
// window Windows labelled 未响应 and had no way to know the app was re-deriving
// 1450 records. Naming the work is what turns a freeze into a wait.

import { t } from "../i18n/index.js";

function label(done, total, kind) {
  const suffix = kind === "enrichment" ? "Enrichment" : "";
  if (done >= total) return t(`migration.done${suffix}`);
  return t(`migration.progress${suffix}`, { done, total });
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

function render({ phase, done, total, kind }) {
  if (!total) return;
  ensureEl();
  textNode.textContent = label(done, total, kind);
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
