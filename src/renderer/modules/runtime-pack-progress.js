import { t } from "../i18n/index.js";
import { runtimePackLabel } from "./runtime-pack-preflight-ui.js";

const TERMINAL_PHASES = new Set(["installed", "skipped", "failed"]);

const activeProgress = new Map();
const cleanupTimers = new Map();

let root = null;
let titleEl = null;
let metaEl = null;
let fillEl = null;
let initialized = false;

function ensureElement() {
  if (root) return;
  root = document.createElement("div");
  root.className = "runtime-pack-progress-main";
  root.hidden = true;
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  root.innerHTML = `
    <div class="runtime-pack-progress-main-title"></div>
    <div class="runtime-pack-progress-main-meta"></div>
    <div class="runtime-pack-progress-main-track">
      <div class="runtime-pack-progress-main-fill"></div>
    </div>
  `;
  titleEl = root.querySelector(".runtime-pack-progress-main-title");
  metaEl = root.querySelector(".runtime-pack-progress-main-meta");
  fillEl = root.querySelector(".runtime-pack-progress-main-fill");
  document.body.appendChild(root);
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = size >= 10 || unit === 0 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unit]}`;
}

function progressPercent(progress) {
  if (progress?.phase === "extracting" && progress?.totalEntries) {
    const totalEntries = Number(progress.totalEntries || 0);
    const processedEntries = Number(progress.processedEntries || 0);
    if (Number.isFinite(totalEntries) && totalEntries > 0) {
      return Math.max(0, Math.min(100, Math.round((processedEntries / totalEntries) * 100)));
    }
  }
  const total = Number(progress?.totalBytes || 0);
  const written = Number(progress?.writtenBytes || 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(written) || written <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((written / total) * 100)));
}

function phaseLabel(progress) {
  const phase = progress?.phase || "";
  const percent = progressPercent(progress);
  if (phase === "downloading" && percent !== null) {
    return t("settings.runtime.phase.downloadingPercent", { percent });
  }
  if (phase === "extracting" && progress?.totalEntries) {
    return t("settings.runtime.phase.extractingEntries", {
      done: Number(progress.processedEntries || 0),
      total: Number(progress.totalEntries || 0),
    });
  }
  if (phase === "extracting" && progress?.backend) {
    return t("settings.runtime.phase.extractingWithBackend", { backend: progress.backend });
  }
  const key = `settings.runtime.phase.${phase}`;
  const label = t(key);
  return label === key ? phase : label;
}

function progressMeta(progress) {
  const parts = [phaseLabel(progress)];
  if (progress?.totalBytes) {
    parts.push(t("runtimeProgress.bytes", {
      done: formatBytes(progress.writtenBytes || 0),
      total: formatBytes(progress.totalBytes),
    }));
  }
  if (progress?.phase === "extracting" && progress?.elapsedMs && !progress?.totalEntries) {
    parts.push(t("runtimeProgress.elapsed", {
      seconds: Math.max(1, Math.round(Number(progress.elapsedMs || 0) / 1000)),
    }));
  }
  if (progress?.error) parts.push(progress.error);
  return parts.filter(Boolean).join(" · ");
}

function latestProgress() {
  return [...activeProgress.values()]
    .sort((a, b) => String(b?.at || "").localeCompare(String(a?.at || "")))[0] || null;
}

function render() {
  ensureElement();
  if (!activeProgress.size) {
    root.hidden = true;
    return;
  }

  const progress = latestProgress();
  if (!progress) {
    root.hidden = true;
    return;
  }

  const name = runtimePackLabel(progress) || progress.id || "";
  const terminal = TERMINAL_PHASES.has(progress.phase);
  const failed = progress.phase === "failed";
  const percent = progressPercent(progress);

  root.hidden = false;
  root.classList.toggle("runtime-pack-progress-main--failed", failed);
  root.classList.toggle("runtime-pack-progress-main--indeterminate", percent === null && !terminal);

  titleEl.textContent = failed
    ? t("runtimeProgress.failed", { name })
    : terminal
      ? t("runtimeProgress.done", { name })
      : activeProgress.size > 1
        ? t("runtimeProgress.multiple", { count: activeProgress.size })
        : t("runtimeProgress.title", { name });
  metaEl.textContent = progressMeta(progress);
  fillEl.style.width = percent === null ? "" : `${percent}%`;
}

function handleProgress(eventOrProgress, maybeProgress) {
  const progress = maybeProgress || eventOrProgress;
  if (!progress?.id) return;

  ensureElement();
  const id = progress.id;
  if (cleanupTimers.has(id)) {
    clearTimeout(cleanupTimers.get(id));
    cleanupTimers.delete(id);
  }

  activeProgress.set(id, progress);
  if (TERMINAL_PHASES.has(progress.phase)) {
    cleanupTimers.set(id, setTimeout(() => {
      cleanupTimers.delete(id);
      activeProgress.delete(id);
      render();
    }, 2600));
  }
  render();
}

export function initRuntimePackProgress() {
  if (initialized) return;
  initialized = true;
  if (!window.assistantClient?.onRuntimePackProgress) return;
  ensureElement();
  window.assistantClient.onRuntimePackProgress(handleProgress);
}
