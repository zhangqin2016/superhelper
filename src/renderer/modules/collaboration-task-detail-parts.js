/**
 * Two parts the task detail paints but does not own.
 *
 * The snapshot section is what a sender is consenting to send — the exact file
 * list, what was omitted and any warnings — so it is rendered from the draft it
 * is given and never from panel state. The confirmation footer is the step
 * between choosing an action and committing it, including the reason a
 * change request requires before its button becomes usable.
 *
 * Both read panel state through accessors rather than copies, so the footer
 * cannot disagree with the panel about whether it is busy.
 */
export function createTaskDetailParts({
  node, tr, button, confirming, setConfirming, reasonDraft, setReasonDraft, isBusy, selected, commit, repaint,
}) {
  function paintConfirmation(footer) {
    const action = confirming();
    footer.classList.add("is-confirming");
    footer.append(node("p", "remote-task-confirm-copy", tr(`confirm.${action}`, { number: selected().deliveries.at(-1)?.number || 1 })));
    let reason;
    const controls = node("div", "remote-task-controls");
    const submit = button("task-confirm", tr(`action.${action}`), () => void commit(action), true);
    if (action === "request_changes") {
      const label = node("label", "remote-task-field", tr("reason"));
      reason = node("textarea", "remote-task-reason"); reason.rows = 3; reason.maxLength = 4000; reason.value = reasonDraft(); reason.required = true;
      label.append(reason); footer.append(label);
      reason.disabled = isBusy(); submit.disabled = isBusy() || !reasonDraft().trim();
      reason.addEventListener("input", () => { setReasonDraft(reason.value); submit.disabled = !reasonDraft().trim() || isBusy(); });
    }
    controls.append(button("task-dismiss", tr("back"), () => { setConfirming(""); setReasonDraft(""); repaint(); }), submit); footer.append(controls);
  }

  function paintSnapshot(body, draft) {
    const section = node("section", "remote-task-section"); section.append(node("h4", "", tr("snapshot")), node("p", "remote-task-meta", tr("snapshotNote")));
    const files = node("ul", "remote-task-files");
    for (const file of draft.files || []) { const row = node("li", ""); row.append(node("span", "", file.path), node("span", "remote-task-meta", `${Number(file.sizeBytes) || 0} B`)); files.append(row); }
    section.append(files);
    if (draft.omitted) section.append(node("p", "remote-task-meta", tr("excluded", { count: draft.omitted })));
    for (const warning of draft.warnings || []) section.append(node("p", "remote-task-notice", warning));
    body.append(section);
  }

  return { paintConfirmation, paintSnapshot };
}
