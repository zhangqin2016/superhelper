/**
 * Runtime Center (settings panel).
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import { t, getLocale } from "../i18n/index.js";
import { confirmDialog } from "./confirm-dialog.js";
import { revealLocalFileInFolder } from "./file-reveal.js";

let lastData = null;
const progressById = new Map();
let progressUnsubscribe = null;

function healthLabel(health) {
  if (!health) return "";
  if (health.status === "ok" || health.ok) return t("settings.runtime.health.ok");
  if (health.status === "not_installed") return t("settings.runtime.health.notInstalled");
  return t("settings.runtime.health.failed");
}

function healthChipClass(health) {
  if (!health) return "runtime-pack-chip";
  if (health.status === "ok" || health.ok) return "runtime-pack-chip runtime-pack-chip--success";
  if (health.status === "not_installed") return "runtime-pack-chip";
  return "runtime-pack-chip runtime-pack-chip--danger";
}

function healthDetail(health) {
  if (!health || health.ok || health.status === "not_installed") return "";
  const failed = Array.isArray(health.checks) ? health.checks.find((check) => !check.ok) : null;
  return failed?.error || health.error || "";
}

function localized(value) {
  if (!value || typeof value !== "object") return "";
  const locale = getLocale();
  return value[locale] || value.en || value["zh-CN"] || Object.values(value).find(Boolean) || "";
}

function phaseLabel(progress) {
  if (!progress?.phase) return "";
  if (progress.phase === "downloading" && progress.totalBytes) {
    const pct = Math.max(0, Math.min(100, Math.round((Number(progress.writtenBytes || 0) / Number(progress.totalBytes)) * 100)));
    return t("settings.runtime.phase.downloadingPercent", { percent: pct });
  }
  if (progress.phase === "extracting" && progress.totalEntries) {
    return t("settings.runtime.phase.extractingEntries", {
      done: Number(progress.processedEntries || 0),
      total: Number(progress.totalEntries || 0),
    });
  }
  if (progress.phase === "extracting" && progress.backend) {
    return t("settings.runtime.phase.extractingWithBackend", { backend: progress.backend });
  }
  const key = `settings.runtime.phase.${progress.phase}`;
  const label = t(key);
  return label === key ? progress.phase : label;
}

function errorMessage(error) {
  const key = `settings.runtime.error.${error || "GENERIC"}`;
  const mapped = t(key);
  return mapped === key ? t("settings.runtime.error.GENERIC") : mapped;
}

function setHint(message, kind = "") {
  const hint = $("runtimePackHint");
  if (!hint) return;
  hint.textContent = message || "";
  hint.hidden = !message;
  hint.classList.toggle("settings-form-status--error", kind === "error");
  hint.classList.toggle("settings-form-status--success", kind === "success");
}

function renderEmpty(message) {
  const list = $("runtimePackList");
  if (!list) return;
  list.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "runtime-pack-empty";
  empty.textContent = message;
  list.append(empty);
}

function statusText(pack) {
  const progress = progressById.get(pack.id);
  if (progress && !["installed", "failed", "skipped"].includes(progress.phase)) {
    return phaseLabel(progress);
  }
  if (pack.readOnly || pack.source === "bundled") return t("settings.runtime.status.bundled");
  if (pack.installed) return t("settings.runtime.status.installed");
  if (pack.missingFiles) return t("settings.runtime.status.missing");
  if (isUnavailableOnPlatform(pack)) return t("settings.runtime.status.unavailable");
  return t("settings.runtime.status.notInstalled");
}

function appendChip(parent, text, className = "runtime-pack-chip") {
  if (!text) return;
  const chip = document.createElement("span");
  chip.className = className;
  chip.textContent = text;
  parent.append(chip);
}

function button(label, className = "settings-action-btn") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = label;
  return btn;
}

function isBusy(pack) {
  const phase = progressById.get(pack.id)?.phase;
  return Boolean(phase && !["installed", "failed", "skipped"].includes(phase));
}

function isUnavailableOnPlatform(pack) {
  return pack?.availability?.available === false && pack.availability.error === "NO_RUNTIME_PACK_ARTIFACT";
}

function renderPackCard(pack) {
  const card = document.createElement("article");
  card.className = "runtime-pack-card";
  card.dataset.packId = pack.id;

  const header = document.createElement("div");
  header.className = "runtime-pack-card-header";

  const titleBox = document.createElement("div");
  titleBox.className = "runtime-pack-titlebox";

  const title = document.createElement("h4");
  title.className = "runtime-pack-title";
  title.textContent = localized(pack.label) || pack.id;

  const meta = document.createElement("p");
  meta.className = "runtime-pack-meta";
  meta.textContent = [
    pack.id,
    pack.version ? t("settings.runtime.version", { version: pack.version }) : "",
    pack.sizeEstimate || "",
  ].filter(Boolean).join(" · ");

  titleBox.append(title, meta);

  const chips = document.createElement("div");
  chips.className = "runtime-pack-chips";
  appendChip(chips, statusText(pack), pack.installed ? "runtime-pack-chip runtime-pack-chip--accent" : "runtime-pack-chip");
  if (pack.recommended) appendChip(chips, t("settings.runtime.recommended"), "runtime-pack-chip runtime-pack-chip--accent");
  if (pack.health && pack.installed) appendChip(chips, healthLabel(pack.health), healthChipClass(pack.health));

  header.append(titleBox, chips);

  const desc = document.createElement("p");
  desc.className = "runtime-pack-summary";
  desc.textContent = localized(pack.description);

  const actions = document.createElement("div");
  actions.className = "runtime-pack-card-actions";

  if (pack.installed) {
    if (pack.path) {
      const reveal = button(t("settings.runtime.openFolder"));
      reveal.addEventListener("click", () => void revealLocalFileInFolder(pack.path));
      actions.append(reveal);
    }
    if (!pack.readOnly) {
      const uninstall = button(t("settings.runtime.uninstall"));
      uninstall.disabled = isBusy(pack);
      uninstall.addEventListener("click", () => void uninstallRuntimePack(pack));
      actions.append(uninstall);
    }
  } else {
    const install = button(t("settings.runtime.install"), "settings-action-btn settings-action-btn--primary runtime-pack-install");
    const unavailable = isUnavailableOnPlatform(pack);
    install.disabled = isBusy(pack) || unavailable;
    if (unavailable) {
      install.dataset.unavailable = "1";
      install.textContent = statusText(pack);
      install.title = errorMessage(pack.availability?.error);
    } else if (isBusy(pack)) {
      install.dataset.busy = "1";
      install.textContent = statusText(pack);
    }
    install.addEventListener("click", () => void installRuntimePack(pack));
    actions.append(install);
  }

  const progress = progressById.get(pack.id);
  const progressEl = document.createElement("p");
  progressEl.className = "runtime-pack-progress";
  progressEl.textContent = progress ? phaseLabel(progress) : healthDetail(pack.health);
  progressEl.hidden = !progressEl.textContent;

  card.append(header, desc, actions, progressEl);
  return card;
}

function renderRuntimePacks(data) {
  const list = $("runtimePackList");
  if (!list) return;
  const packs = Array.isArray(data?.packs) ? data.packs : [];
  if (!packs.length) {
    renderEmpty(t("settings.runtime.empty"));
    return;
  }
  list.replaceChildren();
  const categories = Array.isArray(data.categories) ? data.categories : [];
  const knownCategories = new Set(categories.map((category) => category.id));
  const orderedCategories = [
    ...categories,
    ...(packs.some((pack) => !knownCategories.has(pack.category)) ? [{ id: "other", label: {} }] : []),
  ];
  for (const category of orderedCategories) {
    const groupPacks = packs.filter((pack) => (pack.category || "other") === category.id);
    if (!groupPacks.length) continue;
    const group = document.createElement("section");
    group.className = "runtime-pack-group";

    const heading = document.createElement("h4");
    heading.className = "runtime-pack-group-title";
    heading.textContent = localized(category.label) || t(`settings.runtime.category.${category.id}`) || category.id;
    group.append(heading);

    const grid = document.createElement("div");
    grid.className = "runtime-pack-grid";
    for (const pack of groupPacks) grid.append(renderPackCard(pack));
    group.append(grid);
    list.append(group);
  }
}

function runtimePackById(packId) {
  return Array.isArray(lastData?.packs)
    ? lastData.packs.find((pack) => pack.id === packId) || null
    : null;
}

function runtimePackCardById(packId) {
  const list = $("runtimePackList");
  if (!list) return null;
  return Array.from(list.querySelectorAll(".runtime-pack-card"))
    .find((card) => card.dataset.packId === packId) || null;
}

function renderRuntimePackCardInPlace(packId) {
  const pack = runtimePackById(packId);
  const card = runtimePackCardById(packId);
  if (!pack || !card) return false;
  card.replaceWith(renderPackCard(pack));
  return true;
}

function updateRuntimePackCard(packId) {
  if (!renderRuntimePackCardInPlace(packId) && lastData) {
    renderRuntimePacks(lastData);
  }
}

function updateRuntimePackCards(packIds) {
  const ids = [...new Set((Array.isArray(packIds) ? packIds : []).filter(Boolean))];
  if (!ids.length) return true;
  const allUpdated = ids.every((id) => renderRuntimePackCardInPlace(id));
  if (!allUpdated && lastData) renderRuntimePacks(lastData);
  return allUpdated;
}

async function installRuntimePack(pack) {
  const name = localized(pack.label) || pack.id;
  const ok = await confirmDialog({
    title: t("settings.runtime.confirmInstallTitle", { name }),
    message: t("settings.runtime.confirmInstallMessage", { size: pack.sizeEstimate || t("settings.runtime.sizeUnknown") }),
    confirmText: t("settings.runtime.install"),
  });
  if (!ok) return;
  progressById.set(pack.id, { id: pack.id, phase: "resolving" });
  updateRuntimePackCard(pack.id);
  const result = await window.assistantClient.installRuntimePack(pack.id);
  if (!result?.ok) {
    progressById.set(pack.id, { id: pack.id, phase: "failed", error: result?.error });
    showToast(errorMessage(result?.error), "error");
  } else {
    progressById.set(pack.id, { id: pack.id, phase: result.skipped ? "skipped" : "installed" });
    showToast(t("settings.runtime.installDone", { name }), "success");
  }
  updateRuntimePackCard(pack.id);
  await refreshRuntimePackSettings({ patchOnlyIds: [pack.id] });
}

async function uninstallRuntimePack(pack) {
  const name = localized(pack.label) || pack.id;
  const ok = await confirmDialog({
    title: t("settings.runtime.confirmUninstallTitle", { name }),
    message: t("settings.runtime.confirmUninstallMessage"),
    confirmText: t("settings.runtime.uninstall"),
    danger: true,
  });
  if (!ok) return;
  const result = await window.assistantClient.uninstallRuntimePack(pack.id);
  if (!result?.ok) {
    showToast(errorMessage(result?.error), "error");
    return;
  }
  progressById.delete(pack.id);
  showToast(t("settings.runtime.uninstallDone", { name }), "success");
  await refreshRuntimePackSettings();
}

function mergeHealthResult(data, result) {
  if (!data || !Array.isArray(data.packs) || !Array.isArray(result?.packs)) return data;
  const byId = new Map(result.packs.map((pack) => [pack.id, pack]));
  return {
    ...data,
    health: result,
    packs: data.packs.map((pack) => ({ ...pack, health: byId.get(pack.id) || pack.health || null })),
  };
}

function mergeAvailabilityResult(data, result) {
  if (!data || !Array.isArray(data.packs) || !Array.isArray(result?.packs)) return data;
  const byId = new Map(result.packs.map((pack) => [pack.id, pack]));
  return {
    ...data,
    availability: result,
    packs: data.packs.map((pack) => ({ ...pack, availability: byId.get(pack.id) || pack.availability || null })),
  };
}

async function refreshRuntimePackAvailability(data) {
  if (!window.assistantClient?.checkRuntimePackAvailability || !Array.isArray(data?.packs)) return;
  const ids = data.packs
    .filter((pack) => !pack.installed && !pack.readOnly)
    .map((pack) => pack.id)
    .filter(Boolean);
  if (!ids.length) return;
  try {
    const result = await window.assistantClient.checkRuntimePackAvailability(ids);
    if (!result?.ok || result.platform !== data.platform) return;
    lastData = mergeAvailabilityResult(lastData, result);
    updateRuntimePackCards((result.packs || []).map((pack) => pack.id));
  } catch {
    // Availability is a UX preflight only. Install still resolves the artifact
    // authoritatively, so network errors here should not disable usable packs.
  }
}

async function runRuntimeHealthCheck() {
  if (!window.assistantClient?.checkRuntimePackHealth) return;
  setHint(t("settings.runtime.health.checking"));
  try {
    const result = await window.assistantClient.checkRuntimePackHealth();
    if (!result?.ok && !Array.isArray(result?.packs)) {
      setHint(errorMessage(result?.error), "error");
      return;
    }
    lastData = mergeHealthResult(lastData, result);
    updateRuntimePackCards((result.packs || []).map((pack) => pack.id));
    const failed = (result.packs || []).filter((pack) => pack.status !== "not_installed" && !pack.ok).length;
    setHint(
      failed ? t("settings.runtime.health.failedCount", { count: failed }) : t("settings.runtime.health.allOk"),
      failed ? "error" : "success",
    );
  } catch {
    setHint(t("settings.runtime.health.failed"), "error");
  }
}

export async function refreshRuntimePackSettings(options = {}) {
  const list = $("runtimePackList");
  if (!list) return;
  if (typeof window.assistantClient?.listRuntimePacks !== "function") {
    renderEmpty(t("settings.runtime.unavailable"));
    return;
  }
  try {
    const data = await window.assistantClient.listRuntimePacks();
    if (!data?.ok) {
      setHint(errorMessage(data?.error), "error");
      return;
    }
    lastData = data;
    setHint(t("settings.runtime.platform", { platform: data.platform || "-" }));
    if (Array.isArray(options.patchOnlyIds) && options.patchOnlyIds.length) {
      updateRuntimePackCards(options.patchOnlyIds);
    } else {
      renderRuntimePacks(data);
    }
    void refreshRuntimePackAvailability(data);
  } catch {
    setHint(t("settings.runtime.loadFailed"), "error");
  }
}

export function initRuntimePackSettings() {
  $("runtimePacksRefreshBtn")?.addEventListener("click", () => void refreshRuntimePackSettings());
  $("runtimePacksHealthBtn")?.addEventListener("click", () => void runRuntimeHealthCheck());
  if (!progressUnsubscribe && typeof window.assistantClient?.onRuntimePackProgress === "function") {
    progressUnsubscribe = window.assistantClient.onRuntimePackProgress((event) => {
      if (!event?.id) return;
      progressById.set(event.id, event);
      if (lastData) updateRuntimePackCard(event.id);
    });
  }
}
