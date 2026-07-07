import { t } from "../i18n/index.js";
import { showToast } from "./toast.js";
import { confirmDialog } from "./confirm-dialog.js";
import { revealLocalFileInFolder } from "./file-reveal.js";

export function renderChangedFilesGroup(entries, sealed, ctx = {}, {
  translate = t,
  revealFile = revealLocalFileInFolder,
  confirm = confirmDialog,
  toast = showToast,
  assistantClient = globalThis.window?.assistantClient,
} = {}) {
  const details = document.createElement("details");
  details.className = "assistant-process-group assistant-process-group-changes";
  details.open = false;
  const summary = document.createElement("summary");
  summary.textContent = translate("timeline.changedFiles", { count: entries.length });
  details.appendChild(summary);
  const list = document.createElement("div");
  list.className = "assistant-process-changes-list";
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "assistant-process-change-row is-clickable";
    row.textContent = entry.fileName || entry.filePath || "";
    row.title = `${entry.filePath || ""} — ${translate("file.reveal")}`;
    if (entry.filePath) {
      row.addEventListener("click", () => void revealFile(entry.filePath));
    }
    list.appendChild(row);
  }
  details.appendChild(list);
  if (ctx.sessionId && ctx.turnId) {
    const revertBtn = document.createElement("button");
    revertBtn.className = "assistant-turn-revert-btn";
    revertBtn.textContent = translate("timeline.revertTurn");
    revertBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      // Toggle: after a revert the same button undoes it (one-shot stash).
      if (revertBtn.dataset.reverted === "true") {
        const undo = await assistantClient.unrevertTurn(ctx.sessionId, ctx.turnId);
        if (undo?.ok) {
          revertBtn.dataset.reverted = "false";
          revertBtn.textContent = translate("timeline.revertTurn");
          toast(translate("timeline.revertTurnUndone"), "success");
        } else {
          toast(translate("timeline.revertTurnUndoFailed"), "error");
        }
        return;
      }
      const confirmed = await confirm({
        title: translate("timeline.revertTurnConfirmTitle"),
        message: translate("timeline.revertTurnConfirmMessage", { count: entries.length }),
        danger: true,
      });
      if (!confirmed) return;
      const result = await assistantClient.revertTurn(ctx.sessionId, ctx.turnId);
      if (result?.ok) {
        revertBtn.dataset.reverted = "true";
        revertBtn.textContent = translate("timeline.revertTurnUndo");
        toast(translate("timeline.revertTurnDone"), "success");
      } else {
        const failedNames = (result?.failed || []).map((item) => item.filePath).join(", ");
        toast(translate("timeline.revertTurnFailed", { files: failedNames }), "error");
      }
    });
    details.appendChild(revertBtn);
  }
  return details;
}
