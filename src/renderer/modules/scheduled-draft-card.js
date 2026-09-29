/**
 * The "自动执行" confirmation card for a scheduled-task draft: title, schedule,
 * next run, scope, and create / decline (or the outcome once decided). It
 * stands alone for a draft the pre-engine check made, and sits under the
 * answer for one the agent proposed (lily_schedule_propose). Split from
 * message.js.
 */
import { t } from "../i18n/index.js";
import { formatScheduledDraftDateTime, scheduledDraftPreviewModel } from "./message-committed-render-model.js";
import { createScheduledDraftFromMessage, rejectScheduledDraftFromMessage } from "./scheduled-draft-actions.js";

export function buildScheduledDraftCard({ sessionId, message, syncCommittedMessages, renderConversation }) {
  const preview = scheduledDraftPreviewModel(message);
  const shell = document.createElement("div");
  shell.className = "scheduled-draft-chat-card";

  const title = document.createElement("div");
  title.className = "scheduled-draft-title";
  title.textContent = preview.created
    ? t("scheduled.cardCreatedTitle")
    : preview.rejected
      ? t("scheduled.cardRejectedTitle")
      : t("scheduled.cardTitle");
  shell.appendChild(title);

  const rows = document.createElement("div");
  rows.className = "scheduled-draft-rows";
  appendScheduledDraftRow(rows, t("scheduled.previewTitle"), preview.title || t("scheduled.untitled"));
  appendScheduledDraftRow(rows, t("scheduled.previewSchedule"), preview.scheduleText);
  appendScheduledDraftRow(rows, t("scheduled.previewNextRun"), formatScheduledDraftDateTime(preview.nextRunAt));
  appendScheduledDraftRow(rows, t("scheduled.previewScope"), t("scheduled.previewScopeValue"));
  shell.appendChild(rows);

  const actions = document.createElement("div");
  actions.className = "scheduled-draft-actions";

  if (preview.created || preview.rejected) {
    const pill = document.createElement("span");
    pill.className = "scheduled-draft-pill";
    pill.textContent = preview.created ? t("scheduled.created") : t("scheduled.cardRejected");
    actions.appendChild(pill);
  } else {
    const create = document.createElement("button");
    create.type = "button";
    create.className = "button-primary";
    create.textContent = t("scheduled.cardCreate");
    create.addEventListener("click", () => void createScheduledDraftFromMessage({
      sessionId, messageId: message.id, button: create, syncCommittedMessages, renderConversation,
    }));
    actions.appendChild(create);
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "button-secondary";
    reject.disabled = preview.rejecting;
    reject.textContent = preview.rejecting ? t("scheduled.cardRejecting") : t("scheduled.cardReject");
    reject.addEventListener("click", () => void rejectScheduledDraftFromMessage({
      sessionId, messageId: message.id, button: reject, syncCommittedMessages, renderConversation,
    }));
    actions.appendChild(reject);
  }
  shell.appendChild(actions);
  return shell;
}

function appendScheduledDraftRow(container, label, value) {
  if (!value) return;
  const row = document.createElement("div");
  row.className = "scheduled-draft-row";
  const key = document.createElement("span");
  key.textContent = label;
  const val = document.createElement("strong");
  val.textContent = value;
  row.append(key, val);
  container.appendChild(row);
}

