/**
 * Recovering a local task application that was interrupted.
 *
 * Applying a delivery writes into the user's own workspace, so an interruption
 * leaves changes that only this surface can see and roll back. It is deliberately
 * separate from the task list: the list is about what the other side sent, this
 * is about what is still half-applied here, it has its own entry button and its
 * own surface, and nothing in the list reads its state.
 *
 * The view state it shares with the task panel — busy, phase, the surface node —
 * arrives as accessors rather than being copied, so there is still exactly one
 * of each.
 */
export function createRemoteTaskRecoveries({
  node, tr, shell, notice, button, api, recoveryHeader, recoveryRoot, root, surface, inertNodes,
  userId, isDisposed, isBusy, setBusy, phase, setPhase, clearStatusView, generation, valid, workflowError,
  close, update, setReturnFocus,
}) {
  let localRecoveries = [], recoveryGeneration = 0, recoveryError = "";
  const recoveryEntry = node("button", "collaboration-icon-button remote-task-entry");
  recoveryEntry.type = "button";
  recoveryEntry.dataset.action = "task-local-recovery-entry";
  recoveryEntry.hidden = true;
  recoveryHeader.append(recoveryEntry);

function clearRecoveries() {
  recoveryGeneration++; localRecoveries = []; recoveryError = ""; recoveryEntry.hidden = true;
}
async function refreshRecoveries() {
  const ticket = ++recoveryGeneration, currentUser = userId();
  if (!currentUser || !api()?.taskWorkflow) { localRecoveries = []; recoveryEntry.hidden = true; return; }
  let result;
  try { result = await api().taskWorkflow({ operation: "recoveries" }); } catch { result = null; }
  if (isDisposed() || ticket !== recoveryGeneration || currentUser !== userId()) return;
  localRecoveries = result?.ok ? (result.applications || []).filter(row => row.state !== "rolled_back") : [];
  recoveryEntry.hidden = !localRecoveries.length;
  if (phase() === "localRecovery" && !isBusy()) paintRecoveries();
}
function paintRecoveries() {
  setPhase("localRecovery"); clearStatusView();
  const body = shell(tr("localRecovery"));
  body.append(node("p", "remote-task-subtitle", tr("localRecoveryNote")));
  if (recoveryError) notice(body, recoveryError);
  if (!localRecoveries.length) { notice(body, "noLocalRecovery"); return; }
  const list = node("div", "remote-task-list");
  for (const record of localRecoveries) {
    const card = node("article", "remote-task-card");
    card.append(node("span", "remote-task-status", tr(record.state === "applied" ? "localApplied" : "localInterrupted")), node("h3", "", record.label || tr("localWorkspace")));
    const footer = node("div", "remote-task-card-footer");
    footer.append(node("p", "remote-task-meta", tr("localRecoverySafe")), button("task-local-rollback", tr("rollback"), async () => {
      if (isBusy()) return;
      const ticket = generation(); setBusy(true); recoveryError = ""; paintRecoveries();
      let result;
      try { result = await api()?.taskWorkflow?.({ operation: "rollback", conversationId: record.conversationId, taskId: record.taskId, applicationId: record.applicationId }); } catch { result = null; }
      if (!valid(ticket)) return;
      setBusy(false);
      if (result?.ok && result.state === "rolled_back") {
        localRecoveries = localRecoveries.filter(row => row.applicationId !== record.applicationId); recoveryEntry.hidden = !localRecoveries.length;
      } else recoveryError = workflowError(result, "applyConflict");
      paintRecoveries();
    })); card.append(footer); list.append(card);
  }
  body.append(list);
}
function fitRecoverySurface() {
  if (phase() !== "localRecovery" || surface.hidden || recoveryRoot === root) return;
  const rect = recoveryRoot.getBoundingClientRect();
  Object.assign(surface.style, { position: "fixed", inset: "auto", top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` });
}
function openRecoveries() {
  update(); if (isDisposed() || recoveryEntry.hidden) return;
  if (!surface.hidden) close({ restoreFocus: false });
  setReturnFocus(document.activeElement);
  if (surface.parentElement !== recoveryRoot) recoveryRoot.append(surface);
  for (const el of recoveryRoot.children) if (el !== surface) { inertNodes.set(el, el.inert); el.inert = true; }
  surface.hidden = false; recoveryError = ""; paintRecoveries(); fitRecoverySurface(); surface.focus();
}

  return { clearRecoveries, refreshRecoveries, paintRecoveries, fitRecoverySurface, openRecoveries, recoveryEntry };
}
