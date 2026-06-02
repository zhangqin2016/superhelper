/**
 * License activation and static update checks in About settings.
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import { t } from "../i18n/index.js";

let latestPackageUrl = "";

function licenseErrorMessage(error) {
  const key = `license.error.${error || "GENERIC"}`;
  const text = t(key);
  return text === key ? t("license.error.GENERIC") : text;
}

function updateErrorMessage(error) {
  const key = `update.error.${error || "GENERIC"}`;
  const text = t(key);
  return text === key ? t("update.error.GENERIC") : text;
}

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString();
}

export async function refreshLicenseStatus() {
  const el = $("licenseStatusText");
  if (!el) return;
  const status = await window.assistantClient.getLicenseStatus();
  if (!status?.activated) {
    el.textContent = t("settings.licenseInactive");
    return;
  }
  if (status.valid) {
    el.textContent = t("settings.licenseValid", {
      customer: status.license?.customer || status.license?.licenseId || "",
      expiresAt: formatDate(status.license?.expiresAt),
      plan: status.license?.plan || "",
    });
  } else {
    el.textContent = t("settings.licenseInvalid", {
      error: licenseErrorMessage(status.error),
    });
  }
}

export async function refreshUpdateSettings() {
  const input = $("updateManifestUrl");
  if (!input) return;
  const result = await window.assistantClient.getUpdateSettings();
  if (result?.ok) input.value = result.manifestUrl || "";
}

async function saveUpdateSettings() {
  const manifestUrl = $("updateManifestUrl")?.value?.trim() || "";
  const result = await window.assistantClient.setUpdateSettings({ manifestUrl });
  if (!result?.ok) {
    showToast(updateErrorMessage(result?.error), "error");
    return false;
  }
  showToast(t("toast.updateSettingsSaved"), "success");
  return true;
}

async function checkUpdates() {
  latestPackageUrl = "";
  const downloadBtn = $("updateDownloadBtn");
  if (downloadBtn) downloadBtn.hidden = true;
  const statusEl = $("updateStatusText");
  if (statusEl) statusEl.textContent = t("settings.updateChecking");

  const saved = await saveUpdateSettings();
  if (!saved) return;

  const result = await window.assistantClient.checkForUpdates();
  if (!result?.ok) {
    if (statusEl) statusEl.textContent = updateErrorMessage(result?.error);
    showToast(updateErrorMessage(result?.error), "error");
    return;
  }

  if (!result.hasUpdate) {
    if (statusEl) {
      statusEl.textContent = t("settings.updateLatest", {
        version: result.currentVersion,
      });
    }
    showToast(t("toast.updateAlreadyLatest"), "success");
    return;
  }

  latestPackageUrl = result.package?.url || "";
  if (statusEl) {
    statusEl.textContent = t("settings.updateAvailable", {
      current: result.currentVersion,
      latest: result.latestVersion,
    });
  }
  if (downloadBtn) downloadBtn.hidden = !latestPackageUrl;
  showToast(t("toast.updateAvailable"), "info");
}

export function initLicenseUpdateSettings() {
  $("licenseActivateBtn")?.addEventListener("click", async () => {
    const token = $("licenseTokenInput")?.value?.trim() || "";
    if (!token) {
      showToast(t("license.error.INVALID_FORMAT"), "error");
      return;
    }
    const result = await window.assistantClient.activateLicense(token);
    if (!result?.ok) {
      showToast(licenseErrorMessage(result?.error), "error");
      await refreshLicenseStatus();
      return;
    }
    $("licenseTokenInput").value = "";
    await refreshLicenseStatus();
    showToast(t("toast.licenseActivated"), "success");
  });

  $("licenseClearBtn")?.addEventListener("click", async () => {
    await window.assistantClient.clearLicense();
    await refreshLicenseStatus();
    showToast(t("toast.licenseCleared"), "info");
  });

  $("updateSaveBtn")?.addEventListener("click", () => void saveUpdateSettings());
  $("updateCheckBtn")?.addEventListener("click", () => void checkUpdates());
  $("updateDownloadBtn")?.addEventListener("click", async () => {
    if (!latestPackageUrl) return;
    const result = await window.assistantClient.openUpdateDownload(latestPackageUrl);
    if (!result?.ok) showToast(updateErrorMessage(result?.error), "error");
  });
}
