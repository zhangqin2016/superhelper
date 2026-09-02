import { t } from "../i18n/index.js";
import { formatBytes } from "./format-bytes.js";
import { runtimePackLabel } from "./runtime-pack-preflight-ui.js";
import { openSettingsPage } from "./settings-panel.js";

// Home-surface dependency progress: a small ring next to the sidebar settings
// button, NOT a floating banner. Installs are background plumbing — the user
// asked for "一个小圆圈进度" by the config entry, with details one click away
// (the ring opens Settings → 依赖). Hover shows phase + bytes as a tooltip.

const TERMINAL_PHASES = new Set(["installed", "skipped", "failed"]);
const ACTIVE_VISIBLE_PHASES = new Set([
  "resolving",
  "downloading",
  "verifying",
  "extracting",
  "health-checking",
  "refreshing",
  "installed",
  "failed",
]);

// Failed states must clear on their own: a stale red indicator that outlives
// the incident reads as "the product is broken" forever.
const DONE_CLEAR_MS = 2600;
const FAILED_CLEAR_MS = 12_000;

const RING_RADIUS = 13;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const activeProgress = new Map();
const cleanupTimers = new Map();

let root = null;
let arcEl = null;
let labelEl = null;
let initialized = false;

function ensureElement() {
  if (root && root.isConnected) return;
  if (!root) {
    root = document.createElement("button");
    root.type = "button";
    root.className = "runtime-pack-progress-main";
    root.hidden = true;
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");
    root.innerHTML = `
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <circle class="runtime-pack-progress-main-track" cx="16" cy="16" r="${RING_RADIUS}" />
        <circle class="runtime-pack-progress-main-fill" cx="16" cy="16" r="${RING_RADIUS}"
          stroke-dasharray="${RING_CIRCUMFERENCE.toFixed(2)}" stroke-dashoffset="${RING_CIRCUMFERENCE.toFixed(2)}" />
      </svg>
      <span class="runtime-pack-progress-main-label"></span>
    `;
    arcEl = root.querySelector(".runtime-pack-progress-main-fill");
    labelEl = root.querySelector(".runtime-pack-progress-main-label");
    root.addEventListener("click", () => {
      try {
        openSettingsPage("runtime");
      } catch {
        // The ring is informational; a failed navigation must not throw.
      }
    });
  }
  // Anchor the runtime-progress ring next to the footer account button (the
  // 设置 button moved into the account-menu popover).
  const footerBtn = document.getElementById("accountMenuBtn") || document.getElementById("settingsBtn");
  if (footerBtn?.parentElement) {
    footerBtn.parentElement.classList.add("left-footer--with-runtime-progress");
    footerBtn.insertAdjacentElement("afterend", root);
  } else {
    document.body.appendChild(root);
  }
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

function latestVisibleProgress() {
  return [...activeProgress.values()]
    .filter((progress) => ACTIVE_VISIBLE_PHASES.has(progress?.phase))
    .sort((a, b) => String(b?.at || "").localeCompare(String(a?.at || "")))[0] || null;
}

function progressGroup(progress) {
  return progress?.turnId || progress?.jobId || "settings";
}

function progressTitle(progress) {
  const name = runtimePackLabel(progress) || progress.id || "";
  const failed = progress.phase === "failed";
  const count = [...activeProgress.values()].filter((item) => (
    ACTIVE_VISIBLE_PHASES.has(item?.phase) && progressGroup(item) === progressGroup(progress)
  )).length;
  if (count > 1 && !failed && progress.phase !== "installed") {
    return t("runtimeProgress.multiple", { count });
  }
  const titleKey = failed
    ? "runtimeProgress.degraded"
    : progress.phase === "installed"
      ? "runtimeProgress.ready"
      : progress.phase === "refreshing"
        ? "runtimeProgress.refreshing"
        : "runtimeProgress.preparing";
  return t(titleKey, { name });
}

function render() {
  ensureElement();
  const progress = activeProgress.size ? latestVisibleProgress() : null;
  if (!progress) {
    root.hidden = true;
    return;
  }

  const failed = progress.phase === "failed";
  const done = progress.phase === "installed";
  const percent = progressPercent(progress);

  root.hidden = false;
  root.classList.toggle("runtime-pack-progress-main--failed", failed);
  root.classList.toggle("runtime-pack-progress-main--done", done);
  root.classList.toggle(
    "runtime-pack-progress-main--indeterminate",
    percent === null && !failed && !done,
  );

  if (failed || done) {
    arcEl.style.strokeDashoffset = "0";
    labelEl.textContent = failed ? "!" : "✓";
  } else if (percent === null) {
    // Indeterminate: CSS spins a fixed arc; keep the center quiet.
    arcEl.style.strokeDashoffset = String((RING_CIRCUMFERENCE * 0.72).toFixed(2));
    labelEl.textContent = "";
  } else {
    arcEl.style.strokeDashoffset = String((RING_CIRCUMFERENCE * (1 - percent / 100)).toFixed(2));
    labelEl.textContent = String(percent);
  }

  const tooltip = [progressTitle(progress), progressMeta(progress)].filter(Boolean).join(" · ");
  root.title = tooltip;
  root.setAttribute("aria-label", tooltip);
}

function scheduleCleanup(key, delayMs) {
  cleanupTimers.set(key, setTimeout(() => {
    cleanupTimers.delete(key);
    activeProgress.delete(key);
    render();
  }, delayMs));
}

function handleProgress(eventOrProgress, maybeProgress) {
  const progress = maybeProgress || eventOrProgress;
  if (!progress?.id) return;

  ensureElement();
  const key = `${progressGroup(progress)}:${progress.id}`;
  if (progress.phase !== "failed") {
    for (const [existingKey, existing] of activeProgress) {
      if (existing?.phase === "failed" && progressGroup(existing) !== progressGroup(progress)) {
        activeProgress.delete(existingKey);
      }
    }
  }
  if (cleanupTimers.has(key)) {
    clearTimeout(cleanupTimers.get(key));
    cleanupTimers.delete(key);
  }

  activeProgress.set(key, progress);
  if (progress.phase === "installed" || progress.phase === "skipped") {
    scheduleCleanup(key, DONE_CLEAR_MS);
  } else if (progress.phase === "failed") {
    scheduleCleanup(key, FAILED_CLEAR_MS);
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
