import { t, getLocale, onLocaleChange } from "../i18n/index.js";

const tr = (key, params) => t(`collaboration.task.${key}`, params);
const workflowError = (result, fallback = "workflowFailed") => ({ COLLAB_TASK_DELIVERY_OMITTED: "deliveryOmitted", COLLAB_TASK_BUNDLE_CHANGED: "bundleChanged", COLLAB_TASK_APPLICATION_RECOVERY_REQUIRED: "recoveryRequired" }[result?.code] || fallback);
const node = (tag, className, text) => { const el = document.createElement(tag); el.className = className; if (text != null) el.textContent = text; return el; };
const date = value => new Intl.DateTimeFormat(getLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
function actions(task, userId) {
  if (userId === task.assigneeUserId) return task.state === "offered" ? ["accept", "decline"] : [];
  if (userId !== task.requesterUserId) return [];
  return task.state === "review" ? ["approve", "request_changes", "cancel"] : ["offered", "active", "changes_requested"].includes(task.state) ? ["cancel"] : [];
}

/** An on-demand surface inside the existing chat column. No new navigation
 * rail, no background list fetch on conversation switching, no optimistic
 * task state. Local filesystem actions belong to a separate main broker. */
export function initRemoteTasks({ root, header, recoveryHeader = header, recoveryRoot = root, api = () => window.assistantClient?.collaboration, getContext, resolveName = () => "" }) {
  if (!root || !header) return { update() {}, onChange() {}, invalidate() {}, destroy() {} };
  let disposed = false, generation = 0, contextKey = "", context = {}, selected = null, rows = [], pending = [], confirming = "", busy = false;
  let returnFocus = null, reasonDraft = "";
  let phase = "closed", statusView = null;
  let hasUpdate = false;
  let drafts = [], workflow = null;
  const applications = new Map();
  let localRecoveries = [], recoveryGeneration = 0, recoveryError = "";
  const inertNodes = new Map();
  const entry = node("button", "collaboration-icon-button remote-task-entry");
  entry.type = "button"; entry.dataset.action = "task-entry"; entry.hidden = true; entry.setAttribute("aria-expanded", "false");
  header.append(entry);
  const recoveryEntry = node("button", "collaboration-icon-button remote-task-entry");
  recoveryEntry.type = "button"; recoveryEntry.dataset.action = "task-local-recovery-entry"; recoveryEntry.hidden = true; recoveryHeader.append(recoveryEntry);
  const surface = node("section", "remote-tasks"); surface.hidden = true; surface.tabIndex = -1; surface.setAttribute("role", "region"); root.append(surface);
  function button(action, label, callback, primary = false) {
    const el = node("button", `remote-task-button${primary ? " is-primary" : ""}`, label);
    el.type = "button"; el.dataset.action = action; el.disabled = busy && action !== "task-back";
    const version = generation;
    el.addEventListener("click", () => { if (!disposed && !surface.hidden && surface.contains(el) && version === generation) callback(); });
    return el;
  }
  function close({ restoreFocus = true } = {}) {
    generation++; busy = false; selected = null; confirming = ""; rows = []; pending = []; reasonDraft = "";
    phase = "closed"; statusView = null; workflow = null; drafts = []; applications.clear();
    hasUpdate = false;
    surface.hidden = true; surface.removeAttribute("aria-busy"); surface.replaceChildren(); entry.setAttribute("aria-expanded", "false");
    for (const [el, value] of inertNodes) el.inert = value; inertNodes.clear();
    surface.removeAttribute("style");
    if (surface.parentElement !== root) root.append(surface);
    if (restoreFocus && returnFocus?.isConnected && !returnFocus.closest("[hidden]")) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }
  function shell(title, detail = false) {
    surface.replaceChildren(); surface.setAttribute("aria-label", tr(phase === "localRecovery" ? "localRecovery" : "entry")); surface.toggleAttribute("aria-busy", busy);
    const top = node("header", "remote-task-header");
    const back = button("task-back", "", () => detail ? void load() : close());
    back.classList.add("collaboration-icon-button");
    back.setAttribute("aria-label", detail || phase === "localRecovery" ? tr("back") : tr("close"));
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg"), path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) icon.setAttribute(key, value);
    path.setAttribute("d", detail ? "M15 18l-6-6 6-6" : "M18 6L6 18M6 6l12 12"); icon.append(path); back.append(icon); top.append(back);
    top.append(node("h2", "", title));
    surface.append(top);
    const body = node("div", "remote-task-content"); surface.append(body);
    return body;
  }
  function notice(body, key, retry) {
    const box = node("div", "remote-task-notice"); box.setAttribute("role", "status"); box.append(node("p", "", tr(key)));
    if (retry) box.append(button("task-refresh", tr("refresh"), retry));
    body.append(box);
  }
  function showStatus(key, { detail = false, retry } = {}) {
    phase = "status"; statusView = { key, detail, retry };
    notice(shell(tr(detail ? "details" : "entry"), detail), key, retry);
  }
  function paintUpdate(footer, task) {
    if (!footer || footer.querySelector(".remote-task-change-notice")) return;
    const update = node("div", "remote-task-change-notice"); update.setAttribute("role", "status");
    update.append(node("p", "remote-task-meta", tr("updated")), button("task-refresh", tr("refresh"), () => void openTask(task.id)));
    footer.prepend(update);
  }
  function paintList() {
    phase = "list"; selected = null; confirming = ""; statusView = null;
    const body = shell(tr("entry"));
    body.append(node("p", "remote-task-subtitle", tr("private")));
    if (api()?.taskWorkflow) {
      body.append(button("task-create", tr("create"), () => void createTask(), true));
      for (const draft of drafts.filter(item => !item.taskId && item.state !== "completed")) {
        const row = node("div", "remote-task-delivery"); row.append(node("strong", "", draft.input?.title || draft.name), button("task-resume", tr("resume"), () => void createTask(draft))); body.append(row);
      }
    }
    if (!rows.length) { notice(body, "empty"); return; }
    const list = node("div", "remote-task-list");
    for (const task of rows) {
      const card = node("article", "remote-task-card"); card.dataset.taskId = task.id;
      card.append(node("span", `remote-task-status is-${task.state}`, tr(`state.${task.state}`)), node("h3", "", task.title));
      card.append(node("p", "remote-task-meta", tr("assignee", { name: resolveName(task.assigneeUserId) || tr("person") })));
      const footer = node("div", "remote-task-card-footer");
      footer.append(node("time", "remote-task-meta", date(task.updatedAt)), button("task-open", tr("view"), () => void openTask(task.id)));
      card.append(footer); list.append(card);
    }
    body.append(list);
    if (rows.length === 50) notice(body, "recentLimit");
  }
  function paintDetail() {
    if (!selected) return;
    phase = "detail"; statusView = null;
    const task = selected, body = shell(tr("details"), true);
    const hero = node("div", "remote-task-hero");
    hero.append(node("span", `remote-task-status is-${task.state}`, tr(`state.${task.state}`)), node("h3", "", task.title));
    hero.append(node("p", "remote-task-meta", tr("participants", { requester: resolveName(task.requesterUserId) || tr("person"), assignee: resolveName(task.assigneeUserId) || tr("person") })));
    body.append(hero);
    for (const [label, value] of [["objective", task.objective], ["criteria", task.acceptanceCriteria], ["feedback", task.reason]]) {
      if (!value) continue;
      const section = node("section", "remote-task-section"); section.append(node("h4", "", tr(label)), node("p", "remote-task-prose", value)); body.append(section);
    }
    const deliveries = node("section", "remote-task-section"); deliveries.append(node("h4", "", tr("deliveries")));
    if (!task.deliveries.length) deliveries.append(node("p", "remote-task-meta", tr("noDelivery")));
    for (const delivery of [...task.deliveries].reverse()) {
      const row = node("div", "remote-task-delivery");
      row.append(node("strong", "", tr("version", { number: delivery.number })), node("time", "remote-task-meta", date(delivery.submittedAt)));
      if (delivery.id === task.acceptedDeliveryId) row.append(node("span", "remote-task-meta", tr("state.accepted")));
      if (api()?.taskWorkflow) row.append(button("task-delivery-open", tr("openDelivery"), () => void openWorkspace(task, delivery.id)));
      if (api()?.taskWorkflow && context.userId === task.requesterUserId && delivery.id === task.acceptedDeliveryId) row.append(button("task-preview", tr("previewApply"), () => void previewApplication(task, delivery.id)));
      deliveries.append(row);
    }
    body.append(deliveries);
    const application = applications.get(task.id);
    if (task.state === "accepted") notice(body, application?.state === "applied" ? "applied" : application?.state === "rolled_back" ? "rolledBack" : application ? "applicationRecovery" : "notApplied");
    if (application && !["rolled_back", "preview"].includes(application.state)) body.append(button("task-rollback", tr("rollback"), () => void rollbackApplication(task, application)));
    if (api()?.taskWorkflow && ["active", "changes_requested"].includes(task.state) && context.userId === task.assigneeUserId) {
      const controls = node("div", "remote-task-workspace-controls");
      controls.append(button("task-receive", tr("receive"), () => void receiveTask(task)), button("task-workspace-open", tr("openWorkspace"), () => void openWorkspace(task)), button("task-prepare-delivery", tr("prepareDelivery"), () => void prepareDelivery(task)));
      body.append(controls);
      for (const draft of drafts.filter(item => item.taskId === task.id && item.state !== "completed")) body.append(button("task-resume-delivery", tr("resumeDelivery"), () => { workflow = { kind: "delivery", task, draft, locked: !!draft.state && draft.state !== "prepared" }; paintWorkflow(); }));
    }
    const recovery = pending.find(command => command.taskId === task.id);
    const footer = node("footer", "remote-task-footer"); surface.append(footer);
    if (hasUpdate) paintUpdate(footer, task);
    if (recovery) {
      const text = node("p", "remote-task-meta", tr("confirming")); text.setAttribute("role", "status"); footer.append(text);
      footer.append(button("task-retry", tr("checkResult"), () => void commit(null, recovery.clientCommandId), true));
      return;
    }
    if (confirming) { paintConfirmation(footer); return; }
    for (const action of actions(task, context.userId)) footer.append(button(action, tr(`action.${action}`), () => {
      confirming = action; reasonDraft = ""; paintDetail(); surface.querySelector("textarea, [data-action=task-confirm]")?.focus();
    }, ["accept", "approve"].includes(action)));
    if (!footer.children.length) footer.append(node("p", "remote-task-meta", tr("waiting")));
  }
  function paintConfirmation(footer) {
    const action = confirming;
    footer.classList.add("is-confirming");
    footer.append(node("p", "remote-task-confirm-copy", tr(`confirm.${action}`, { number: selected.deliveries.at(-1)?.number || 1 })));
    let reason;
    const controls = node("div", "remote-task-controls");
    const submit = button("task-confirm", tr(`action.${action}`), () => void commit(action), true);
    if (action === "request_changes") {
      const label = node("label", "remote-task-field", tr("reason"));
      reason = node("textarea", "remote-task-reason"); reason.rows = 3; reason.maxLength = 4000; reason.value = reasonDraft; reason.required = true;
      label.append(reason); footer.append(label);
      reason.disabled = busy; submit.disabled = busy || !reasonDraft.trim();
      reason.addEventListener("input", () => { reasonDraft = reason.value; submit.disabled = !reasonDraft.trim() || busy; });
    }
    controls.append(button("task-dismiss", tr("back"), () => { confirming = ""; reasonDraft = ""; paintDetail(); }), submit); footer.append(controls);
  }
  function valid(ticket) { return !disposed && !surface.hidden && ticket === generation; }
  function restoreLocal(result) {
    drafts = result?.ok ? result.drafts || [] : [];
    applications.clear();
    for (const application of result?.ok ? result.applications || [] : []) applications.set(application.taskId, application);
  }
  async function runWorkflow(command) {
    if (busy) return null;
    const ticket = generation;
    busy = true; surface.setAttribute("aria-busy", "true");
    surface.querySelectorAll("button:not([data-action=task-back]), input, textarea, select").forEach(el => { el.disabled = true; });
    let result;
    try { result = await api()?.taskWorkflow?.({ ...command, conversationId: context.conversationId }); } catch { result = { ok: false }; }
    if (!valid(ticket)) return null;
    busy = false; surface.removeAttribute("aria-busy");
    return result || { ok: false };
  }
  async function createTask(draft = null) {
    const ticket = ++generation; busy = false; showStatus("loading", { detail: true });
    try {
      const result = await api()?.getConversationDetails?.(context.conversationId);
      if (!valid(ticket)) return;
      if (!result?.ok) { showStatus("loadFailed", { detail: true, retry: () => void createTask(draft) }); return; }
      const members = (result.members || []).filter(member => member.userId && member.userId !== context.userId);
      workflow = { kind: "create", draft, members, input: { assigneeUserId: members[0]?.userId || "", title: "", objective: "", acceptanceCriteria: "", ...draft?.input }, locked: !!draft?.input && draft.state !== "failed" };
      paintWorkflow();
    } catch { if (valid(ticket)) showStatus("loadFailed", { detail: true, retry: () => void createTask(draft) }); }
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
  function paintWorkflow() {
    if (!workflow) return;
    phase = "workflow"; statusView = null;
    const current = workflow, body = shell(tr(current.kind === "create" ? "create" : current.kind === "delivery" ? "prepareDelivery" : "previewApply"), true);
    if (current.error) notice(body, current.error);
    if (current.kind === "create") {
      const form = node("div", "remote-task-form");
      for (const [name, labelKey] of [["assigneeUserId", "recipient"], ["title", "title"], ["objective", "objective"], ["acceptanceCriteria", "criteria"]]) {
        const label = node("label", "remote-task-field", tr(labelKey));
        const field = node(name === "assigneeUserId" ? "select" : name === "title" ? "input" : "textarea", "remote-task-input"); field.name = name;
        if (name === "assigneeUserId") for (const member of current.members) { const option = node("option", "", member.displayName || member.lilyId || tr("person")); option.value = member.userId; field.append(option); }
        field.value = current.input[name]; field.disabled = busy || current.locked; field.required = true; if (name !== "assigneeUserId") field.maxLength = name === "title" ? 200 : 4000;
        field.addEventListener("input", () => { current.input[name] = field.value; const submit = surface.querySelector('[data-action="task-send"]'); if (submit) submit.disabled = !canSend(current); });
        label.append(field); form.append(label);
      }
      body.append(form);
      if (!current.draft) body.append(button("task-prepare", tr("chooseFolder"), async () => { const result = await runWorkflow({ operation: "prepare" }); if (!result) return; current.error = null; if (result.ok && result.draft) current.draft = result.draft; else if (!result.cancelled) current.error = workflowError(result); paintWorkflow(); }));
      else {
        paintSnapshot(body, current.draft);
        if (current.locked) notice(body, "confirming");
        const submit = button("task-send", tr(current.locked ? "checkResult" : "send"), () => void sendDraft(current), true); submit.disabled = !canSend(current); body.append(submit);
      }
    } else if (current.kind === "delivery") {
      paintSnapshot(body, current.draft);
      if (current.locked) notice(body, "confirming");
      body.append(button("task-submit-delivery", tr(current.locked ? "checkResult" : "submitDelivery"), async () => {
        current.locked = true;
        const result = await runWorkflow({ operation: "submitDelivery", taskId: current.task.id, draftId: current.draft.id }); if (!result) return;
        if (result.ok && result.state === "completed") { void openTask(current.task.id); return; }
        current.error = result.ok && result.state === "confirming" ? null : workflowError(result, "checkFailed"); paintWorkflow();
      }, true));
    } else {
      const plan = current.preview.plan;
      const entries = node("ul", "remote-task-files");
      for (const entry of plan.entries || []) { const row = node("li", ""); row.append(node("span", "", entry.path), node("span", "remote-task-meta", `${tr(`fileOperation.${entry.operation}`)} · ${tr(`fileStatus.${entry.status}`)}`)); entries.append(row); }
      body.append(entries);
      const deletions = plan.entries?.some(entry => entry.operation === "delete");
      const applicable = plan.canApply || (plan.entries?.length > 0 && plan.entries.every(entry => ["ready", "already_applied", "confirmation_required"].includes(entry.status)));
      const submit = button("task-apply", tr("apply"), async () => {
        const result = await runWorkflow({ operation: "apply", taskId: current.task.id, deliveryId: current.deliveryId, applicationId: current.preview.applicationId, expectedPlanHash: current.preview.planHash, confirmDeletions: !!current.confirmDeletions }); if (!result) return;
        if (result.ok && result.state === "applied") { applications.set(current.task.id, { ...current.preview, state: "applied" }); selected = current.task; paintDetail(); }
        else { current.error = workflowError(result, "applyConflict"); current.blocked = true; paintWorkflow(); }
      }, true);
      submit.disabled = busy || current.blocked || !applicable || (deletions && !current.confirmDeletions);
      if (deletions) { const label = node("label", "remote-task-deletion-consent"), checkbox = node("input", ""); checkbox.type = "checkbox"; checkbox.name = "confirmDeletions"; checkbox.checked = !!current.confirmDeletions; checkbox.addEventListener("change", () => { current.confirmDeletions = checkbox.checked; submit.disabled = busy || current.blocked || !applicable || !checkbox.checked; }); label.append(checkbox, node("span", "", tr("confirmDeletions"))); body.append(label); }
      if (!applicable) notice(body, "applyConflict");
      body.append(submit, button("task-delivery-open", tr("openDelivery"), () => void openWorkspace(current.task, current.deliveryId)));
    }
    const controls = node("div", "remote-task-workflow-actions");
    for (const child of [...body.children]) if (child.tagName === "BUTTON") controls.append(child);
    if (controls.children.length) body.append(controls);
  }
  function canSend(current) { return !busy && !!current.draft && Object.values(current.input).every(value => typeof value === "string" && value.trim()) && current.input.assigneeUserId !== context.userId && current.members.some(member => member.userId === current.input.assigneeUserId); }
  async function sendDraft(current) {
    if (!canSend(current)) return;
    current.locked = true;
    const result = await runWorkflow({ operation: "send", draftId: current.draft.id, ...current.input }); if (!result) return;
    if (result.ok && result.state === "completed") { if (result.taskId) void openTask(result.taskId); else void load(); return; }
    if (result.ok && result.state === "failed") current.locked = false;
    current.error = result.ok && result.state === "confirming" ? null : workflowError(result, result.state === "failed" ? "sendFailed" : "checkFailed"); paintWorkflow();
  }
  async function receiveTask(task) {
    const result = await runWorkflow({ operation: "receive", taskId: task.id }); if (!result) return;
    paintDetail(); notice(surface.querySelector(".remote-task-content"), result.ok && result.state === "ready" ? "workspaceReady" : workflowError(result));
  }
  async function prepareDelivery(task) {
    const result = await runWorkflow({ operation: "prepareDelivery", taskId: task.id }); if (!result) return;
    if (result.cancelled) { paintDetail(); return; }
    if (result.ok && result.draft) { workflow = { kind: "delivery", task, draft: result.draft, locked: false }; paintWorkflow(); }
    else { paintDetail(); notice(surface.querySelector(".remote-task-content"), workflowError(result)); }
  }
  async function previewApplication(task, deliveryId) {
    if (context.userId !== task.requesterUserId || deliveryId !== task.acceptedDeliveryId) return;
    const result = await runWorkflow({ operation: "preview", taskId: task.id, deliveryId }); if (!result) return;
    if (result.ok && result.applicationId && result.planHash && result.plan) { workflow = { kind: "apply", task, deliveryId, preview: result }; paintWorkflow(); }
    else { paintDetail(); notice(surface.querySelector(".remote-task-content"), workflowError(result)); }
  }
  async function rollbackApplication(task, application) {
    const result = await runWorkflow({ operation: "rollback", taskId: task.id, applicationId: application.applicationId }); if (!result) return;
    if (result.ok && result.state === "rolled_back") applications.set(task.id, { ...application, state: "rolled_back" });
    paintDetail(); if (!result.ok) notice(surface.querySelector(".remote-task-content"), "applyConflict");
  }
  async function openWorkspace(task, deliveryId) {
    const ticket = generation;
    const result = await runWorkflow({ operation: "open", taskId: task.id, ...(deliveryId ? { deliveryId } : {}) }); if (!result) return;
    if (!result.ok || !result.sessionId) { if (phase === "workflow") paintWorkflow(); else paintDetail(); notice(surface.querySelector(".remote-task-content"), "workflowFailed"); return; }
    try {
      if (window.assistantClient?.focusSession) {
        if (!valid(ticket)) return;
        const focused = await window.assistantClient.focusSession(result.sessionId);
        if (!valid(ticket)) return;
        if (!focused?.ok) throw new Error("focus failed");
        close({ restoreFocus: false }); return;
      }
      const { applySessionSwitch, refreshState } = await import("./session-chrome.js");
      if (!valid(ticket)) return;
      const switched = await window.assistantClient.switchSession(result.sessionId);
      if (!valid(ticket)) return;
      if (!switched?.ok) throw new Error("switch failed");
      close({ restoreFocus: false });
      await applySessionSwitch(switched, result.sessionId, result.projectId); await refreshState();
    } catch { if (valid(ticket)) { paintDetail(); notice(surface.querySelector(".remote-task-content"), "workflowFailed"); } }
  }
  async function load() {
    const ticket = ++generation; busy = false; confirming = ""; reasonDraft = "";
    selected = null; rows = []; pending = []; hasUpdate = false; showStatus("loading");
    try {
      const result = await api()?.listTasks?.(context.conversationId);
      if (!valid(ticket)) return;
      if (hasUpdate) { void load(); return; }
      if (result?.ok !== true) { showStatus("loadFailed", { retry: () => void load() }); return; }
      rows = result.tasks || [];
      if (api()?.taskWorkflow) { const recovery = await api().taskWorkflow({ operation: "drafts", conversationId: context.conversationId }); if (!valid(ticket)) return; restoreLocal(recovery); }
      paintList();
    } catch { if (valid(ticket)) showStatus("loadFailed", { retry: () => void load() }); }
  }
  async function openTask(taskId) {
    const ticket = ++generation; busy = false; confirming = ""; reasonDraft = "";
    selected = null; pending = []; hasUpdate = false; showStatus("loading", { detail: true });
    try {
      const [result, recovery, local] = await Promise.all([api()?.getTask?.({ conversationId: context.conversationId, taskId }), api()?.getTaskCommands?.(context.conversationId), api()?.taskWorkflow?.({ operation: "drafts", conversationId: context.conversationId })]);
      if (!valid(ticket)) return;
      if (hasUpdate) { void openTask(taskId); return; }
      if (result?.ok !== true || recovery?.ok !== true || result.task?.id !== taskId || result.task?.conversationId !== context.conversationId) {
        showStatus("loadFailed", { detail: true, retry: () => void openTask(taskId) }); return;
      }
      restoreLocal(local); selected = result.task; pending = recovery.commands || []; paintDetail(); surface.focus({ preventScroll: true });
    } catch { if (valid(ticket)) showStatus("loadFailed", { detail: true, retry: () => void openTask(taskId) }); }
  }
  async function commit(action, clientCommandId) {
    if (busy || !selected) return;
    busy = true;
    const ticket = generation, task = selected;
    surface.setAttribute("aria-busy", "true");
    surface.querySelectorAll(".remote-task-footer button, .remote-task-footer textarea").forEach(el => { el.disabled = true; });
    const input = { conversationId: context.conversationId, taskId: task.id, action, expectedRevision: task.revision,
      ...(["approve", "request_changes"].includes(action) ? { deliveryId: task.currentDeliveryId } : {}), ...(action === "request_changes" ? { reason: reasonDraft } : {}) };
    let result;
    try { result = await (clientCommandId ? api()?.retryTask?.(clientCommandId) : api()?.changeTask?.(input)); } catch { result = null; }
    if (!valid(ticket)) return;
    busy = false; surface.removeAttribute("aria-busy");
    if (result?.ok && result.state === "completed") { await openTask(task.id); return; }
    if (result?.ok && result.state === "confirming" && result.clientCommandId) {
      pending = [{ taskId: task.id, clientCommandId: result.clientCommandId }]; confirming = ""; paintDetail(); return;
    }
    // Do not offer a fresh submit after an unknown IPC result. The main journal
    // owns the original identity, so reload it before another decision.
    confirming = ""; selected = null;
    showStatus(result?.code?.includes("CONFLICT") ? "conflict" : "checkFailed", { detail: true, retry: () => void openTask(task.id) });
  }
  function clearRecoveries() {
    recoveryGeneration++; localRecoveries = []; recoveryError = ""; recoveryEntry.hidden = true;
  }
  async function refreshRecoveries() {
    const ticket = ++recoveryGeneration, userId = context.userId;
    if (!userId || !api()?.taskWorkflow) { localRecoveries = []; recoveryEntry.hidden = true; return; }
    let result;
    try { result = await api().taskWorkflow({ operation: "recoveries" }); } catch { result = null; }
    if (disposed || ticket !== recoveryGeneration || userId !== context.userId) return;
    localRecoveries = result?.ok ? (result.applications || []).filter(row => row.state !== "rolled_back") : [];
    recoveryEntry.hidden = !localRecoveries.length;
    if (phase === "localRecovery" && !busy) paintRecoveries();
  }
  function paintRecoveries() {
    phase = "localRecovery"; statusView = null;
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
        if (busy) return;
        const ticket = generation; busy = true; recoveryError = ""; paintRecoveries();
        let result;
        try { result = await api()?.taskWorkflow?.({ operation: "rollback", conversationId: record.conversationId, taskId: record.taskId, applicationId: record.applicationId }); } catch { result = null; }
        if (!valid(ticket)) return;
        busy = false;
        if (result?.ok && result.state === "rolled_back") {
          localRecoveries = localRecoveries.filter(row => row.applicationId !== record.applicationId); recoveryEntry.hidden = !localRecoveries.length;
        } else recoveryError = workflowError(result, "applyConflict");
        paintRecoveries();
      })); card.append(footer); list.append(card);
    }
    body.append(list);
  }
  function fitRecoverySurface() {
    if (phase !== "localRecovery" || surface.hidden || recoveryRoot === root) return;
    const rect = recoveryRoot.getBoundingClientRect();
    Object.assign(surface.style, { position: "fixed", inset: "auto", top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }
  function openRecoveries() {
    update(); if (disposed || recoveryEntry.hidden) return;
    if (!surface.hidden) close({ restoreFocus: false });
    returnFocus = document.activeElement;
    if (surface.parentElement !== recoveryRoot) recoveryRoot.append(surface);
    for (const el of recoveryRoot.children) if (el !== surface) { inertNodes.set(el, el.inert); el.inert = true; }
    surface.hidden = false; recoveryError = ""; paintRecoveries(); fitRecoverySurface(); surface.focus();
  }
  function update() {
    if (disposed) return;
    const next = getContext?.() || {};
    const key = JSON.stringify([next.enabled === true, next.conversationId || "", next.userId || ""]);
    if (key !== contextKey) { close({ restoreFocus: false }); clearRecoveries(); contextKey = key; context = next; void refreshRecoveries(); }
    entry.hidden = !(context.enabled && context.conversationId && context.userId);
    entry.textContent = tr("entry"); entry.title = tr("entry");
    recoveryEntry.textContent = tr("localRecovery"); recoveryEntry.title = tr("localRecovery");
  }
  const open = () => {
    update(); if (disposed || entry.hidden) return;
    if (!surface.hidden) { close(); return; }
    returnFocus = document.activeElement;
    for (const el of root.children) if (el !== surface) { inertNodes.set(el, el.inert); el.inert = true; }
    surface.hidden = false; entry.setAttribute("aria-expanded", "true"); surface.focus(); void load();
  };
  const keydown = event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === "Tab") {
      const focusable = [...surface.querySelectorAll("button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled)")];
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && [surface, first].includes(document.activeElement)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  entry.addEventListener("click", open); recoveryEntry.addEventListener("click", openRecoveries); surface.addEventListener("keydown", keydown);
  const recoveryResize = new ResizeObserver(fitRecoverySurface); recoveryResize.observe(recoveryRoot);
  const locale = onLocaleChange(() => {
    update(); if (surface.hidden) return;
    if (phase === "detail") paintDetail();
    else if (phase === "list") paintList();
    else if (phase === "status" && statusView) showStatus(statusView.key, statusView);
    else if (phase === "workflow") paintWorkflow();
    else if (phase === "localRecovery") paintRecoveries();
  });
  update();
  function onChange() {
    if (!disposed) void refreshRecoveries();
    if (disposed || surface.hidden || busy) return;
    hasUpdate = true;
    if (phase === "list") void load();
    else if (phase === "detail" && !confirming) void openTask(selected.id);
    else if (phase === "detail") paintUpdate(surface.querySelector(".remote-task-footer"), selected);
  }
  return { update, onChange, invalidate: () => { close({ restoreFocus: false }); clearRecoveries(); }, destroy() { close({ restoreFocus: false }); clearRecoveries(); disposed = true; recoveryResize.disconnect(); locale(); entry.removeEventListener("click", open); recoveryEntry.removeEventListener("click", openRecoveries); surface.removeEventListener("keydown", keydown); entry.remove(); recoveryEntry.remove(); surface.remove(); } };
}
