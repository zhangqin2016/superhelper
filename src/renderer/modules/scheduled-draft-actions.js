import { showToast } from "./toast.js";
import { t } from "../i18n/index.js";

function syncConversation(sessionId, conversation, syncCommittedMessages, renderConversation) {
  if (!Array.isArray(conversation)) return;
  syncCommittedMessages(sessionId, conversation);
  renderConversation(sessionId, { force: true, forceScrollBottom: true });
}

export async function createScheduledDraftFromMessage({
  sessionId,
  messageId,
  button,
  syncCommittedMessages,
  renderConversation,
} = {}) {
  if (!sessionId || !messageId || !window.assistantClient?.createScheduledTaskFromDraftMessage) return;
  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = t("scheduled.creating");
  }
  try {
    const result = await window.assistantClient.createScheduledTaskFromDraftMessage({ sessionId, messageId });
    if (!result?.ok) {
      showToast(t("scheduled.createFailed"), "error");
      return;
    }
    syncConversation(sessionId, result.conversation, syncCommittedMessages, renderConversation);
    showToast(t("scheduled.created"), "success");
  } catch (error) {
    showToast(error?.message || t("scheduled.createFailed"), "error");
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

export async function rejectScheduledDraftFromMessage({
  sessionId,
  messageId,
  button,
  syncCommittedMessages,
  renderConversation,
} = {}) {
  if (!sessionId || !messageId || !window.assistantClient?.rejectScheduledTaskDraftMessage) return;
  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = t("scheduled.cardRejecting");
  }
  try {
    const result = await window.assistantClient.rejectScheduledTaskDraftMessage({ sessionId, messageId });
    if (!result?.ok) {
      showToast(result?.detail || result?.error || t("scheduled.cardRejectFailed"), "error");
      return;
    }
    syncConversation(sessionId, result.conversation, syncCommittedMessages, renderConversation);
  } catch (error) {
    showToast(error?.message || t("scheduled.cardRejectFailed"), "error");
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}
