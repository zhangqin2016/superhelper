import { getLocale, t } from "../i18n/index.js";
import { confirmDialog } from "./confirm-dialog.js";
import { showToast } from "./toast.js";

export function runtimePackLabel(pack) {
  const label = pack?.label;
  if (label && typeof label === "object") {
    const locale = getLocale();
    return label[locale] || label["zh-CN"] || label.en || Object.values(label).find(Boolean) || pack.id;
  }
  return String(label || pack?.id || "");
}

export function runtimePackDisplayText(pack) {
  const size = pack?.sizeEstimate || t("settings.runtime.sizeUnknown");
  return `${runtimePackLabel(pack)} (${size})`;
}

function runtimePackErrorMessage(error) {
  const key = `settings.runtime.error.${error}`;
  const mapped = t(key);
  return mapped === key ? (error || t("settings.runtime.error.GENERIC")) : mapped;
}

export async function loadRuntimePackPreflight(payload = {}) {
  if (!window.assistantClient?.preflightRuntimePacks) {
    return { ok: true, missingPacks: [] };
  }
  return window.assistantClient.preflightRuntimePacks(payload);
}

export async function installMissingRuntimePacks(missingPacks = [], options = {}) {
  if (!missingPacks.length || !window.assistantClient?.installRuntimePack) return true;

  for (const pack of missingPacks) {
    const name = runtimePackLabel(pack);
    showToast(t(options.waiting ? "composer.dependencyInstallWaiting" : "composer.dependencyInstallStarted", { name }), "info");
    const result = await window.assistantClient.installRuntimePack(pack.id);
    if (!result?.ok) {
      showToast(t("composer.dependencyInstallFailed", {
        name,
        error: runtimePackErrorMessage(result?.error),
      }), "error");
      return false;
    }
    showToast(t("composer.dependencyInstallDone", { name }), "success");
  }

  return true;
}

export async function ensureRuntimePacks(payload = {}, options = {}) {
  if (!window.assistantClient?.preflightRuntimePacks || !window.assistantClient?.installRuntimePack) {
    return true;
  }

  let preflight;
  try {
    preflight = await loadRuntimePackPreflight(payload);
  } catch {
    showToast(t("composer.dependencyPreflightFailed"), "warning");
    return true;
  }

  if (!preflight?.ok) return true;

  const installingPacks = Array.isArray(preflight?.installingPacks) ? preflight.installingPacks : [];
  if (installingPacks.length) {
    const ok = await installMissingRuntimePacks(installingPacks, { waiting: true });
    if (!ok) return false;
  }

  const missingPacks = Array.isArray(preflight?.missingPacks) ? preflight.missingPacks : [];
  if (missingPacks.length === 0) return true;

  if (options.confirm !== false) {
    const packsText = missingPacks.map(runtimePackDisplayText).join(" / ");
    const shouldInstall = await confirmDialog({
      title: t(options.titleKey || "composer.dependencyPromptTitle"),
      message: t(options.messageKey || "composer.dependencyPromptMessage", { packs: packsText }),
      confirmText: t(options.confirmTextKey || "composer.dependencyPromptInstall"),
      cancelText: t(options.cancelTextKey || "composer.dependencyPromptCancel"),
    });
    if (!shouldInstall) return false;
  }

  return installMissingRuntimePacks(missingPacks);
}
