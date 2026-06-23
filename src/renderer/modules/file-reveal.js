import { t } from "../i18n/index.js";
import { showToast } from "./toast.js";

function revealErrorMessage(error) {
  if (error === "NOT_FOUND") return t("file.revealNotFound");
  if (error === "INVALID_PATH") return t("file.revealInvalidPath");
  return t("file.revealFailed");
}

export async function revealLocalFileInFolder(filePath, sessionId = "") {
  if (!filePath || !window.assistantClient?.revealInFolder) return { ok: false, error: "INVALID_PATH" };
  try {
    const result = await window.assistantClient.revealInFolder(filePath, sessionId);
    if (!result?.ok) {
      showToast(revealErrorMessage(result?.error), "warning");
    }
    return result || { ok: false, error: "UNKNOWN" };
  } catch {
    showToast(t("file.revealFailed"), "warning");
    return { ok: false, error: "FAILED" };
  }
}

export async function openLocalFile(filePath, sessionId = "") {
  if (!filePath || !window.assistantClient?.openLocalFile) return { ok: false, error: "INVALID_PATH" };
  try {
    const result = await window.assistantClient.openLocalFile(filePath, sessionId);
    if (!result?.ok) {
      showToast(revealErrorMessage(result?.error), "warning");
    }
    return result || { ok: false, error: "UNKNOWN" };
  } catch {
    showToast(t("file.revealFailed"), "warning");
    return { ok: false, error: "FAILED" };
  }
}
